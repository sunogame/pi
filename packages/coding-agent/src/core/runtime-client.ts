import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, Transport } from "@earendil-works/pi-ai";
import type { AgentRuntimeAttachResult, AgentRuntimeEvent, AgentRuntimeSnapshot } from "./agent-runtime-snapshot.ts";
import type { AgentSession, ExtensionBindings, ModelCycleResult, PromptOptions } from "./agent-session.ts";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import type { ToolDefinition } from "./extensions/index.ts";
import type { BranchSummaryEntry, SessionTreeNode } from "./session-manager.ts";

export type RuntimeQueueMode = "all" | "one-at-a-time";

export type RuntimeNewSessionOptions = Parameters<AgentSessionRuntime["newSession"]>[0];
export type RuntimeSwitchSessionOptions = Parameters<AgentSessionRuntime["switchSession"]>[1];
export type RuntimeForkOptions = Parameters<AgentSessionRuntime["fork"]>[1];
export type RuntimeNavigateTreeOptions = {
	summarize?: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
};
export type RuntimeNavigateTreeResult = {
	editorText?: string;
	cancelled: boolean;
	aborted?: boolean;
	summaryEntry?: BranchSummaryEntry;
};
export type RuntimeCompactionResult = Awaited<ReturnType<AgentSession["compact"]>>;
export type RuntimeBashResult = Awaited<ReturnType<AgentSession["executeBash"]>>;
export type RuntimeBashOptions = Parameters<AgentSession["executeBash"]>[2];
export type RuntimeSessionStats = ReturnType<AgentSession["getSessionStats"]>;
export type RuntimeForkableUserMessage = ReturnType<AgentSession["getUserMessagesForForking"]>[number];

export interface RuntimeClientAttachOptions {
	lastSeenEventId?: number;
	listener?: (event: AgentRuntimeEvent) => void;
}

export interface RuntimeClient {
	readonly store: AgentRuntimeStore;
	attach(options?: RuntimeClientAttachOptions): Promise<AgentRuntimeAttachResult>;
	detach(): void;
	bindUI(bindings: ExtensionBindings): Promise<void>;
	unbindUI(): Promise<void>;
	prompt(text: string, options?: PromptOptions): Promise<void>;
	abort(): Promise<void>;
	waitForIdle(): Promise<void>;
	newSession(options?: RuntimeNewSessionOptions): Promise<{ cancelled: boolean }>;
	switchSession(sessionPath: string, options?: RuntimeSwitchSessionOptions): Promise<{ cancelled: boolean }>;
	fork(entryId: string, options?: RuntimeForkOptions): Promise<{ cancelled: boolean; selectedText?: string }>;
	importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }>;
	setModel(model: Model<any>): Promise<void>;
	cycleModel(direction?: "forward" | "backward"): Promise<ModelCycleResult | undefined>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	cycleThinkingLevel(): Promise<ThinkingLevel | undefined>;
	getAvailableThinkingLevels(): Promise<ThinkingLevel[]>;
	setAutoCompactionEnabled(enabled: boolean): Promise<void>;
	setSteeringMode(mode: RuntimeQueueMode): Promise<void>;
	setFollowUpMode(mode: RuntimeQueueMode): Promise<void>;
	setTransport(transport: Transport): Promise<void>;
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): Promise<void>;
	getQueuedMessages(): Promise<{ steering: string[]; followUp: string[] }>;
	clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
	steer(text: string, images?: ImageContent[]): Promise<void>;
	followUp(text: string, images?: ImageContent[]): Promise<void>;
	compact(customInstructions?: string): Promise<RuntimeCompactionResult>;
	abortCompaction(): Promise<void>;
	abortRetry(): Promise<void>;
	abortBranchSummary(): Promise<void>;
	reload(): Promise<void>;
	exportToJsonl(outputPath?: string): Promise<string>;
	exportToHtml(outputPath?: string): Promise<string>;
	getLastAssistantText(): Promise<string | undefined>;
	setSessionName(name: string): Promise<void>;
	getSessionStats(): Promise<RuntimeSessionStats>;
	getUserMessagesForForking(): Promise<RuntimeForkableUserMessage[]>;
	abortBash(): Promise<void>;
	executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: RuntimeBashOptions,
	): Promise<RuntimeBashResult>;
	recordBashResult(
		command: string,
		result: RuntimeBashResult,
		options?: { excludeFromContext?: boolean },
	): Promise<void>;
	getSessionTree(): Promise<SessionTreeNode[]>;
	navigateTree(targetId: string, options?: RuntimeNavigateTreeOptions): Promise<RuntimeNavigateTreeResult>;
	getToolDefinition(name: string): Promise<ToolDefinition | undefined>;
	setLabel(entryId: string, label: string | undefined): Promise<void>;
}

export type AgentRuntimeStoreListener = (snapshot: AgentRuntimeSnapshot, event?: AgentRuntimeEvent) => void;

export class AgentRuntimeStore {
	private _snapshot: AgentRuntimeSnapshot;
	private _lastAppliedEventId: number;
	private readonly listeners = new Set<AgentRuntimeStoreListener>();

	constructor(snapshot: AgentRuntimeSnapshot) {
		this._snapshot = snapshot;
		this._lastAppliedEventId = snapshot.eventCursor;
	}

	get snapshot(): AgentRuntimeSnapshot {
		return this._snapshot;
	}

	get lastAppliedEventId(): number {
		return this._lastAppliedEventId;
	}

	replaceFrom(snapshot: AgentRuntimeSnapshot): void {
		this._snapshot = snapshot;
		this._lastAppliedEventId = snapshot.eventCursor;
		this.notify();
	}

	apply(event: AgentRuntimeEvent): boolean {
		if (event.id <= this._lastAppliedEventId) {
			return false;
		}

		this._lastAppliedEventId = event.id;
		this._snapshot = applyRuntimeEvent(this._snapshot, event);
		this.notify(event);
		return true;
	}

	subscribe(listener: AgentRuntimeStoreListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notify(event?: AgentRuntimeEvent): void {
		for (const listener of this.listeners) {
			listener(this._snapshot, event);
		}
	}
}

export class InProcessRuntimeClient implements RuntimeClient {
	readonly store: AgentRuntimeStore;
	private readonly runtime: AgentSessionRuntime;
	private unsubscribeAttach?: () => void;

	constructor(runtime: AgentSessionRuntime) {
		this.runtime = runtime;
		this.store = new AgentRuntimeStore(runtime.getSnapshot());
	}

	async attach(options: RuntimeClientAttachOptions = {}): Promise<AgentRuntimeAttachResult> {
		this.detach();

		const inbox: AgentRuntimeEvent[] = [];
		let attached = false;
		const applyLiveEvent = (event: AgentRuntimeEvent) => {
			this.store.apply(event);
			if (event.type === "transcript_changed") {
				this.refreshFromRuntime();
			}
			options.listener?.(event);
		};
		const lastSeenEventId = options.lastSeenEventId ?? this.store.lastAppliedEventId;
		const result = this.runtime.attachRuntime({
			lastSeenEventId,
			listener: (event) => {
				if (attached) {
					applyLiveEvent(event);
				} else {
					inbox.push(event);
				}
			},
		});

		const replayRequiresSnapshot = result.initialEvents.some((event) => event.type === "transcript_changed");
		if (!result.initialEventsComplete || options.lastSeenEventId === undefined || replayRequiresSnapshot) {
			this.store.replaceFrom(result.snapshot);
		} else {
			for (const event of result.initialEvents) {
				this.store.apply(event);
			}
		}

		for (const event of inbox) {
			this.store.apply(event);
			if (event.type === "transcript_changed") {
				this.refreshFromRuntime();
			}
			options.listener?.(event);
		}
		inbox.length = 0;
		attached = true;

		this.unsubscribeAttach = result.unsubscribe;
		return {
			...result,
			unsubscribe: () => this.detach(),
		};
	}

	detach(): void {
		this.unsubscribeAttach?.();
		this.unsubscribeAttach = undefined;
	}

	async bindUI(bindings: ExtensionBindings): Promise<void> {
		await this.runtime.session.bindExtensions({
			...bindings,
			emitExtensionEvent: (namespace, payload) => this.runtime.emitExtensionRuntimeEvent(namespace, payload),
		});
		this.refreshFromRuntime();
	}

	async unbindUI(): Promise<void> {
		this.runtime.session.unbindExtensions();
		this.refreshFromRuntime();
	}

	async prompt(text: string, options?: PromptOptions): Promise<void> {
		await this.runtime.session.prompt(text, options);
		this.refreshFromRuntime();
	}

	async abort(): Promise<void> {
		await this.runtime.session.abort();
		this.refreshFromRuntime();
	}

	async waitForIdle(): Promise<void> {
		await this.runtime.session.agent.waitForIdle();
	}

	async newSession(options?: RuntimeNewSessionOptions): Promise<{ cancelled: boolean }> {
		const result = await this.runtime.newSession(options);
		this.refreshFromRuntime();
		return result;
	}

	async switchSession(sessionPath: string, options?: RuntimeSwitchSessionOptions): Promise<{ cancelled: boolean }> {
		const result = await this.runtime.switchSession(sessionPath, options);
		this.refreshFromRuntime();
		return result;
	}

	async fork(entryId: string, options?: RuntimeForkOptions): Promise<{ cancelled: boolean; selectedText?: string }> {
		const result = await this.runtime.fork(entryId, options);
		this.refreshFromRuntime();
		return result;
	}

	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const result = await this.runtime.importFromJsonl(inputPath, cwdOverride);
		this.refreshFromRuntime();
		return result;
	}

	async setModel(model: Model<any>): Promise<void> {
		await this.runtime.session.setModel(model);
		this.refreshFromRuntime();
	}

	async cycleModel(direction?: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const result = await this.runtime.session.cycleModel(direction);
		this.refreshFromRuntime();
		return result;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.runtime.session.setThinkingLevel(level);
		this.refreshFromRuntime();
	}

	async cycleThinkingLevel(): Promise<ThinkingLevel | undefined> {
		const result = this.runtime.session.cycleThinkingLevel();
		this.refreshFromRuntime();
		return result;
	}

	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		return this.runtime.session.getAvailableThinkingLevels();
	}

	async setAutoCompactionEnabled(enabled: boolean): Promise<void> {
		this.runtime.session.setAutoCompactionEnabled(enabled);
		this.refreshFromRuntime();
	}

	async setSteeringMode(mode: RuntimeQueueMode): Promise<void> {
		this.runtime.session.setSteeringMode(mode);
		this.refreshFromRuntime();
	}

	async setFollowUpMode(mode: RuntimeQueueMode): Promise<void> {
		this.runtime.session.setFollowUpMode(mode);
		this.refreshFromRuntime();
	}

	async setTransport(transport: Transport): Promise<void> {
		this.runtime.session.setTransport(transport);
		this.refreshFromRuntime();
	}

	async setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): Promise<void> {
		this.runtime.session.setScopedModels(scopedModels);
		this.refreshFromRuntime();
	}

	async getQueuedMessages(): Promise<{ steering: string[]; followUp: string[] }> {
		return {
			steering: [...this.runtime.session.getSteeringMessages()],
			followUp: [...this.runtime.session.getFollowUpMessages()],
		};
	}

	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		const result = this.runtime.session.clearQueue();
		this.refreshFromRuntime();
		return result;
	}

	async steer(text: string, images?: ImageContent[]): Promise<void> {
		await this.runtime.session.steer(text, images);
		this.refreshFromRuntime();
	}

	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		await this.runtime.session.followUp(text, images);
		this.refreshFromRuntime();
	}

	async compact(customInstructions?: string): Promise<RuntimeCompactionResult> {
		try {
			return await this.runtime.session.compact(customInstructions);
		} finally {
			this.refreshFromRuntime();
		}
	}

	async abortCompaction(): Promise<void> {
		this.runtime.session.abortCompaction();
		this.refreshFromRuntime();
	}

	async abortRetry(): Promise<void> {
		this.runtime.session.abortRetry();
		this.refreshFromRuntime();
	}

	async abortBranchSummary(): Promise<void> {
		this.runtime.session.abortBranchSummary();
		this.refreshFromRuntime();
	}

	async reload(): Promise<void> {
		try {
			await this.runtime.session.reload();
		} finally {
			this.refreshFromRuntime();
		}
	}

	async exportToJsonl(outputPath?: string): Promise<string> {
		return this.runtime.session.exportToJsonl(outputPath);
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		return this.runtime.session.exportToHtml(outputPath);
	}

	async getLastAssistantText(): Promise<string | undefined> {
		return this.runtime.session.getLastAssistantText();
	}

	async setSessionName(name: string): Promise<void> {
		this.runtime.session.setSessionName(name);
		this.refreshFromRuntime();
	}

	async getSessionStats(): Promise<RuntimeSessionStats> {
		return this.runtime.session.getSessionStats();
	}

	async getUserMessagesForForking(): Promise<RuntimeForkableUserMessage[]> {
		return this.runtime.session.getUserMessagesForForking();
	}

	async abortBash(): Promise<void> {
		this.runtime.session.abortBash();
		this.refreshFromRuntime();
	}

	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: RuntimeBashOptions,
	): Promise<RuntimeBashResult> {
		const bashResult = this.runtime.session.executeBash(command, onChunk, options);
		this.refreshFromRuntime();
		try {
			return await bashResult;
		} finally {
			this.refreshFromRuntime();
		}
	}

	async recordBashResult(
		command: string,
		result: RuntimeBashResult,
		options?: { excludeFromContext?: boolean },
	): Promise<void> {
		// TODO(runtime-ipc): fold this into executeBash before crossing a process boundary.
		this.runtime.session.recordBashResult(command, result, options);
		this.refreshFromRuntime();
	}

	async getSessionTree(): Promise<SessionTreeNode[]> {
		return this.runtime.session.sessionManager.getTree();
	}

	async navigateTree(targetId: string, options?: RuntimeNavigateTreeOptions): Promise<RuntimeNavigateTreeResult> {
		const result = await this.runtime.session.navigateTree(targetId, options);
		this.refreshFromRuntime();
		return result;
	}

	async getToolDefinition(name: string): Promise<ToolDefinition | undefined> {
		return this.runtime.session.getToolDefinition(name);
	}

	async setLabel(entryId: string, label: string | undefined): Promise<void> {
		this.runtime.session.sessionManager.appendLabelChange(entryId, label);
		this.refreshFromRuntime();
	}

	private refreshFromRuntime(): void {
		this.store.replaceFrom(this.runtime.getSnapshot());
	}
}

export function createInProcessRuntimeClient(runtime: AgentSessionRuntime): InProcessRuntimeClient {
	return new InProcessRuntimeClient(runtime);
}

function applyRuntimeEvent(snapshot: AgentRuntimeSnapshot, event: AgentRuntimeEvent): AgentRuntimeSnapshot {
	const next: AgentRuntimeSnapshot = {
		...snapshot,
		eventCursor: event.id,
	};

	switch (event.type) {
		case "status_changed":
			return {
				...next,
				agent: { ...next.agent, status: event.status },
				run: {
					...next.run,
					isStreaming: event.status === "idle" ? false : next.run.isStreaming,
					isBashRunning: next.run.isBashRunning,
					streamingMessage: event.status === "idle" ? undefined : next.run.streamingMessage,
				},
			};
		case "session_changed":
			return { ...next, session: event.session };
		case "message_start":
		case "message_delta":
			return {
				...next,
				run: messageRunSnapshot(next.run, event.message),
			};
		case "message_end":
			return {
				...next,
				run: endMessageRunSnapshot(next.run, event.message),
			};
		case "tool_start":
			return {
				...next,
				run: {
					...next.run,
					activeToolExecutions: upsertByToolCallId(next.run.activeToolExecutions, event.tool),
				},
			};
		case "tool_update":
			return {
				...next,
				run: {
					...next.run,
					activeToolExecutions: next.run.activeToolExecutions.map((tool) =>
						tool.toolCallId === event.toolCallId ? { ...tool, ...event.patch } : tool,
					),
				},
			};
		case "tool_end":
			return {
				...next,
				run: {
					...next.run,
					activeToolExecutions: next.run.activeToolExecutions.filter(
						(tool) => tool.toolCallId !== event.tool.toolCallId,
					),
				},
			};
		case "queue_changed":
			return { ...next, run: { ...next.run, pendingUserMessages: event.pendingUserMessages } };
		case "approval_requested":
			return {
				...next,
				run: {
					...next.run,
					pendingApprovals: upsertByApprovalId(next.run.pendingApprovals, event.approval),
				},
			};
		case "approval_resolved":
			return {
				...next,
				run: {
					...next.run,
					pendingApprovals: next.run.pendingApprovals.filter(
						(approval) => approval.approvalId !== event.approvalId,
					),
				},
			};
		case "input_required":
			return { ...next, run: { ...next.run, inputRequired: event.input } };
		case "input_resolved":
			return {
				...next,
				run:
					next.run.inputRequired?.inputId === event.inputId ? { ...next.run, inputRequired: undefined } : next.run,
			};
		case "compaction_start":
			return { ...next, agent: { ...next.agent, status: "compacting" } };
		case "error":
			return { ...next, agent: { ...next.agent, status: "error" }, run: { ...next.run, lastError: event.message } };
		case "compaction_end":
			return { ...next, agent: { ...next.agent, status: event.willRetry ? "running" : next.agent.status } };
		case "auto_retry_start":
			return {
				...next,
				agent: { ...next.agent, status: "retrying" },
				run: { ...next.run, retryAttempt: event.attempt },
			};
		case "auto_retry_end":
			return {
				...next,
				run: {
					...next.run,
					retryAttempt: event.success ? 0 : event.attempt,
					lastError: event.finalError ?? next.run.lastError,
				},
			};
		case "extension_event":
		case "transcript_changed":
			return next;
	}
}

function messageRunSnapshot(run: AgentRuntimeSnapshot["run"], message: AgentMessage): AgentRuntimeSnapshot["run"] {
	if (message.role !== "assistant") {
		return run;
	}
	return {
		...run,
		isStreaming: true,
		streamingMessage: message,
	};
}

function endMessageRunSnapshot(run: AgentRuntimeSnapshot["run"], message: AgentMessage): AgentRuntimeSnapshot["run"] {
	if (message.role !== "assistant") {
		return run;
	}
	return {
		...run,
		isStreaming: false,
		streamingMessage: undefined,
	};
}

function upsertByToolCallId<T extends { toolCallId: string }>(items: T[], item: T): T[] {
	const index = items.findIndex((candidate) => candidate.toolCallId === item.toolCallId);
	if (index === -1) {
		return [...items, item];
	}
	return items.map((candidate, candidateIndex) => (candidateIndex === index ? item : candidate));
}

function upsertByApprovalId<T extends { approvalId: string }>(items: T[], item: T): T[] {
	const index = items.findIndex((candidate) => candidate.approvalId === item.approvalId);
	if (index === -1) {
		return [...items, item];
	}
	return items.map((candidate, candidateIndex) => (candidateIndex === index ? item : candidate));
}
