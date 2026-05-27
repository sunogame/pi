import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";
import type { ToolInfo } from "./extensions/index.ts";
import type { SessionEntry } from "./session-manager.ts";

export type AgentRuntimeStatus = "idle" | "running" | "waiting_input" | "compacting" | "error";

export interface AgentRuntimeModelSnapshot {
	provider?: string;
	modelId?: string;
	displayName?: string;
}

export interface AgentIdentitySnapshot {
	agentId: string;
	name?: string;
	cwd: string;
	model: AgentRuntimeModelSnapshot;
	thinkingLevel: ThinkingLevel;
	status: AgentRuntimeStatus;
}

export interface SessionSnapshot {
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	sessionDir: string;
	parentSession?: string;
	currentLeafId: string | null;
	createdAt?: string;
}

export interface TranscriptSnapshot {
	entries: SessionEntry[];
	currentLeafId: string | null;
}

export interface PendingUserMessageSnapshot {
	kind: "steering" | "follow_up";
	text: string;
}

export type ToolExecutionStatus = "pending" | "running" | "completed" | "error" | "aborted";

export interface ToolExecutionSnapshot {
	toolCallId: string;
	toolName: string;
	input?: unknown;
	status: ToolExecutionStatus;
	outputPreview?: string;
	result?: unknown;
	isError?: boolean;
}

export interface RunSnapshot {
	runId?: string;
	isStreaming: boolean;
	retryAttempt: number;
	pendingUserMessages: PendingUserMessageSnapshot[];
	activeToolExecutions: ToolExecutionSnapshot[];
}

export interface ToolsSnapshot {
	active: string[];
	available: ToolInfo[];
}

export interface AgentRuntimeSnapshot {
	protocolVersion: 1;
	agent: AgentIdentitySnapshot;
	session: SessionSnapshot;
	transcript: TranscriptSnapshot;
	run: RunSnapshot;
	tools: ToolsSnapshot;
}

export type AgentRuntimeEvent =
	| { id: number; type: "status_changed"; status: AgentRuntimeStatus }
	| { id: number; type: "session_changed"; session: SessionSnapshot }
	| { id: number; type: "message_start"; message: AgentMessage }
	| { id: number; type: "message_delta"; message: AgentMessage }
	| { id: number; type: "message_end"; message: AgentMessage }
	| { id: number; type: "tool_start"; tool: ToolExecutionSnapshot }
	| { id: number; type: "tool_update"; toolCallId: string; patch: Partial<ToolExecutionSnapshot> }
	| { id: number; type: "tool_end"; tool: ToolExecutionSnapshot }
	| { id: number; type: "queue_changed"; pendingUserMessages: PendingUserMessageSnapshot[] }
	| { id: number; type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { id: number; type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; aborted: boolean }
	| { id: number; type: "error"; message: string };

export type AgentRuntimeEventListener = (event: AgentRuntimeEvent) => void;
type AgentRuntimeEventDraft = AgentRuntimeEvent extends infer T
	? T extends { id: number }
		? Omit<T, "id">
		: never
	: never;

function modelSnapshot(model: Model<any> | undefined): AgentRuntimeModelSnapshot {
	const candidate = (model ?? {}) as {
		provider?: string;
		modelId?: string;
		id?: string;
		name?: string;
		displayName?: string;
	};
	return {
		provider: candidate.provider,
		modelId: candidate.modelId ?? candidate.id,
		displayName: candidate.displayName ?? candidate.name ?? candidate.modelId ?? candidate.id,
	};
}

function pendingUserMessages(session: AgentSession): PendingUserMessageSnapshot[] {
	return [
		...session.getSteeringMessages().map((text) => ({ kind: "steering" as const, text })),
		...session.getFollowUpMessages().map((text) => ({ kind: "follow_up" as const, text })),
	];
}

function statusFromSession(session: AgentSession): AgentRuntimeStatus {
	if (session.isCompacting) {
		return "compacting";
	}
	if (session.isStreaming) {
		return "running";
	}
	return "idle";
}

function sessionSnapshot(session: AgentSession): SessionSnapshot {
	const header = session.sessionManager.getHeader();
	return {
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		sessionDir: session.sessionManager.getSessionDir(),
		parentSession: header?.parentSession,
		currentLeafId: session.sessionManager.getLeafId(),
		createdAt: header?.timestamp,
	};
}

export class AgentRuntimeSnapshotProjector {
	private readonly listeners = new Set<AgentRuntimeEventListener>();
	private readonly activeToolExecutions = new Map<string, ToolExecutionSnapshot>();
	private status: AgentRuntimeStatus;
	private nextEventId = 1;
	private unsubscribe?: () => void;

	private session: AgentSession;

	constructor(session: AgentSession) {
		this.session = session;
		this.status = statusFromSession(session);
		this.subscribeToSession(session);
	}

	replaceSession(session: AgentSession): void {
		const previousStatus = this.status;
		this.unsubscribe?.();
		this.activeToolExecutions.clear();
		this.session = session;
		this.status = statusFromSession(session);
		this.subscribeToSession(session);
		this.emit({ type: "session_changed", session: sessionSnapshot(session) });
		if (previousStatus !== this.status) {
			this.emit({ type: "status_changed", status: this.status });
		}
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.listeners.clear();
		this.activeToolExecutions.clear();
	}

	subscribe(listener: AgentRuntimeEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getSnapshot(): AgentRuntimeSnapshot {
		const session = this.session;
		return {
			protocolVersion: 1,
			agent: {
				agentId: session.sessionId,
				name: session.sessionName,
				cwd: session.sessionManager.getCwd(),
				model: modelSnapshot(session.model),
				thinkingLevel: session.thinkingLevel,
				status: this.status,
			},
			session: sessionSnapshot(session),
			transcript: {
				entries: session.sessionManager.getEntries(),
				currentLeafId: session.sessionManager.getLeafId(),
			},
			run: {
				isStreaming: session.isStreaming,
				retryAttempt: session.retryAttempt,
				pendingUserMessages: pendingUserMessages(session),
				activeToolExecutions: Array.from(this.activeToolExecutions.values()).filter(
					(tool) => tool.status === "pending" || tool.status === "running",
				),
			},
			tools: {
				active: session.getActiveToolNames(),
				available: session.getAllTools(),
			},
		};
	}

	private subscribeToSession(session: AgentSession): void {
		this.unsubscribe = session.subscribe((event) => this.handleSessionEvent(event));
	}

	private handleSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.emitStatusIfChanged("running");
				break;
			case "agent_end":
				this.emitStatusIfChanged(this.session.isCompacting ? "compacting" : "idle");
				break;
			case "message_start":
				this.emit({ type: "message_start", message: event.message });
				break;
			case "message_update":
				this.emit({ type: "message_delta", message: event.message });
				break;
			case "message_end":
				this.emit({ type: "message_end", message: event.message });
				break;
			case "tool_execution_start": {
				const tool: ToolExecutionSnapshot = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					input: event.args,
					status: "running",
				};
				this.activeToolExecutions.set(event.toolCallId, tool);
				this.emit({ type: "tool_start", tool });
				break;
			}
			case "tool_execution_update": {
				const current = this.activeToolExecutions.get(event.toolCallId);
				const patch: Partial<ToolExecutionSnapshot> = {
					outputPreview:
						typeof event.partialResult === "string" ? event.partialResult : JSON.stringify(event.partialResult),
					status: "running",
				};
				this.activeToolExecutions.set(event.toolCallId, {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					...current,
					...patch,
					status: "running",
				});
				this.emit({ type: "tool_update", toolCallId: event.toolCallId, patch });
				break;
			}
			case "tool_execution_end": {
				const current = this.activeToolExecutions.get(event.toolCallId);
				const tool: ToolExecutionSnapshot = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					...current,
					result: event.result,
					isError: event.isError,
					status: event.isError ? "error" : "completed",
				};
				this.activeToolExecutions.set(event.toolCallId, tool);
				this.emit({ type: "tool_end", tool });
				break;
			}
			case "queue_update":
				this.emit({ type: "queue_changed", pendingUserMessages: pendingUserMessages(this.session) });
				break;
			case "compaction_start":
				this.emitStatusIfChanged("compacting");
				this.emit({ type: "compaction_start", reason: event.reason });
				break;
			case "compaction_end":
				this.emit({ type: "compaction_end", reason: event.reason, aborted: event.aborted });
				this.emitStatusIfChanged(statusFromSession(this.session));
				break;
			case "session_info_changed":
			case "thinking_level_changed":
				this.emit({ type: "session_changed", session: sessionSnapshot(this.session) });
				break;
			case "auto_retry_start":
				this.emitStatusIfChanged("running");
				break;
			case "auto_retry_end":
				if (!event.success && event.finalError) {
					this.emit({ type: "error", message: event.finalError });
				}
				this.emitStatusIfChanged(statusFromSession(this.session));
				break;
		}
	}

	private emitStatusIfChanged(status: AgentRuntimeStatus): void {
		if (this.status === status) {
			return;
		}
		this.status = status;
		this.emit({ type: "status_changed", status });
	}

	private emit(event: AgentRuntimeEventDraft): void {
		const withId = { id: this.nextEventId++, ...event } as AgentRuntimeEvent;
		for (const listener of this.listeners) {
			listener(withId);
		}
	}
}
