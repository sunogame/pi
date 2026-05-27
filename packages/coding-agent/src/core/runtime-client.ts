import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentRuntimeAttachResult, AgentRuntimeEvent, AgentRuntimeSnapshot } from "./agent-runtime-snapshot.ts";
import type { ExtensionBindings, ModelCycleResult, PromptOptions } from "./agent-session.ts";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";

export type RuntimeQueueMode = "all" | "one-at-a-time";

export type RuntimeNewSessionOptions = Parameters<AgentSessionRuntime["newSession"]>[0];
export type RuntimeSwitchSessionOptions = Parameters<AgentSessionRuntime["switchSession"]>[1];
export type RuntimeForkOptions = Parameters<AgentSessionRuntime["fork"]>[1];

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
	setSteeringMode(mode: RuntimeQueueMode): Promise<void>;
	setFollowUpMode(mode: RuntimeQueueMode): Promise<void>;
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
		await this.runtime.session.bindExtensions(bindings);
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
		this.refreshFromRuntime();
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

	async setSteeringMode(mode: RuntimeQueueMode): Promise<void> {
		this.runtime.session.setSteeringMode(mode);
		this.refreshFromRuntime();
	}

	async setFollowUpMode(mode: RuntimeQueueMode): Promise<void> {
		this.runtime.session.setFollowUpMode(mode);
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
