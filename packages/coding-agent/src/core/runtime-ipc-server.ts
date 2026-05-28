import { randomUUID } from "node:crypto";
import type { AgentRuntimeSnapshot } from "./agent-runtime-snapshot.ts";
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

interface A2ARuntimeState {
	tasks: Map<string, A2ATask>;
	queue: Promise<void>;
	activeTaskId?: string;
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
				this.unsubscribeRuntimeEvents?.();
				const { unsubscribe, ...result } = this.runtime.attachRuntime({
					lastSeenEventId,
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
			case "stopMonitor": {
				const params = readObjectParams(request.params);
				if (typeof params.id !== "string" || params.id.trim().length === 0) {
					throw invalidParams("stopMonitor.id must be a non-empty string");
				}
				return { stopped: this.runtime.session.stopMonitor(params.id) !== undefined };
			}
			case "getSnapshot":
				return { snapshot: this.runtime.getSnapshot() };
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
				if (params.message.taskId && this.getA2ATasks().has(params.message.taskId)) {
					throw invalidParams(`Task already exists: ${params.message.taskId}`);
				}
				const from = typeof params.metadata?.from === "string" ? params.metadata.from : undefined;
				const task = createA2ATask(params.message, {
					owner: this.runtime.getSnapshot().agent.agentId,
					blocking: params.configuration?.blocking !== false,
					from,
				});
				this.getA2ATasks().set(task.id, task);
				const runPromise = this.enqueueA2ATask(task, params.message, from);
				if (params.configuration?.blocking === false) {
					void runPromise;
				} else {
					await settleOrTimeout(runPromise, params.configuration?.timeoutMs ?? DEFAULT_A2A_SEND_TIMEOUT_MS);
				}
				return { task };
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
				if (task.status.state === "working" && this.getA2AState().activeTaskId === task.id) {
					await this.runtime.session.abort();
				}
				if (
					task.status.state === "submitted" ||
					task.status.state === "working" ||
					task.status.state === "input-required"
				) {
					task.status = {
						state: "canceled",
						message: createA2AAgentMessage(task, "Task canceled."),
						timestamp: new Date().toISOString(),
					};
					const statusMessage = task.status.message;
					if (statusMessage) {
						task.history = [...(task.history ?? []), statusMessage];
					}
				}
				return { task };
			}
			default:
				throw {
					code: "unknown_method",
					message: `Unknown runtime IPC method: ${String(request.method)}`,
				} satisfies RuntimeIpcError;
		}
	}

	private async sendResponse(response: RuntimeIpcResponse): Promise<void> {
		await this.transport.send(serializeJsonLine(response));
	}

	private async sendNotification(notification: RuntimeIpcNotification): Promise<void> {
		await this.transport.send(serializeJsonLine(notification));
	}

	private getA2ATasks(): Map<string, A2ATask> {
		return this.getA2AState().tasks;
	}

	private getA2AState(): A2ARuntimeState {
		let state = a2aStateByRuntime.get(this.runtime);
		if (!state) {
			state = { tasks: new Map(), queue: Promise.resolve() };
			a2aStateByRuntime.set(this.runtime, state);
		}
		return state;
	}

	private getA2ATask(id: string, historyLength?: number): A2ATask {
		const task = this.getExistingA2ATask(id);
		if (historyLength !== undefined && historyLength >= 0 && task.history) {
			return { ...task, history: task.history.slice(-historyLength) };
		}
		return task;
	}

	private getExistingA2ATask(id: string): A2ATask {
		const task = this.getA2ATasks().get(id);
		if (!task) {
			throw { code: "invalid_params", message: `Task not found: ${id}` } satisfies RuntimeIpcError;
		}
		return task;
	}

	private enqueueA2ATask(task: A2ATask, message: A2AMessage, from: string | undefined): Promise<void> {
		const state = this.getA2AState();
		const run = async () => {
			if (isTaskCanceled(task)) {
				return;
			}
			await this.runtime.session.agent.waitForIdle();
			if (isTaskCanceled(task)) {
				return;
			}
			state.activeTaskId = task.id;
			task.status = {
				state: "working",
				message: createA2AAgentMessage(task, "Working on the requested message."),
				timestamp: new Date().toISOString(),
			};
			appendTaskHistory(task, task.status.message);
			try {
				const before = this.runtime.getSnapshot();
				await this.runtime.session.prompt(formatInboundA2AMessage(message, from), { source: "extension" });
				if (task.status.state === "canceled") {
					return;
				}
				const after = this.runtime.getSnapshot();
				const result = extractNewAssistantText(before, after);
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
			} finally {
				if (state.activeTaskId === task.id) {
					state.activeTaskId = undefined;
				}
			}
		};
		state.queue = state.queue.then(run, run);
		return state.queue;
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
	const source = from ? ` from peer agent "${from}"` : "";
	return [`[A2A message${source}]`, messageText(message)].join("\n\n");
}

function extractNewAssistantText(before: AgentRuntimeSnapshot, after: AgentRuntimeSnapshot): string {
	const beforeIds = new Set(before.transcript.entries.map((entry) => entry.id));
	const messages: string[] = [];
	for (const entry of after.transcript.entries) {
		if (beforeIds.has(entry.id) || entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}
		const { content } = entry.message;
		const text =
			typeof content === "string"
				? content
				: content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("");
		if (text.trim().length > 0) {
			messages.push(text);
		}
	}
	return messages.length > 0 ? messages.join("\n\n") : "(No assistant reply was recorded.)";
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
