import { randomUUID } from "node:crypto";
import { xmlEscape } from "../utils/xml.ts";
import { type AgentRuntimeSnapshot, getTranscriptPageBefore } from "./agent-runtime-snapshot.ts";
import type { PromptOptions } from "./agent-session.ts";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import { serializeJsonLine } from "./jsonl.ts";
import type { A2AMessage, A2AMessageSendParams, A2ATask, A2ATaskIdParams, A2ATaskQueryParams } from "./local-a2a.ts";
import type {
	RuntimeIpcError,
	RuntimeIpcMethod,
	RuntimeIpcNotification,
	RuntimeIpcRequest,
	RuntimeIpcResponse,
	RuntimeIpcResult,
} from "./runtime-ipc.ts";
import type { RuntimeTransport } from "./runtime-transport.ts";
import type { SessionEntry } from "./session-manager.ts";

interface A2ARuntimeState {
	tasks: Map<string, A2ATask>;
	queue: Promise<void>;
	activeTaskId?: string;
	submittedTaskIds: Set<string>;
}

const DEFAULT_A2A_SEND_TIMEOUT_MS = 5 * 60 * 1000;
const a2aStateByRuntime = new WeakMap<AgentSessionRuntime, A2ARuntimeState>();

export class RuntimeIpcServer {
	private readonly runtime: AgentSessionRuntime;
	private readonly transport: RuntimeTransport;
	private readonly onShutdown?: () => void;
	private readonly unsubscribeTransport: () => void;
	private readonly unsubscribeTransportClose: () => void;
	private unsubscribeRuntimeEvents?: () => void;
	private disposed = false;

	constructor(runtime: AgentSessionRuntime, transport: RuntimeTransport, options: { onShutdown?: () => void } = {}) {
		this.runtime = runtime;
		this.transport = transport;
		this.onShutdown = options.onShutdown;
		this.unsubscribeTransport = transport.onLine((line) => {
			void this.handleLine(line);
		});
		this.unsubscribeTransportClose = transport.onClose(() => this.dispose());
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.unsubscribeTransport();
		this.unsubscribeTransportClose();
		this.unsubscribeRuntimeEvents?.();
		this.unsubscribeRuntimeEvents = undefined;
		this.transport.close();
	}

	private async handleLine(line: string): Promise<void> {
		let message: unknown;
		try {
			message = JSON.parse(line) as unknown;
		} catch {
			return;
		}
		if (!isRuntimeIpcRequest(message)) {
			return;
		}

		try {
			const result = await this.dispatch(message);
			await this.sendResponse({ id: message.id, ok: true, result } as RuntimeIpcResponse);
		} catch (error) {
			await this.sendResponse({
				id: message.id,
				ok: false,
				error: toRuntimeIpcError(error),
			});
		}
	}

	private async dispatch(request: RuntimeIpcRequest): Promise<RuntimeIpcResult[RuntimeIpcMethod]> {
		switch (request.method) {
			case "attach": {
				const params = readObjectParams(request.params);
				const lastSeenEventId = typeof params.lastSeenEventId === "number" ? params.lastSeenEventId : undefined;
				const maxTranscriptBytes =
					typeof params.maxTranscriptBytes === "number" ? params.maxTranscriptBytes : undefined;
				const maxTranscriptEntries =
					typeof params.maxTranscriptEntries === "number" ? params.maxTranscriptEntries : undefined;
				this.unsubscribeRuntimeEvents?.();
				const { unsubscribe, ...result } = this.runtime.attachRuntime({
					lastSeenEventId,
					maxTranscriptBytes,
					maxTranscriptEntries,
					listener: (event) => {
						void this.sendNotification({ type: "runtime_event", event });
					},
				});
				this.unsubscribeRuntimeEvents = unsubscribe;
				return result;
			}
			case "detach":
				this.unsubscribeRuntimeEvents?.();
				this.unsubscribeRuntimeEvents = undefined;
				return {};
			case "prompt": {
				const params = readObjectParams(request.params);
				if (typeof params.text !== "string") {
					throw invalidParams("prompt.text must be a string");
				}
				const options =
					typeof params.options === "object" && params.options !== null
						? (params.options as PromptOptions)
						: undefined;
				await this.runtime.session.prompt(params.text, options);
				return {};
			}
			case "abort":
				await this.runtime.session.abort();
				return {};
			case "waitForIdle":
				await this.runtime.session.agent.waitForIdle();
				return {};
			case "executeCommand": {
				const params = readObjectParams(request.params);
				if (typeof params.name !== "string" || typeof params.args !== "string") {
					throw invalidParams("executeCommand.name and executeCommand.args must be strings");
				}
				const handled = await this.runtime.session.executeExtensionCommand(params.name, params.args);
				return { handled };
			}
			case "setModel": {
				const params = readObjectParams(request.params);
				if (typeof params.provider !== "string" || typeof params.modelId !== "string") {
					throw invalidParams("setModel.provider and setModel.modelId must be strings");
				}
				this.runtime.session.modelRegistry.refresh();
				const model = this.runtime.session.modelRegistry.find(params.provider, params.modelId);
				if (!model) {
					throw invalidParams(`Model not found: ${params.provider}/${params.modelId}`);
				}
				await this.runtime.session.setModel(model);
				return {};
			}
			case "newSession":
				return await this.runtime.newSession();
			case "compact": {
				const params = readObjectParams(request.params);
				const customInstructions =
					typeof params.customInstructions === "string" && params.customInstructions.trim().length > 0
						? params.customInstructions
						: undefined;
				const result = await this.runtime.session.compact(customInstructions);
				return { result };
			}
			case "reload":
				await this.runtime.session.reload();
				return {};
			case "stopMonitor": {
				const params = readObjectParams(request.params);
				if (typeof params.id !== "string" || params.id.trim().length === 0) {
					throw invalidParams("stopMonitor.id must be a non-empty string");
				}
				return { stopped: this.runtime.session.stopMonitor(params.id) !== undefined };
			}
			case "getSnapshot": {
				const params =
					request.params === undefined ? undefined : (readObjectParams(request.params) as Record<string, unknown>);
				const maxTranscriptBytes =
					typeof params?.maxTranscriptBytes === "number" ? params.maxTranscriptBytes : undefined;
				const maxTranscriptEntries =
					typeof params?.maxTranscriptEntries === "number" ? params.maxTranscriptEntries : undefined;
				return { snapshot: this.runtime.getSnapshot({ maxTranscriptBytes, maxTranscriptEntries }) };
			}
			case "transcript/getBefore": {
				const params = readObjectParams(request.params);
				const beforeEntryId = typeof params.beforeEntryId === "string" ? params.beforeEntryId : undefined;
				const maxEntries = typeof params.maxEntries === "number" ? params.maxEntries : undefined;
				const maxBytes = typeof params.maxBytes === "number" ? params.maxBytes : undefined;
				try {
					return getTranscriptPageBefore(this.runtime.session.sessionManager.getEntries(), {
						beforeEntryId,
						maxBytes,
						maxEntries,
					});
				} catch (error) {
					throw invalidParams(error instanceof Error ? error.message : String(error));
				}
			}
			case "shutdown":
				setTimeout(() => this.onShutdown?.(), 0);
				return {};
			case "a2a/message/send": {
				const params = readObjectParams(request.params) as unknown as A2AMessageSendParams;
				if (!isA2AMessage(params.message)) {
					throw invalidParams("message/send requires params.message");
				}
				const text = messageText(params.message);
				if (text.trim().length === 0) {
					throw invalidParams("message/send requires non-empty text");
				}
				if (params.message.taskId) {
					throw invalidParams("message/send taskId continuation is not supported yet");
				}
				const from = typeof params.metadata?.from === "string" ? params.metadata.from : undefined;
				const task = createA2ATask(params.message, {
					owner: this.runtime.getSnapshot().agent.agentId,
					blocking: params.configuration?.blocking !== false,
					from,
				});
				this.getA2ATasks().set(task.id, task);
				this.emitA2ATaskChanged(task);
				const shouldBlock = params.configuration?.blocking !== false && this.canStartA2ATaskImmediately();
				const runPromise = this.enqueueA2ATask(task, params.message, from);
				if (!shouldBlock) {
					void runPromise;
				} else {
					await settleOrTimeout(runPromise, params.configuration?.timeoutMs ?? DEFAULT_A2A_SEND_TIMEOUT_MS);
				}
				return { task: omitA2ATaskHistory(task) };
			}
			case "a2a/tasks/get": {
				const params = readObjectParams(request.params) as unknown as A2ATaskQueryParams;
				if (typeof params.id !== "string") {
					throw invalidParams("tasks/get requires params.id");
				}
				return { task: this.getA2ATask(params.id, params.historyLength) };
			}
			case "a2a/tasks/cancel": {
				const params = readObjectParams(request.params) as unknown as A2ATaskIdParams;
				if (typeof params.id !== "string") {
					throw invalidParams("tasks/cancel requires params.id");
				}
				const task = this.getExistingA2ATask(params.id);
				if (
					task.status.state === "submitted" ||
					task.status.state === "working" ||
					task.status.state === "input-required"
				) {
					const wasActive = task.status.state === "working" && this.getA2AState().activeTaskId === task.id;
					cancelA2ATask(task);
					this.emitA2ATaskChanged(task);
					if (wasActive) {
						await this.runtime.session.abort();
					}
				}
				return { task: omitA2ATaskHistory(task) };
			}
			default:
				throw {
					code: "unknown_method",
					message: `Unknown runtime IPC method: ${String(request.method)}`,
				} satisfies RuntimeIpcError;
		}
	}

	private async sendResponse(response: RuntimeIpcResponse): Promise<void> {
		try {
			await this.transport.send(serializeJsonLine(response));
		} catch (error) {
			this.handleSendError(error);
		}
	}

	private async sendNotification(notification: RuntimeIpcNotification): Promise<void> {
		try {
			await this.transport.send(serializeJsonLine(notification));
		} catch (error) {
			this.handleSendError(error);
		}
	}

	private handleSendError(_error: unknown): void {
		this.dispose();
	}

	private getA2ATasks(): Map<string, A2ATask> {
		return this.getA2AState().tasks;
	}

	private getA2AState(): A2ARuntimeState {
		let state = a2aStateByRuntime.get(this.runtime);
		if (!state) {
			state = { tasks: new Map(), queue: Promise.resolve(), submittedTaskIds: new Set() };
			a2aStateByRuntime.set(this.runtime, state);
		}
		return state;
	}

	private getA2ATask(id: string, historyLength?: number): A2ATask {
		const task = this.getExistingA2ATask(id);
		if (historyLength !== undefined && historyLength >= 0 && task.history) {
			return { ...task, history: historyLength === 0 ? [] : task.history.slice(-historyLength) };
		}
		return omitA2ATaskHistory(task);
	}

	private getExistingA2ATask(id: string): A2ATask {
		const task = this.getA2ATasks().get(id);
		if (!task) {
			throw { code: "invalid_params", message: `Task not found: ${id}` } satisfies RuntimeIpcError;
		}
		return task;
	}

	private canStartA2ATaskImmediately(): boolean {
		const state = this.getA2AState();
		const snapshot = this.runtime.getSnapshot();
		return (
			state.activeTaskId === undefined &&
			state.submittedTaskIds.size === 0 &&
			snapshot.agent.status === "idle" &&
			!snapshot.run.isStreaming &&
			!snapshot.run.isBashRunning
		);
	}

	private enqueueA2ATask(task: A2ATask, message: A2AMessage, from: string | undefined): Promise<void> {
		const state = this.getA2AState();
		state.submittedTaskIds.add(task.id);
		const run = async () => {
			if (isTaskCanceled(task)) {
				state.submittedTaskIds.delete(task.id);
				return;
			}
			await this.runtime.session.agent.waitForIdle();
			if (isTaskCanceled(task)) {
				state.submittedTaskIds.delete(task.id);
				return;
			}
			state.submittedTaskIds.delete(task.id);
			state.activeTaskId = task.id;
			task.status = {
				state: "working",
				message: createA2AAgentMessage(task, "Working on the requested message."),
				timestamp: new Date().toISOString(),
			};
			appendTaskHistory(task, task.status.message);
			this.emitA2ATaskChanged(task);
			try {
				await this.runtime.session.sendCustomMessage(
					{
						customType: "a2a-message",
						content: formatInboundA2AMessage(message, from),
						display: true,
						details: {
							from,
							messageId: message.messageId,
							contextId: message.contextId,
							taskId: message.taskId,
						},
					},
					{ triggerTurn: true },
				);
				if (task.status.state === "canceled") {
					return;
				}
				const after = this.runtime.getSnapshot();
				const result = extractA2AAssistantText(after, message.messageId);
				task.status = {
					state: "completed",
					message: createA2AAgentMessage(task, result),
					timestamp: new Date().toISOString(),
				};
				task.artifacts = [
					{
						artifactId: randomUUID(),
						name: "assistant-response",
						description: "Text captured from assistant messages produced during this A2A task.",
						parts: [{ kind: "text", text: result }],
					},
				];
				appendTaskHistory(task, task.status.message);
				this.emitA2ATaskChanged(task);
			} catch (error) {
				if (task.status.state === "canceled") {
					return;
				}
				const errorMessage = error instanceof Error ? error.message : String(error);
				task.status = {
					state: "failed",
					message: createA2AAgentMessage(task, errorMessage),
					timestamp: new Date().toISOString(),
				};
				appendTaskHistory(task, task.status.message);
				this.emitA2ATaskChanged(task);
			} finally {
				if (state.activeTaskId === task.id) {
					state.activeTaskId = undefined;
				}
			}
		};
		state.queue = state.queue.then(run, run);
		return state.queue;
	}

	private emitA2ATaskChanged(task: A2ATask): void {
		const metadata = typeof task.metadata === "object" && task.metadata !== null ? task.metadata : {};
		this.runtime.emitA2ATaskChanged({
			id: task.id,
			contextId: task.contextId,
			owner: typeof metadata.owner === "string" ? metadata.owner : undefined,
			state: task.status.state,
			timestamp: task.status.timestamp,
		});
	}
}

export function createRuntimeIpcServer(
	runtime: AgentSessionRuntime,
	transport: RuntimeTransport,
	options?: { onShutdown?: () => void },
): RuntimeIpcServer {
	return new RuntimeIpcServer(runtime, transport, options);
}

function readObjectParams(params: unknown): Record<string, unknown> {
	if (typeof params === "object" && params !== null) {
		return params as Record<string, unknown>;
	}
	return {};
}

function invalidParams(message: string): RuntimeIpcError {
	return { code: "invalid_params", message };
}

function createA2ATask(message: A2AMessage, metadata: { owner: string; blocking: boolean; from?: string }): A2ATask {
	const id = message.taskId ?? randomUUID();
	const contextId = message.contextId ?? randomUUID();
	const userMessage = { ...message, taskId: id, contextId };
	return {
		kind: "task",
		id,
		contextId,
		status: {
			state: "submitted",
			message: userMessage,
			timestamp: new Date().toISOString(),
		},
		history: [userMessage],
		metadata,
	};
}

function appendTaskHistory(task: A2ATask, message: A2AMessage | undefined): void {
	if (message) {
		task.history = [...(task.history ?? []), message];
	}
}

function isTaskCanceled(task: A2ATask): boolean {
	return task.status.state === "canceled";
}

function cancelA2ATask(task: A2ATask): void {
	task.status = {
		state: "canceled",
		message: createA2AAgentMessage(task, "Task canceled."),
		timestamp: new Date().toISOString(),
	};
	appendTaskHistory(task, task.status.message);
}

function createA2AAgentMessage(task: A2ATask, text: string): A2AMessage {
	return {
		kind: "message",
		messageId: randomUUID(),
		role: "agent",
		parts: [{ kind: "text", text }],
		taskId: task.id,
		contextId: task.contextId,
	};
}

function isA2AMessage(value: unknown): value is A2AMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "message" &&
		"role" in value &&
		(value.role === "user" || value.role === "agent") &&
		"parts" in value &&
		Array.isArray(value.parts)
	);
}

function messageText(message: A2AMessage): string {
	return message.parts
		.map((part) => (part.kind === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n\n");
}

function formatInboundA2AMessage(message: A2AMessage, from: string | undefined): string {
	const parts = ["<a2a-message>"];
	if (from) {
		parts.push(`<from>${xmlEscape(from)}</from>`);
	}
	parts.push(`<message-id>${xmlEscape(message.messageId)}</message-id>`);
	if (message.contextId) {
		parts.push(`<context-id>${xmlEscape(message.contextId)}</context-id>`);
	}
	if (message.taskId) {
		parts.push(`<task-id>${xmlEscape(message.taskId)}</task-id>`);
	}
	parts.push(
		"<instruction>",
		"Answer this A2A message directly in the current assistant response. Do not call a2a_send_message back to acknowledge or reply.",
		"</instruction>",
	);
	parts.push("<text>", xmlEscape(messageText(message)), "</text>", "</a2a-message>");
	return parts.join("\n");
}

function extractA2AAssistantText(snapshot: AgentRuntimeSnapshot, messageId: string): string {
	const messages: string[] = [];
	const startIndex = snapshot.transcript.entries.findIndex(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "a2a-message" &&
			customEntryMatchesMessageId(entry, messageId),
	);
	if (startIndex === -1) {
		return "(No assistant reply was recorded.)";
	}
	for (const entry of snapshot.transcript.entries.slice(startIndex + 1)) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const text = assistantEntryText(entry);
			if (text.trim().length > 0) {
				messages.push(text);
			}
			continue;
		}
		if (
			entry.type === "custom_message" ||
			(entry.type === "message" && (entry.message.role === "user" || entry.message.role === "custom"))
		) {
			break;
		}
	}
	return messages.length > 0 ? messages.join("\n\n") : "(No assistant reply was recorded.)";
}

function customEntryMatchesMessageId(
	entry: Extract<SessionEntry, { type: "custom_message" }>,
	messageId: string,
): boolean {
	const details = entry.details;
	if (
		typeof details === "object" &&
		details !== null &&
		"messageId" in details &&
		(details as { messageId?: unknown }).messageId === messageId
	) {
		return true;
	}
	const content =
		typeof entry.content === "string"
			? entry.content
			: entry.content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("\n");
	return content.includes(`<message-id>${xmlEscape(messageId)}</message-id>`);
}

function assistantEntryText(entry: Extract<SessionEntry, { type: "message" }>): string {
	if (!("content" in entry.message)) {
		return "";
	}
	const content = entry.message.content;
	return typeof content === "string"
		? content
		: content.map((part: unknown) => (isTextPart(part) ? part.text : "")).join("");
}

function isTextPart(value: unknown): value is { text: string } {
	return typeof value === "object" && value !== null && "text" in value && typeof value.text === "string";
}

function omitA2ATaskHistory(task: A2ATask): A2ATask {
	if (!task.history || task.history.length === 0) {
		return task;
	}
	const { history: _history, ...rest } = task;
	return {
		...rest,
		metadata: {
			...(typeof rest.metadata === "object" && rest.metadata !== null ? rest.metadata : {}),
			historyOmitted: true,
			historyLength: task.history.length,
		},
	};
}

function settleOrTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (!settled) {
				settled = true;
				resolve();
			}
		};
		const timer = setTimeout(finish, Math.max(0, timeoutMs));
		void promise.finally(() => {
			clearTimeout(timer);
			finish();
		});
	});
}

function toRuntimeIpcError(error: unknown): RuntimeIpcError {
	if (isRuntimeIpcError(error)) {
		return error;
	}
	return {
		code: "runtime_error",
		message: error instanceof Error ? error.message : String(error),
	};
}

function isRuntimeIpcError(value: unknown): value is RuntimeIpcError {
	return (
		typeof value === "object" &&
		value !== null &&
		"code" in value &&
		typeof value.code === "string" &&
		"message" in value &&
		typeof value.message === "string"
	);
}

function isRuntimeIpcRequest(value: unknown): value is RuntimeIpcRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"method" in value &&
		typeof value.method === "string"
	);
}
