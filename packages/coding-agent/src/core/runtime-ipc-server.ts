import type { PromptOptions } from "./agent-session.ts";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import { serializeJsonLine } from "./jsonl.ts";
import type {
	RuntimeIpcError,
	RuntimeIpcMethod,
	RuntimeIpcNotification,
	RuntimeIpcRequest,
	RuntimeIpcResponse,
	RuntimeIpcResult,
} from "./runtime-ipc.ts";
import type { RuntimeTransport } from "./runtime-transport.ts";

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
			case "getSnapshot":
				return { snapshot: this.runtime.getSnapshot() };
			case "shutdown":
				setTimeout(() => this.onShutdown?.(), 0);
				return {};
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
