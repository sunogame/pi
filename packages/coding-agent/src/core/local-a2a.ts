import { randomUUID } from "node:crypto";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../config.ts";
import type { Theme } from "../modes/interactive/theme/theme.ts";
import { shortId } from "../utils/ids.ts";
import { xmlEscape } from "../utils/xml.ts";
import {
	formatRelativeCardPath,
	loadTeamAgentCards,
	type PiA2AAgentCard,
	type TeamRuntimeCardSpec,
} from "./a2a-agent-card.ts";
import type { AgentRuntimeSnapshot } from "./agent-runtime-snapshot.ts";
import type { AgentToolResult } from "./extensions/index.ts";
import { defineTool, type ToolDefinition } from "./extensions/types.ts";
import { createIpcRuntimeClient } from "./ipc-runtime-client.ts";
import type { RuntimeNotification } from "./monitor-manager.ts";
import { listRuntimeRegistryEntries, type RuntimeRegistryEntry, readRuntimeRegistryEntry } from "./runtime-registry.ts";
import { connectRuntimeSocket } from "./runtime-socket-transport.ts";

export type A2ATaskState =
	| "submitted"
	| "working"
	| "input-required"
	| "completed"
	| "canceled"
	| "failed"
	| "rejected"
	| "auth-required"
	| "unknown";

export interface A2ATextPart {
	kind: "text";
	text: string;
	metadata?: Record<string, unknown>;
}

export type A2APart = A2ATextPart;

export interface A2AMessage {
	kind: "message";
	messageId: string;
	role: "user" | "agent";
	parts: A2APart[];
	taskId?: string;
	contextId?: string;
	metadata?: Record<string, unknown>;
}

export interface A2AArtifact {
	artifactId: string;
	name?: string;
	description?: string;
	parts: A2APart[];
	metadata?: Record<string, unknown>;
}

export interface A2ATaskStatus {
	state: A2ATaskState;
	message?: A2AMessage;
	timestamp?: string;
}

export interface A2ATask {
	kind: "task";
	id: string;
	contextId: string;
	status: A2ATaskStatus;
	artifacts?: A2AArtifact[];
	history?: A2AMessage[];
	metadata?: Record<string, unknown>;
}

export interface A2AMessageSendParams {
	to?: string;
	message: A2AMessage;
	configuration?: {
		blocking?: boolean;
		acceptedOutputModes?: string[];
		timeoutMs?: number;
	};
	metadata?: Record<string, unknown>;
}

export interface A2ATaskQueryParams {
	id: string;
	historyLength?: number;
	metadata?: Record<string, unknown>;
}

export interface A2ATaskIdParams {
	id: string;
	metadata?: Record<string, unknown>;
}

export interface LocalA2AToolsOptions {
	agentDir?: string;
	selfName?: string;
	teamSpecs: TeamRuntimeCardSpec[];
	configBaseCwd?: string;
	onRuntimeNotification?: (notification: RuntimeNotification) => void;
	taskPollIntervalMs?: number;
}

const listAgentCardsSchema = Type.Object({});
const sendMessageSchema = Type.Object({
	to: Type.String({ description: "Target peer agent name from the Agent Cards." }),
	text: Type.String({
		description: "Text message to send to the peer agent.",
		minLength: 1,
		maxLength: 65536,
	}),
	contextId: Type.Optional(Type.String({ description: "Optional A2A contextId for continuing related work." })),
	blocking: Type.Optional(
		Type.Boolean({
			description:
				"Wait only if the peer can start this task immediately. Queued tasks still return immediately. Defaults to false.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({ description: "Maximum time to wait when blocking is true. Defaults to 300000." }),
	),
});
const getTaskSchema = Type.Object({
	agent: Type.String({ description: "Peer agent name that owns the task." }),
	taskId: Type.String({ description: "A2A task id returned by a2a_send_message." }),
	historyLength: Type.Optional(Type.Number({ description: "Optional number of recent history messages to return." })),
});
const cancelTaskSchema = Type.Object({
	agent: Type.String({ description: "Peer agent name that owns the task." }),
	taskId: Type.String({ description: "A2A task id to cancel." }),
});

function formatA2ASendCall(args: Partial<Static<typeof sendMessageSchema>> | undefined, theme: Theme): string {
	const target = args?.to ? theme.fg("accent", args.to) : theme.fg("toolOutput", "...");
	const text = compactPreview(args?.text ?? "", 72);
	const mode = args?.blocking ? theme.fg("muted", " blocking") : "";
	return `${theme.fg("toolTitle", theme.bold("a2a_send_message"))} ${target}${mode}${text ? theme.fg("toolOutput", ` · ${text}`) : ""}`;
}

function formatA2AGetTaskCall(args: Partial<Static<typeof getTaskSchema>> | undefined, theme: Theme): string {
	const agent = args?.agent ? theme.fg("accent", args.agent) : theme.fg("toolOutput", "...");
	const taskId = args?.taskId ? shortId(args.taskId) : "...";
	return `${theme.fg("toolTitle", theme.bold("a2a_get_task"))} ${agent}/${theme.fg("muted", taskId)}`;
}

function formatA2ACancelTaskCall(args: Partial<Static<typeof cancelTaskSchema>> | undefined, theme: Theme): string {
	const agent = args?.agent ? theme.fg("accent", args.agent) : theme.fg("toolOutput", "...");
	const taskId = args?.taskId ? shortId(args.taskId) : "...";
	return `${theme.fg("toolTitle", theme.bold("a2a_cancel_task"))} ${agent}/${theme.fg("muted", taskId)}`;
}

function formatA2ATaskResult(task: A2ATask | undefined, theme: Theme): string {
	if (!task) {
		return theme.fg("toolOutput", "No task returned");
	}
	const owner = typeof task.metadata?.owner === "string" ? task.metadata.owner : "peer";
	const state = task.status.state;
	const stateText =
		state === "completed"
			? theme.fg("success", state)
			: state === "failed" || state === "canceled" || state === "rejected"
				? theme.fg("error", state)
				: state === "working"
					? theme.fg("accent", state)
					: theme.fg("warning", state);
	const lines = [
		`${theme.fg("toolTitle", theme.bold("A2A task"))} ${stateText} · ${theme.fg("accent", owner)}/${theme.fg("muted", shortId(task.id))}`,
	];
	const messageText = taskMessageText(task.status.message);
	if (messageText) {
		lines.push(theme.fg("toolOutput", `  ${compactPreview(messageText, 160)}`));
	}
	if (task.artifacts && task.artifacts.length > 0) {
		lines.push(theme.fg("muted", `  artifacts ${task.artifacts.length}`));
	}
	return lines.join("\n");
}

function taskMessageText(message: A2AMessage | undefined): string {
	if (!message) {
		return "";
	}
	return message.parts
		.map((part) => (part.kind === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n\n");
}

function compactPreview(text: string, maxLength: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) {
		return compact;
	}
	return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function textComponent(text: string, context: { lastComponent?: unknown }): Text {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(text);
	return component;
}

export function createLocalA2AToolDefinitions(options: LocalA2AToolsOptions): ToolDefinition[] {
	const agentDir = options.agentDir ?? getAgentDir();
	const getCards = () => loadTeamAgentCards(options.teamSpecs, options.configBaseCwd);

	return [
		defineTool({
			name: "a2a_list_agent_cards",
			label: "A2A list agents",
			description: "List A2A-style Agent Cards for peer agents in the pi runtime team.",
			promptSnippet: "a2a_list_agent_cards: list peer Agent Cards for A2A routing.",
			parameters: listAgentCardsSchema,
			async execute(): Promise<AgentToolResult<{ cards: PiA2AAgentCard[] }>> {
				const cards = getCards();
				return textResult(JSON.stringify({ agents: cards.map(toPublicCard) }, null, 2), { cards });
			},
		}),
		defineTool({
			name: "a2a_send_message",
			label: "A2A send message",
			description:
				"Send an A2A-style text message to a peer runtime. Returns an A2A Task owned by the target agent.",
			promptSnippet: "a2a_send_message: send a message to a peer agent; returns an A2A Task.",
			promptGuidelines: [
				"Use a2a_send_message only when a peer Agent Card indicates it is a better fit for a focused question or task.",
				"Do not use a2a_send_message to acknowledge or reply to an incoming <a2a-message>; answer directly in the current turn instead.",
				"Include the necessary context in the message.",
				"When a2a_send_message returns a non-terminal Task, pi automatically starts an A2A task watcher and will notify you when the task reaches a terminal state. Do not start a shell monitor for A2A tasks.",
				"blocking=true is only an immediate-start optimization; queued tasks return without waiting to avoid deadlocks.",
			],
			parameters: sendMessageSchema,
			executionMode: "sequential",
			async execute(
				_toolCallId,
				params: Static<typeof sendMessageSchema>,
			): Promise<AgentToolResult<{ task: A2ATask }>> {
				const task = await sendA2AMessage(agentDir, options.selfName, params.to, {
					message: {
						kind: "message",
						messageId: randomUUID(),
						role: "user",
						parts: [{ kind: "text", text: params.text }],
						contextId: params.contextId,
					},
					configuration: {
						blocking: params.blocking ?? false,
						acceptedOutputModes: ["text/plain"],
						timeoutMs: params.timeoutMs,
					},
					metadata: options.selfName ? { from: options.selfName } : undefined,
				});
				const autoMonitor = maybeStartA2ATaskWatcher(agentDir, params.to, task, options);
				return textResult(formatA2ATaskForModel(task, autoMonitor), { task });
			},
			renderCall(args, theme, context) {
				return textComponent(formatA2ASendCall(args, theme), context);
			},
			renderResult(result, _options, theme, context) {
				return textComponent(formatA2ATaskResult(result.details?.task, theme), context);
			},
		}),
		defineTool({
			name: "a2a_get_task",
			label: "A2A get task",
			description: "Fetch an A2A Task from the peer agent runtime that owns it.",
			promptSnippet: "a2a_get_task: fetch status and results for a peer-owned A2A Task.",
			promptGuidelines: [
				"Use a2a_get_task only for an immediate status refresh or when recovering a task by id.",
				"If a2a_send_message already started an automatic watcher, prefer waiting for the a2a-task-notification instead of polling repeatedly.",
				"If a watcher reports timeout or error, call a2a_get_task once for the latest status before deciding whether to retry or report uncertainty.",
			],
			parameters: getTaskSchema,
			executionMode: "sequential",
			async execute(_toolCallId, params: Static<typeof getTaskSchema>): Promise<AgentToolResult<{ task: A2ATask }>> {
				const task = await getA2ATask(agentDir, params.agent, {
					id: params.taskId,
					historyLength: params.historyLength,
				});
				return textResult(formatA2ATaskForModel(task), { task });
			},
			renderCall(args, theme, context) {
				return textComponent(formatA2AGetTaskCall(args, theme), context);
			},
			renderResult(result, _options, theme, context) {
				return textComponent(formatA2ATaskResult(result.details?.task, theme), context);
			},
		}),
		defineTool({
			name: "a2a_cancel_task",
			label: "A2A cancel task",
			description: "Request cancellation of an A2A Task owned by a peer agent runtime.",
			promptSnippet: "a2a_cancel_task: cancel a peer-owned A2A Task when it is no longer needed.",
			promptGuidelines: [
				"Use a2a_cancel_task only when the remote task is no longer needed or should stop.",
				"Do not use cancel to mark work done; completion is controlled by the peer runtime.",
			],
			parameters: cancelTaskSchema,
			executionMode: "sequential",
			async execute(
				_toolCallId,
				params: Static<typeof cancelTaskSchema>,
			): Promise<AgentToolResult<{ task: A2ATask }>> {
				const task = await cancelA2ATask(agentDir, params.agent, { id: params.taskId });
				return textResult(formatA2ATaskForModel(task), { task });
			},
			renderCall(args, theme, context) {
				return textComponent(formatA2ACancelTaskCall(args, theme), context);
			},
			renderResult(result, _options, theme, context) {
				return textComponent(formatA2ATaskResult(result.details?.task, theme), context);
			},
		}),
	];
}

async function sendA2AMessage(
	agentDir: string,
	selfName: string | undefined,
	to: string,
	params: Omit<A2AMessageSendParams, "to">,
): Promise<A2ATask> {
	if (selfName && to === selfName) {
		throw new Error(`Refusing to send A2A message from ${selfName} to itself`);
	}
	const client = await connectA2AClient(agentDir, to);
	try {
		return await client.a2aSendMessage(params);
	} finally {
		client.close();
	}
}

async function getA2ATask(agentDir: string, agent: string, params: A2ATaskQueryParams): Promise<A2ATask> {
	const client = await connectA2AClient(agentDir, agent);
	try {
		return await client.a2aGetTask(params);
	} finally {
		client.close();
	}
}

async function cancelA2ATask(agentDir: string, agent: string, params: A2ATaskIdParams): Promise<A2ATask> {
	const client = await connectA2AClient(agentDir, agent);
	try {
		return await client.a2aCancelTask(params);
	} finally {
		client.close();
	}
}

async function connectA2AClient(agentDir: string, agent: string) {
	const entry = readRuntimeRegistryEntry(agentDir, agent);
	if (!entry) {
		throw new Error(`No live runtime registered as "${agent}"`);
	}
	const transport = await connectRuntimeSocket(entry.socketPath);
	return createIpcRuntimeClient(transport, createPlaceholderSnapshot(entry));
}

function toPublicCard(card: PiA2AAgentCard): Record<string, unknown> {
	return {
		name: card.name,
		description: card.description,
		version: card.version,
		capabilities: card.capabilities,
		defaultInputModes: card.defaultInputModes,
		defaultOutputModes: card.defaultOutputModes,
		cardPath: formatRelativeCardPath(card),
		live: listRuntimeRegistryEntries(getAgentDir()).some((entry) => entry.agentId === card.name),
	};
}

const TERMINAL_A2A_STATES = new Set<A2ATaskState>(["completed", "canceled", "failed", "rejected"]);
const activeA2ATaskWatchers = new Set<string>();

function formatA2ATaskForModel(task: A2ATask, autoMonitor = false): string {
	return JSON.stringify(a2aTaskModelView(task, autoMonitor), null, 2);
}

function a2aTaskModelView(task: A2ATask, autoMonitor = false): Record<string, unknown> {
	const metadata = typeof task.metadata === "object" && task.metadata !== null ? task.metadata : {};
	const view: Record<string, unknown> = {
		kind: task.kind,
		id: task.id,
		contextId: task.contextId,
		state: task.status.state,
		timestamp: task.status.timestamp,
		owner: metadata.owner,
		from: metadata.from,
		blocking: metadata.blocking,
	};
	if (autoMonitor) {
		view.autoWatcher = {
			status: "started",
			note: "You will receive an a2a-task-notification when this task reaches a terminal state.",
		};
	}
	if (metadata.historyOmitted) {
		view.historyOmitted = true;
		view.historyLength = metadata.historyLength;
	}
	const statusText = taskMessageText(task.status.message);
	if (statusText) {
		view.message = compactPreview(statusText, 500);
	}
	if (task.history) {
		view.history = task.history.map((message) => ({
			role: message.role,
			text: compactPreview(taskMessageText(message), 500),
			taskId: message.taskId,
			contextId: message.contextId,
		}));
	}
	if (task.artifacts && task.artifacts.length > 0) {
		view.artifacts = task.artifacts.map((artifact) => ({
			artifactId: artifact.artifactId,
			name: artifact.name,
			description: artifact.description,
			parts: artifact.parts,
		}));
	}
	return view;
}

function maybeStartA2ATaskWatcher(
	agentDir: string,
	agent: string,
	task: A2ATask,
	options: LocalA2AToolsOptions,
): boolean {
	if (!options.onRuntimeNotification || isTerminalA2ATask(task)) {
		return false;
	}
	const key = `${agentDir}\0${agent}\0${task.id}`;
	if (activeA2ATaskWatchers.has(key)) {
		return true;
	}
	activeA2ATaskWatchers.add(key);
	void watchA2ATaskByEvent(agentDir, agent, task, key, options);
	return true;
}

async function watchA2ATaskByEvent(
	agentDir: string,
	agent: string,
	task: A2ATask,
	key: string,
	options: LocalA2AToolsOptions,
): Promise<void> {
	let client: Awaited<ReturnType<typeof connectA2AClient>> | undefined;
	let unsubscribeClientClose: (() => void) | undefined;
	let lastKnownTask = task;
	let done = false;
	const finish = (next: A2ATask, notificationStatus = "terminal", error?: string) => {
		if (done) {
			return;
		}
		done = true;
		clearTimeout(timeout);
		activeA2ATaskWatchers.delete(key);
		unsubscribeClientClose?.();
		unsubscribeClientClose = undefined;
		// Closing the transport is enough to detach this watcher. Sending an
		// explicit detach request here creates a pending IPC request that close()
		// immediately rejects, which can surface as an unhandled rejection.
		client?.close();
		options.onRuntimeNotification?.(createA2ATaskNotification(agent, next, notificationStatus, error));
	};
	const timeout = setTimeout(
		() => {
			void (async () => {
				if (done) {
					return;
				}
				try {
					if (client) {
						lastKnownTask = await client.a2aGetTask({ id: task.id, historyLength: 0 });
					}
				} catch {
					// Keep the last known task for the timeout notification.
				}
				if (done) {
					return;
				}
				finish(lastKnownTask, "watcher-timeout", "A2A task monitor timed out.");
			})();
		},
		10 * 60 * 1000,
	);
	timeout.unref?.();

	try {
		client = await connectA2AClient(agentDir, agent);
		unsubscribeClientClose = client.onClose(() => {
			finish(lastKnownTask, "watcher-error", `A2A task watcher disconnected from ${agent}.`);
		});
		await client.attach({
			listener: (event) => {
				if (event.type !== "a2a_task_changed" || event.task.id !== task.id) {
					return;
				}
				lastKnownTask = {
					...lastKnownTask,
					status: {
						...lastKnownTask.status,
						state: event.task.state,
						timestamp: event.task.timestamp,
					},
				};
				if (TERMINAL_A2A_STATES.has(event.task.state)) {
					void (async () => {
						if (done) {
							return;
						}
						try {
							lastKnownTask = (await client?.a2aGetTask({ id: task.id, historyLength: 0 })) ?? lastKnownTask;
							if (done) {
								return;
							}
							finish(lastKnownTask);
						} catch (error) {
							if (done) {
								return;
							}
							finish(lastKnownTask, "watcher-error", error instanceof Error ? error.message : String(error));
						}
					})();
				}
			},
		});
		lastKnownTask = await client.a2aGetTask({ id: task.id, historyLength: 0 });
		if (isTerminalA2ATask(lastKnownTask)) {
			finish(lastKnownTask);
		}
	} catch (error) {
		finish(task, "watcher-error", error instanceof Error ? error.message : String(error));
	}
}

function isTerminalA2ATask(task: A2ATask): boolean {
	return TERMINAL_A2A_STATES.has(task.status.state);
}

function createA2ATaskNotification(
	agent: string,
	task: A2ATask,
	notificationStatus = "terminal",
	error?: string,
): RuntimeNotification {
	return {
		id: `n_${randomUUID()}`,
		kind: "a2a",
		customType: "a2a-task-notification",
		createdAt: Date.now(),
		source: { agent, taskId: task.id },
		text: formatA2ATaskNotification(agent, task, notificationStatus, error),
	};
}

function formatA2ATaskNotification(agent: string, task: A2ATask, notificationStatus: string, error?: string): string {
	const parts = [
		"<a2a-task-notification>",
		`<agent>${xmlEscape(agent)}</agent>`,
		`<task-id>${xmlEscape(task.id)}</task-id>`,
		`<context-id>${xmlEscape(task.contextId)}</context-id>`,
		`<notification-status>${xmlEscape(notificationStatus)}</notification-status>`,
		`<state>${xmlEscape(task.status.state)}</state>`,
	];
	const messageText = taskMessageText(task.status.message);
	if (messageText) {
		parts.push("<message>", xmlEscape(messageText), "</message>");
	}
	const artifactText = (task.artifacts ?? [])
		.flatMap((artifact) => artifact.parts)
		.map((part) => (part.kind === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n\n");
	if (artifactText) {
		parts.push("<artifact>", xmlEscape(artifactText), "</artifact>");
	}
	if (error) {
		parts.push("<error>", xmlEscape(error), "</error>");
	}
	parts.push("</a2a-task-notification>");
	return parts.join("\n");
}

function textResult<T>(text: string, details: T): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details };
}

function createPlaceholderSnapshot(entry: RuntimeRegistryEntry): AgentRuntimeSnapshot {
	return {
		protocolVersion: 1,
		capabilities: entry.capabilities,
		eventCursor: 0,
		agent: {
			agentId: entry.agentId,
			cwd: entry.cwd,
			model: {},
			thinkingLevel: "off",
			status: entry.status,
		},
		session: {
			sessionId: entry.sessionId,
			sessionName: entry.sessionName,
			sessionDir: "",
			currentLeafId: null,
		},
		transcript: { entries: [], currentLeafId: null },
		run: {
			isStreaming: false,
			isBashRunning: false,
			retryAttempt: 0,
			pendingUserMessages: [],
			pendingNotifications: [],
			pendingApprovals: [],
			activeToolExecutions: [],
		},
		monitors: { active: [], recent: [] },
		tools: { active: [], available: [] },
		resources: { skills: [], promptTemplates: [], themes: [], extensions: [], agentsFiles: [] },
		modelRegistry: { available: [] },
		diagnostics: { resources: [], extensions: [] },
		config: {
			autoCompaction: false,
			steeringMode: "all",
			followUpMode: "all",
			availableThinkingLevels: [],
			scopedModels: [],
		},
		commands: [],
	};
}
