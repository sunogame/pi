import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { Container, type TUI } from "@earendil-works/pi-tui";
import type { AgentRuntimeSnapshot } from "../../core/agent-runtime-snapshot.ts";
import { parseSkillBlock } from "../../core/agent-session.ts";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { buildSessionContext, type SessionContext } from "../../core/session-manager.ts";
import type { TruncationResult } from "../../core/tools/truncate.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CustomMessageComponent } from "./components/custom-message.ts";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { getMarkdownTheme } from "./theme/theme.ts";

export interface RuntimeTranscriptViewOptions {
	tui: TUI;
	cwd: string;
	showImages?: boolean;
	imageWidthCells?: number;
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
	toolOutputExpanded?: boolean;
	getToolDefinition?: (toolName: string) => ToolDefinition | undefined;
	onPopulateHistory?: (text: string) => void;
}

export class RuntimeTranscriptView extends Container {
	private readonly tui: TUI;
	private cwd: string;
	private showImages: boolean;
	private imageWidthCells: number;
	private hideThinkingBlock: boolean;
	private hiddenThinkingLabel: string;
	private toolOutputExpanded: boolean;
	private getToolDefinition?: (toolName: string) => ToolDefinition | undefined;
	private onPopulateHistory?: (text: string) => void;
	private streamingComponent: AssistantMessageComponent | undefined;
	private streamingMessage: AssistantMessage | undefined;
	private pendingTools = new Map<string, ToolExecutionComponent>();

	constructor(options: RuntimeTranscriptViewOptions) {
		super();
		this.tui = options.tui;
		this.cwd = options.cwd;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.hideThinkingBlock = options.hideThinkingBlock ?? false;
		this.hiddenThinkingLabel = options.hiddenThinkingLabel ?? "Thinking...";
		this.toolOutputExpanded = options.toolOutputExpanded ?? false;
		this.getToolDefinition = options.getToolDefinition;
		this.onPopulateHistory = options.onPopulateHistory;
	}

	updateOptions(options: Partial<Omit<RuntimeTranscriptViewOptions, "tui">>): void {
		if (options.cwd !== undefined) this.cwd = options.cwd;
		if (options.showImages !== undefined) this.showImages = options.showImages;
		if (options.imageWidthCells !== undefined) this.imageWidthCells = options.imageWidthCells;
		if (options.hideThinkingBlock !== undefined) this.hideThinkingBlock = options.hideThinkingBlock;
		if (options.hiddenThinkingLabel !== undefined) this.hiddenThinkingLabel = options.hiddenThinkingLabel;
		if (options.toolOutputExpanded !== undefined) this.toolOutputExpanded = options.toolOutputExpanded;
		if (options.getToolDefinition !== undefined) this.getToolDefinition = options.getToolDefinition;
		if (options.onPopulateHistory !== undefined) this.onPopulateHistory = options.onPopulateHistory;
	}

	renderSnapshot(snapshot: AgentRuntimeSnapshot, options: { populateHistory?: boolean } = {}): void {
		this.clear();
		this.pendingTools.clear();
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.cwd = snapshot.agent.cwd;

		const context = buildSessionContext(snapshot.transcript.entries, snapshot.transcript.currentLeafId);
		this.renderSessionContext(context, {
			populateHistory: options.populateHistory,
			retryAttempt: snapshot.run.retryAttempt,
		});
		this.renderStreamingMessage(snapshot);
		this.renderActiveToolExecutions(snapshot);
		this.tui.requestRender();
	}

	handleMessageStart(message: AgentMessage): void {
		if (message.role === "custom") {
			this.addMessage(message);
		} else if (message.role === "user") {
			this.addMessage(message);
		} else if (message.role === "assistant") {
			this.streamingComponent = new AssistantMessageComponent(
				undefined,
				this.hideThinkingBlock,
				getMarkdownTheme(),
				this.hiddenThinkingLabel,
			);
			this.streamingMessage = message;
			this.addChild(this.streamingComponent);
			this.streamingComponent.updateContent(this.streamingMessage);
		}
		this.tui.requestRender();
	}

	handleMessageDelta(message: AgentMessage): void {
		if (!this.streamingComponent || message.role !== "assistant") {
			return;
		}
		this.streamingMessage = message;
		this.streamingComponent.updateContent(this.streamingMessage);

		for (const content of this.streamingMessage.content) {
			if (content.type !== "toolCall") {
				continue;
			}
			const existing = this.pendingTools.get(content.id);
			if (existing) {
				existing.updateArgs(content.arguments);
			} else {
				const component = this.createToolComponent(content.name, content.id, content.arguments);
				this.addChild(component);
				this.pendingTools.set(content.id, component);
			}
		}
		this.tui.requestRender();
	}

	handleMessageEnd(message: AgentMessage, retryAttempt: number): void {
		if (message.role !== "assistant" || !this.streamingComponent) {
			this.tui.requestRender();
			return;
		}
		this.streamingMessage = message;
		let errorMessage: string | undefined;
		if (this.streamingMessage.stopReason === "aborted") {
			errorMessage =
				retryAttempt > 0
					? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
					: "Operation aborted";
			this.streamingMessage.errorMessage = errorMessage;
		}
		this.streamingComponent.updateContent(this.streamingMessage);

		if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
			const message = errorMessage ?? this.streamingMessage.errorMessage ?? "Error";
			for (const component of this.pendingTools.values()) {
				component.updateResult({
					content: [{ type: "text", text: message }],
					isError: true,
				});
			}
			this.pendingTools.clear();
		} else {
			for (const component of this.pendingTools.values()) {
				component.setArgsComplete();
			}
		}
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.tui.requestRender();
	}

	handleToolStart(toolName: string, toolCallId: string, input: unknown): void {
		let component = this.pendingTools.get(toolCallId);
		if (!component) {
			component = this.createToolComponent(toolName, toolCallId, input);
			this.addChild(component);
			this.pendingTools.set(toolCallId, component);
		}
		component.markExecutionStarted();
		this.tui.requestRender();
	}

	handleToolUpdate(toolCallId: string, patch: { outputPreview?: string; isError?: boolean }): void {
		const component = this.pendingTools.get(toolCallId);
		if (!component || !patch.outputPreview) {
			return;
		}
		component.updateResult(
			{
				content: [{ type: "text", text: patch.outputPreview }],
				isError: patch.isError ?? false,
			},
			true,
		);
		this.tui.requestRender();
	}

	handleToolEnd(toolName: string, toolCallId: string, input: unknown, result: unknown, isError: boolean): void {
		let component = this.pendingTools.get(toolCallId);
		if (!component) {
			component = this.createToolComponent(toolName, toolCallId, input);
			this.addChild(component);
		}
		if (result !== undefined) {
			const rendered = result as {
				content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
				details?: unknown;
			};
			component.updateResult({
				content: rendered.content ?? [{ type: "text", text: JSON.stringify(result) }],
				details: rendered.details,
				isError,
			});
		}
		this.pendingTools.delete(toolCallId);
		this.tui.requestRender();
	}

	private renderSessionContext(
		sessionContext: SessionContext,
		options: { populateHistory?: boolean; retryAttempt: number },
	): void {
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();

		for (const message of sessionContext.messages) {
			if (message.role === "assistant") {
				this.addMessage(message);
				for (const content of message.content) {
					if (content.type !== "toolCall") {
						continue;
					}
					const component = this.createToolComponent(content.name, content.id, content.arguments);
					this.addChild(component);

					if (message.stopReason === "aborted" || message.stopReason === "error") {
						const errorMessage =
							message.stopReason === "aborted"
								? options.retryAttempt > 0
									? `Aborted after ${options.retryAttempt} retry attempt${options.retryAttempt > 1 ? "s" : ""}`
									: "Operation aborted"
								: message.errorMessage || "Error";
						component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
					} else {
						renderedPendingTools.set(content.id, component);
					}
				}
			} else if (message.role === "toolResult") {
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				this.addMessage(message, options);
			}
		}

		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
		}
	}

	private renderStreamingMessage(snapshot: AgentRuntimeSnapshot): void {
		const message = snapshot.run.streamingMessage;
		if (!message || message.role !== "assistant") {
			return;
		}
		this.streamingComponent = new AssistantMessageComponent(
			undefined,
			this.hideThinkingBlock,
			getMarkdownTheme(),
			this.hiddenThinkingLabel,
		);
		this.streamingMessage = message;
		this.addChild(this.streamingComponent);
		this.streamingComponent.updateContent(this.streamingMessage);
	}

	private renderActiveToolExecutions(snapshot: AgentRuntimeSnapshot): void {
		for (const tool of snapshot.run.activeToolExecutions) {
			let component = this.pendingTools.get(tool.toolCallId);
			if (!component) {
				component = this.createToolComponent(tool.toolName, tool.toolCallId, tool.input);
				this.addChild(component);
				this.pendingTools.set(tool.toolCallId, component);
			}
			component.markExecutionStarted();
			if (tool.outputPreview) {
				component.updateResult(
					{
						content: [{ type: "text", text: tool.outputPreview }],
						isError: tool.isError ?? false,
					},
					tool.status === "pending" || tool.status === "running",
				);
			}
		}
	}

	private addMessage(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const component = new CustomMessageComponent(message, undefined, getMarkdownTheme());
					component.setExpanded(this.toolOutputExpanded);
					this.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(message, getMarkdownTheme());
				component.setExpanded(this.toolOutputExpanded);
				this.addChild(component);
				break;
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(message, getMarkdownTheme());
				component.setExpanded(this.toolOutputExpanded);
				this.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (!textContent) {
					break;
				}
				const skillBlock = parseSkillBlock(textContent);
				if (skillBlock) {
					const component = new SkillInvocationMessageComponent(skillBlock, getMarkdownTheme());
					component.setExpanded(this.toolOutputExpanded);
					this.addChild(component);
					if (skillBlock.userMessage) {
						this.addChild(new UserMessageComponent(skillBlock.userMessage, getMarkdownTheme()));
					}
				} else {
					this.addChild(new UserMessageComponent(textContent, getMarkdownTheme()));
				}
				if (options?.populateHistory) {
					this.onPopulateHistory?.(textContent);
				}
				break;
			}
			case "assistant": {
				this.addChild(
					new AssistantMessageComponent(
						message,
						this.hideThinkingBlock,
						getMarkdownTheme(),
						this.hiddenThinkingLabel,
					),
				);
				break;
			}
			case "toolResult":
				break;
		}
	}

	private createToolComponent(toolName: string, toolCallId: string, input: unknown): ToolExecutionComponent {
		const component = new ToolExecutionComponent(
			toolName,
			toolCallId,
			input,
			{
				showImages: this.showImages,
				imageWidthCells: this.imageWidthCells,
			},
			this.getToolDefinition?.(toolName),
			this.tui,
			this.cwd,
		);
		component.setExpanded(this.toolOutputExpanded);
		return component;
	}

	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}
}
