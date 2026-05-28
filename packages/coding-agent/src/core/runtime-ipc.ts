import type { AgentRuntimeAttachResult, AgentRuntimeEvent, AgentRuntimeSnapshot } from "./agent-runtime-snapshot.ts";
import type { PromptOptions } from "./agent-session.ts";
import type { A2AMessageSendParams, A2ATask, A2ATaskIdParams, A2ATaskQueryParams } from "./local-a2a.ts";

export type RuntimeIpcMethod =
	| "attach"
	| "detach"
	| "prompt"
	| "abort"
	| "waitForIdle"
	| "executeCommand"
	| "newSession"
	| "compact"
	| "reload"
	| "stopMonitor"
	| "getSnapshot"
	| "shutdown"
	| "a2a/message/send"
	| "a2a/tasks/get"
	| "a2a/tasks/cancel";

export type RuntimeIpcAttachResult = Omit<AgentRuntimeAttachResult, "unsubscribe">;

export type RuntimeIpcRequestParams = {
	attach: { lastSeenEventId?: number };
	detach: undefined;
	prompt: { text: string; options?: PromptOptions };
	abort: undefined;
	waitForIdle: undefined;
	executeCommand: { name: string; args: string };
	newSession: undefined;
	compact: { customInstructions?: string };
	reload: undefined;
	stopMonitor: { id: string };
	getSnapshot: undefined;
	shutdown: undefined;
	"a2a/message/send": A2AMessageSendParams;
	"a2a/tasks/get": A2ATaskQueryParams;
	"a2a/tasks/cancel": A2ATaskIdParams;
};

export type RuntimeIpcResult = {
	attach: RuntimeIpcAttachResult;
	detach: Record<string, never>;
	prompt: Record<string, never>;
	abort: Record<string, never>;
	waitForIdle: Record<string, never>;
	executeCommand: { handled: boolean };
	newSession: { cancelled: boolean };
	compact: { result: unknown };
	reload: Record<string, never>;
	stopMonitor: { stopped: boolean };
	getSnapshot: { snapshot: AgentRuntimeSnapshot };
	shutdown: Record<string, never>;
	"a2a/message/send": { task: A2ATask };
	"a2a/tasks/get": { task: A2ATask };
	"a2a/tasks/cancel": { task: A2ATask };
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
