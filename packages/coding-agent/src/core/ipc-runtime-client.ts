import type {
	AgentRuntimeAttachResult,
	AgentRuntimeEvent,
	AgentRuntimeSnapshot,
	TranscriptPageBeforeParams,
	TranscriptPageBeforeResult,
} from "./agent-runtime-snapshot.ts";
import type { PromptOptions } from "./agent-session.ts";
import { serializeJsonLine } from "./jsonl.ts";
import type { A2AMessageSendParams, A2ATask, A2ATaskIdParams, A2ATaskQueryParams } from "./local-a2a.ts";
import {
	AgentRuntimeStore,
	type RuntimeClient,
	type RuntimeClientAttachOptions,
	type RuntimeCompactionResult,
} from "./runtime-client.ts";
import {
	RuntimeIpcErrorResponse,
	type RuntimeIpcMethod,
	type RuntimeIpcNotification,
	type RuntimeIpcRequest,
	type RuntimeIpcRequestParams,
	type RuntimeIpcResponse,
	type RuntimeIpcResult,
} from "./runtime-ipc.ts";
import type { RuntimeTransport } from "./runtime-transport.ts";

type PendingRequest<M extends RuntimeIpcMethod = RuntimeIpcMethod> = {
	resolve: (result: RuntimeIpcResult[M]) => void;
	reject: (error: Error) => void;
};

export class IpcRuntimeClient implements RuntimeClient {
	readonly store: AgentRuntimeStore;
	private readonly transport: RuntimeTransport;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly unsubscribeTransport: () => void;
	private readonly unsubscribeTransportClose: () => void;
	private requestId = 0;
	private liveListener?: (event: AgentRuntimeEvent) => void;
	private attachInbox: AgentRuntimeEvent[] | undefined;
	private maxTranscriptBytes: number | undefined;
	private maxTranscriptEntries: number | undefined;
	private closed = false;

	constructor(transport: RuntimeTransport, initialSnapshot: AgentRuntimeSnapshot) {
		this.transport = transport;
		this.store = new AgentRuntimeStore(initialSnapshot);
		this.unsubscribeTransport = transport.onLine((line) => this.handleLine(line));
		this.unsubscribeTransportClose = transport.onClose(() => this.close());
	}

	async attach(options: RuntimeClientAttachOptions = {}): Promise<AgentRuntimeAttachResult> {
		this.liveListener = options.listener;
		this.attachInbox = [];
		this.maxTranscriptBytes = options.maxTranscriptBytes;
		this.maxTranscriptEntries = options.maxTranscriptEntries;
		const lastSeenEventId = options.lastSeenEventId ?? this.store.lastAppliedEventId;
		const result = await this.request("attach", {
			lastSeenEventId,
			maxTranscriptBytes: options.maxTranscriptBytes,
			maxTranscriptEntries: options.maxTranscriptEntries,
		});
		const inbox = this.attachInbox;

		const replayRequiresSnapshot = result.initialEvents.some(
			(event) => event.type === "session_changed" || event.type === "transcript_changed",
		);
		if (!result.initialEventsComplete || options.lastSeenEventId === undefined || replayRequiresSnapshot) {
			this.store.replaceFrom(result.snapshot);
		} else {
			for (const event of result.initialEvents) {
				this.applyRuntimeEvent(event);
			}
		}

		this.attachInbox = undefined;
		for (const event of inbox) {
			this.applyRuntimeEvent(event);
		}

		return {
			...result,
			unsubscribe: () => this.detach(),
		};
	}

	detach(): void {
		this.liveListener = undefined;
		this.attachInbox = undefined;
		void this.request("detach", undefined).catch(() => {});
	}

	onClose(cb: () => void): () => void {
		return this.transport.onClose(cb);
	}

	async prompt(text: string, options?: PromptOptions): Promise<void> {
		await this.request("prompt", { text, options });
	}

	async abort(): Promise<void> {
		await this.request("abort", undefined);
	}

	async waitForIdle(): Promise<void> {
		await this.request("waitForIdle", undefined);
	}

	async executeCommand(name: string, args: string): Promise<boolean> {
		const result = await this.request("executeCommand", { name, args });
		await this.refreshFromRuntime();
		return result.handled;
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		await this.request("setModel", { provider, modelId });
		await this.refreshFromRuntime();
	}

	async newSession(): Promise<{ cancelled: boolean }> {
		const result = await this.request("newSession", undefined);
		await this.refreshFromRuntime();
		return result;
	}

	async compact(customInstructions?: string): Promise<RuntimeCompactionResult> {
		const result = await this.request("compact", { customInstructions });
		await this.refreshFromRuntime();
		return result.result as RuntimeCompactionResult;
	}

	async reload(): Promise<void> {
		await this.request("reload", undefined);
		await this.refreshFromRuntime();
	}

	async stopMonitor(id: string): Promise<boolean> {
		const result = await this.request("stopMonitor", { id });
		await this.refreshFromRuntime();
		return result.stopped;
	}

	async loadTranscriptBefore(options: TranscriptPageBeforeParams = {}): Promise<TranscriptPageBeforeResult> {
		const page = await this.request("transcript/getBefore", options);
		this.store.prependTranscriptPage(page);
		return page;
	}

	async shutdown(): Promise<void> {
		await this.request("shutdown", undefined);
	}

	async a2aSendMessage(params: Omit<A2AMessageSendParams, "to">): Promise<A2ATask> {
		const result = await this.request("a2a/message/send", params);
		return result.task;
	}

	async a2aGetTask(params: A2ATaskQueryParams): Promise<A2ATask> {
		const result = await this.request("a2a/tasks/get", params);
		return result.task;
	}

	async a2aCancelTask(params: A2ATaskIdParams): Promise<A2ATask> {
		const result = await this.request("a2a/tasks/cancel", params);
		return result.task;
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.unsubscribeTransport();
		this.unsubscribeTransportClose();
		this.transport.close();
		for (const pending of this.pending.values()) {
			pending.reject(new Error("Runtime IPC client closed"));
		}
		this.pending.clear();
	}

	private async refreshFromRuntime(): Promise<void> {
		const params =
			this.maxTranscriptBytes === undefined && this.maxTranscriptEntries === undefined
				? undefined
				: {
						maxTranscriptBytes: this.maxTranscriptBytes,
						maxTranscriptEntries: this.maxTranscriptEntries,
					};
		const result = await this.request("getSnapshot", params);
		this.store.replaceFrom(result.snapshot);
	}

	private applyRuntimeEvent(event: AgentRuntimeEvent): void {
		const applied = this.store.apply(event);
		if (!applied) {
			return;
		}
		this.liveListener?.(event);
		if (event.type === "session_changed" || event.type === "transcript_changed") {
			void this.refreshFromRuntime().catch(() => {});
		}
	}

	private async request<M extends RuntimeIpcMethod>(
		method: M,
		params: RuntimeIpcRequestParams[M],
	): Promise<RuntimeIpcResult[M]> {
		if (this.closed) {
			throw new Error("Runtime IPC client closed");
		}
		const id = String(++this.requestId);
		const request: RuntimeIpcRequest<M> = params === undefined ? { id, method } : { id, method, params };
		const promise = new Promise<RuntimeIpcResult[M]>((resolve, reject) => {
			this.pending.set(id, { resolve, reject } as PendingRequest);
		});
		try {
			await this.transport.send(serializeJsonLine(request));
		} catch (error) {
			this.pending.delete(id);
			throw error;
		}
		return promise;
	}

	private handleLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line) as unknown;
		} catch {
			return;
		}

		if (isRuntimeIpcNotification(message)) {
			this.handleNotification(message);
			return;
		}

		if (isRuntimeIpcResponse(message)) {
			const pending = this.pending.get(message.id);
			if (!pending) {
				return;
			}
			this.pending.delete(message.id);
			if (message.ok) {
				pending.resolve(message.result);
			} else {
				pending.reject(new RuntimeIpcErrorResponse(message.error));
			}
		}
	}

	private handleNotification(message: RuntimeIpcNotification): void {
		switch (message.type) {
			case "runtime_event":
				if (this.attachInbox) {
					this.attachInbox.push(message.event);
				} else {
					this.applyRuntimeEvent(message.event);
				}
				break;
			case "shutdown":
				this.close();
				break;
		}
	}
}

export function createIpcRuntimeClient(
	transport: RuntimeTransport,
	initialSnapshot: AgentRuntimeSnapshot,
): IpcRuntimeClient {
	return new IpcRuntimeClient(transport, initialSnapshot);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isRuntimeIpcResponse(value: unknown): value is RuntimeIpcResponse {
	return isRecord(value) && typeof value.id === "string" && typeof value.ok === "boolean";
}

function isRuntimeIpcNotification(value: unknown): value is RuntimeIpcNotification {
	return isRecord(value) && (value.type === "runtime_event" || value.type === "shutdown");
}
