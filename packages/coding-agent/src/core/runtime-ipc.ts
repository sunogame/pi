import type { AgentRuntimeAttachResult, AgentRuntimeEvent, AgentRuntimeSnapshot } from "./agent-runtime-snapshot.ts";
import type { PromptOptions } from "./agent-session.ts";

export type RuntimeIpcMethod =
	| "attach"
	| "detach"
	| "prompt"
	| "abort"
	| "waitForIdle"
	| "executeCommand"
	| "getSnapshot";

export type RuntimeIpcAttachResult = Omit<AgentRuntimeAttachResult, "unsubscribe">;

export type RuntimeIpcRequestParams = {
	attach: { lastSeenEventId?: number };
	detach: undefined;
	prompt: { text: string; options?: PromptOptions };
	abort: undefined;
	waitForIdle: undefined;
	executeCommand: { name: string; args: string };
	getSnapshot: undefined;
};

export type RuntimeIpcResult = {
	attach: RuntimeIpcAttachResult;
	detach: Record<string, never>;
	prompt: Record<string, never>;
	abort: Record<string, never>;
	waitForIdle: Record<string, never>;
	executeCommand: { handled: boolean };
	getSnapshot: { snapshot: AgentRuntimeSnapshot };
};

export type RuntimeIpcRequest<M extends RuntimeIpcMethod = RuntimeIpcMethod> = {
	id: string;
	method: M;
	params?: RuntimeIpcRequestParams[M];
};

export type RuntimeIpcErrorCode =
	| "unknown_method"
	| "invalid_params"
	| "unsupported"
	| "busy"
	| "aborted"
	| "runtime_error";

export type RuntimeIpcError = {
	code: RuntimeIpcErrorCode;
	message: string;
	details?: unknown;
};

export type RuntimeIpcResponse<M extends RuntimeIpcMethod = RuntimeIpcMethod> =
	| { id: string; ok: true; result: RuntimeIpcResult[M] }
	| { id: string; ok: false; error: RuntimeIpcError };

export type RuntimeIpcNotification =
	| { type: "runtime_event"; event: AgentRuntimeEvent }
	| { type: "shutdown"; reason?: string };

export class RuntimeIpcErrorResponse extends Error {
	readonly code: RuntimeIpcErrorCode;
	readonly details?: unknown;

	constructor(error: RuntimeIpcError) {
		super(error.message);
		this.name = "RuntimeIpcErrorResponse";
		this.code = error.code;
		this.details = error.details;
	}
}
