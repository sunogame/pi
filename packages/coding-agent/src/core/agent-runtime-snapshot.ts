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

export interface AgentRuntimeIdentity {
	agentId: string;
	agentLabel?: string;
}

export type AgentRuntimeCapability = "event_replay" | "extension_events" | "input_required" | "approval" | string;

export interface AgentIdentitySnapshot {
	agentId: string;
	agentLabel?: string;
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

export interface PendingApprovalSnapshot {
	approvalId: string;
	toolCallId?: string;
	toolName?: string;
	title?: string;
	message: string;
	details?: unknown;
}

export interface InputRequiredSnapshot {
	inputId: string;
	question: string;
	details?: unknown;
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
	streamingMessage?: AgentMessage;
	retryAttempt: number;
	lastError?: string;
	pendingUserMessages: PendingUserMessageSnapshot[];
	pendingApprovals: PendingApprovalSnapshot[];
	inputRequired?: InputRequiredSnapshot;
	activeToolExecutions: ToolExecutionSnapshot[];
}

export interface ToolsSnapshot {
	active: string[];
	available: ToolInfo[];
}

export interface RuntimeResourceSnapshot {
	skills: Array<{ name: string; description: string; filePath: string; disableModelInvocation: boolean }>;
	promptTemplates: Array<{ name: string; description: string; argumentHint?: string; filePath: string }>;
	themes: Array<{ name?: string; sourcePath?: string }>;
	extensions: Array<{ path: string; resolvedPath: string }>;
	agentsFiles: Array<{ path: string }>;
}

export interface RuntimeModelRegistrySnapshot {
	available: AgentRuntimeModelSnapshot[];
	error?: string;
}

export interface RuntimeDiagnosticSnapshot {
	resources: Array<{ type: "warning" | "error" | "collision"; message: string; path?: string }>;
	extensions: Array<{ path: string; error: string }>;
}

export interface RuntimeConfigSnapshot {
	autoCompaction: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	scopedModels: Array<{ model: AgentRuntimeModelSnapshot; thinkingLevel?: ThinkingLevel }>;
}

export interface AgentRuntimeSnapshot {
	protocolVersion: 1;
	capabilities: AgentRuntimeCapability[];
	eventCursor: number;
	agent: AgentIdentitySnapshot;
	session: SessionSnapshot;
	transcript: TranscriptSnapshot;
	run: RunSnapshot;
	tools: ToolsSnapshot;
	resources: RuntimeResourceSnapshot;
	modelRegistry: RuntimeModelRegistrySnapshot;
	diagnostics: RuntimeDiagnosticSnapshot;
	config: RuntimeConfigSnapshot;
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
	| { id: number; type: "approval_requested"; approval: PendingApprovalSnapshot }
	| { id: number; type: "approval_resolved"; approvalId: string }
	| { id: number; type: "input_required"; input: InputRequiredSnapshot }
	| { id: number; type: "input_resolved"; inputId: string }
	| { id: number; type: "extension_event"; namespace: string; payload: unknown }
	| { id: number; type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { id: number; type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; aborted: boolean }
	| { id: number; type: "transcript_changed"; reason: "append" | "compaction" | "fork" | "import" }
	| { id: number; type: "error"; message: string };

export type AgentRuntimeEventListener = (event: AgentRuntimeEvent) => void;
export interface AgentRuntimeAttachOptions {
	lastSeenEventId?: number;
	listener?: AgentRuntimeEventListener;
}

export interface AgentRuntimeAttachResult {
	snapshot: AgentRuntimeSnapshot;
	initialEvents: AgentRuntimeEvent[];
	initialEventsComplete: boolean;
	unsubscribe: () => void;
}

export interface AgentRuntimeSnapshotProjectorOptions {
	identity?: Partial<AgentRuntimeIdentity>;
	eventLogLimit?: number;
	capabilities?: AgentRuntimeCapability[];
}

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

function resourcesSnapshot(session: AgentSession): RuntimeResourceSnapshot {
	const skills = session.resourceLoader.getSkills().skills.map((skill) => ({
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		disableModelInvocation: skill.disableModelInvocation,
	}));
	const promptTemplates = session.resourceLoader.getPrompts().prompts.map((prompt) => ({
		name: prompt.name,
		description: prompt.description,
		argumentHint: prompt.argumentHint,
		filePath: prompt.filePath,
	}));
	const themes = session.resourceLoader.getThemes().themes.map((theme) => ({
		name: theme.name,
		sourcePath: theme.sourcePath,
	}));
	const extensions = session.resourceLoader.getExtensions().extensions.map((extension) => ({
		path: extension.path,
		resolvedPath: extension.resolvedPath,
	}));
	const agentsFiles = session.resourceLoader.getAgentsFiles().agentsFiles.map((file) => ({ path: file.path }));
	return { skills, promptTemplates, themes, extensions, agentsFiles };
}

function diagnosticsSnapshot(session: AgentSession): RuntimeDiagnosticSnapshot {
	const skills = session.resourceLoader.getSkills().diagnostics;
	const prompts = session.resourceLoader.getPrompts().diagnostics;
	const themes = session.resourceLoader.getThemes().diagnostics;
	const extensions = session.resourceLoader.getExtensions();
	return {
		resources: [...skills, ...prompts, ...themes].map((diagnostic) => ({
			type: diagnostic.type,
			message: diagnostic.message,
			path: diagnostic.path,
		})),
		extensions: extensions.errors.map((error) => ({ path: error.path, error: error.error })),
	};
}

function modelRegistrySnapshot(session: AgentSession): RuntimeModelRegistrySnapshot {
	return {
		available: session.modelRegistry.getAvailable().map((model) => modelSnapshot(model)),
		error: session.modelRegistry.getError(),
	};
}

function configSnapshot(session: AgentSession): RuntimeConfigSnapshot {
	return {
		autoCompaction: session.autoCompactionEnabled,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		scopedModels: session.scopedModels.map((scoped) => ({
			model: modelSnapshot(scoped.model),
			thinkingLevel: scoped.thinkingLevel,
		})),
	};
}

export class AgentRuntimeSnapshotProjector {
	private readonly identity: AgentRuntimeIdentity;
	private readonly maxEventLogEntries: number;
	private readonly capabilities: AgentRuntimeCapability[];
	private readonly listeners = new Set<AgentRuntimeEventListener>();
	private readonly eventLog: AgentRuntimeEvent[] = [];
	private readonly activeToolExecutions = new Map<string, ToolExecutionSnapshot>();
	private status: AgentRuntimeStatus;
	private streamingMessage?: AgentMessage;
	private lastError?: string;
	private nextEventId = 1;
	private unsubscribe?: () => void;

	private session: AgentSession;

	constructor(session: AgentSession, options: AgentRuntimeSnapshotProjectorOptions = {}) {
		this.session = session;
		this.identity = {
			agentId: options.identity?.agentId ?? session.sessionId,
			agentLabel: options.identity?.agentLabel,
		};
		this.maxEventLogEntries = options.eventLogLimit ?? 2000;
		this.capabilities = options.capabilities ?? ["event_replay", "extension_events"];
		this.status = statusFromSession(session);
		this.subscribeToSession(session);
	}

	replaceSession(session: AgentSession): void {
		const previousStatus = this.status;
		this.unsubscribe?.();
		this.activeToolExecutions.clear();
		this.streamingMessage = undefined;
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

	attach(options: AgentRuntimeAttachOptions = {}): AgentRuntimeAttachResult {
		const unsubscribe = options.listener ? this.subscribe(options.listener) : () => {};
		const snapshot = this.getSnapshot();
		const initialEvents =
			options.lastSeenEventId === undefined
				? []
				: this.getEventsAfter(options.lastSeenEventId).filter((event) => event.id <= snapshot.eventCursor);
		return {
			snapshot,
			initialEvents,
			initialEventsComplete: this.hasCompleteEventsAfter(options.lastSeenEventId),
			unsubscribe,
		};
	}

	getEventsAfter(eventId: number): AgentRuntimeEvent[] {
		return this.eventLog.filter((event) => event.id > eventId);
	}

	emitExtensionEvent(namespace: string, payload: unknown): void {
		this.emit({ type: "extension_event", namespace, payload });
	}

	private hasCompleteEventsAfter(eventId: number | undefined): boolean {
		if (eventId === undefined || this.eventLog.length === 0) {
			return true;
		}
		return eventId >= this.eventLog[0].id - 1;
	}

	getSnapshot(): AgentRuntimeSnapshot {
		const session = this.session;
		return {
			protocolVersion: 1,
			capabilities: this.capabilities,
			eventCursor: this.nextEventId - 1,
			agent: {
				agentId: this.identity.agentId,
				agentLabel: this.identity.agentLabel,
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
				streamingMessage: this.streamingMessage,
				retryAttempt: session.retryAttempt,
				lastError: this.lastError,
				pendingUserMessages: pendingUserMessages(session),
				pendingApprovals: [],
				activeToolExecutions: Array.from(this.activeToolExecutions.values()).filter(
					(tool) => tool.status === "pending" || tool.status === "running",
				),
			},
			tools: {
				active: session.getActiveToolNames(),
				available: session.getAllTools(),
			},
			resources: resourcesSnapshot(session),
			modelRegistry: modelRegistrySnapshot(session),
			diagnostics: diagnosticsSnapshot(session),
			config: configSnapshot(session),
		};
	}

	private subscribeToSession(session: AgentSession): void {
		this.unsubscribe = session.subscribe((event) => this.handleSessionEvent(event));
	}

	private handleSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.lastError = undefined;
				this.emitStatusIfChanged("running");
				break;
			case "agent_end":
				this.streamingMessage = undefined;
				this.emitStatusIfChanged(this.session.isCompacting ? "compacting" : "idle");
				break;
			case "message_start":
				if (event.message.role === "assistant") {
					this.streamingMessage = event.message;
				}
				this.emit({ type: "message_start", message: event.message });
				break;
			case "message_update":
				if (event.message.role === "assistant") {
					this.streamingMessage = event.message;
				}
				this.emit({ type: "message_delta", message: event.message });
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.streamingMessage = undefined;
				}
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
			case "transcript_changed":
				this.emit({ type: "transcript_changed", reason: event.reason });
				break;
			case "compaction_start":
				this.emitStatusIfChanged("compacting");
				this.emit({ type: "compaction_start", reason: event.reason });
				break;
			case "compaction_end":
				this.emit({ type: "compaction_end", reason: event.reason, aborted: event.aborted });
				if (!event.aborted) {
					this.emit({ type: "transcript_changed", reason: "compaction" });
				}
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
					this.lastError = event.finalError;
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
		this.eventLog.push(withId);
		if (this.eventLog.length > this.maxEventLogEntries) {
			this.eventLog.splice(0, this.eventLog.length - this.maxEventLogEntries);
		}
		for (const listener of this.listeners) {
			listener(withId);
		}
	}
}
