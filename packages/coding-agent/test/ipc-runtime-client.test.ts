import { describe, expect, it } from "vitest";
import type { AgentRuntimeEvent, AgentRuntimeSnapshot } from "../src/core/agent-runtime-snapshot.ts";
import { createIpcRuntimeClient } from "../src/core/ipc-runtime-client.ts";
import { RuntimeIpcErrorResponse, type RuntimeIpcRequest } from "../src/core/runtime-ipc.ts";
import type { RuntimeTransport } from "../src/core/runtime-transport.ts";

class MockRuntimeTransport implements RuntimeTransport {
	readonly sent: string[] = [];
	private readonly listeners = new Set<(line: string) => void>();
	private readonly closeListeners = new Set<() => void>();

	async send(line: string): Promise<void> {
		this.sent.push(line);
	}

	onLine(cb: (line: string) => void): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	onClose(cb: () => void): () => void {
		this.closeListeners.add(cb);
		return () => {
			this.closeListeners.delete(cb);
		};
	}

	close(): void {
		this.listeners.clear();
		for (const listener of this.closeListeners) {
			listener();
		}
		this.closeListeners.clear();
	}

	emit(value: unknown): void {
		const line = `${JSON.stringify(value)}\n`;
		for (const listener of this.listeners) {
			listener(line);
		}
	}

	lastRequest(): RuntimeIpcRequest {
		return JSON.parse(this.sent.at(-1) ?? "{}") as RuntimeIpcRequest;
	}
}

describe("IpcRuntimeClient", () => {
	it("attaches with request correlation and dedupes live events buffered during attach", async () => {
		const transport = new MockRuntimeTransport();
		const client = createIpcRuntimeClient(transport, snapshot(1, "idle"));
		const delivered: AgentRuntimeEvent[] = [];
		const event: AgentRuntimeEvent = { id: 2, type: "status_changed", status: "running" };

		const attach = client.attach({ lastSeenEventId: 1, listener: (runtimeEvent) => delivered.push(runtimeEvent) });
		const request = transport.lastRequest();
		expect(request).toMatchObject({ method: "attach", params: { lastSeenEventId: 1 } });

		transport.emit({ type: "runtime_event", event });
		expect(client.store.snapshot.agent.status).toBe("idle");

		transport.emit({
			id: request.id,
			ok: true,
			result: {
				snapshot: snapshot(2, "running"),
				initialEvents: [event],
				initialEventsComplete: true,
			},
		});
		await attach;

		expect(client.store.snapshot.agent.status).toBe("running");
		expect(delivered).toEqual([event]);
	});

	it("sends prompt commands and resolves responses", async () => {
		const transport = new MockRuntimeTransport();
		const client = createIpcRuntimeClient(transport, snapshot(1, "idle"));

		const prompt = client.prompt("hello");
		const request = transport.lastRequest();
		expect(request).toMatchObject({ method: "prompt", params: { text: "hello" } });

		transport.emit({ id: request.id, ok: true, result: {} });
		await expect(prompt).resolves.toBeUndefined();
	});

	it("rejects error responses with structured IPC errors", async () => {
		const transport = new MockRuntimeTransport();
		const client = createIpcRuntimeClient(transport, snapshot(1, "idle"));

		const prompt = client.prompt("hello");
		const request = transport.lastRequest();
		transport.emit({
			id: request.id,
			ok: false,
			error: { code: "unsupported", message: "not remote-safe" },
		});

		await expect(prompt).rejects.toBeInstanceOf(RuntimeIpcErrorResponse);
		await expect(prompt).rejects.toMatchObject({ code: "unsupported" });
	});

	it("refreshes the store after transcript_changed notifications", async () => {
		const transport = new MockRuntimeTransport();
		const client = createIpcRuntimeClient(transport, snapshot(1, "idle"));

		transport.emit({ type: "runtime_event", event: { id: 2, type: "transcript_changed", reason: "compaction" } });
		await tick();

		const request = transport.lastRequest();
		expect(request).toMatchObject({ method: "getSnapshot" });

		transport.emit({
			id: request.id,
			ok: true,
			result: { snapshot: snapshot(2, "idle", { sessionName: "compacted" }) },
		});
		await tick();

		expect(client.store.snapshot.session.sessionName).toBe("compacted");
	});
});

function snapshot(
	eventCursor: number,
	status: AgentRuntimeSnapshot["agent"]["status"],
	options: { sessionName?: string } = {},
): AgentRuntimeSnapshot {
	return {
		protocolVersion: 1,
		capabilities: ["event_replay", "extension_events", "runtime_commands", "prompt", "abort"],
		eventCursor,
		agent: {
			agentId: "backend",
			cwd: "/tmp/project",
			model: {},
			thinkingLevel: "off",
			status,
		},
		session: {
			sessionId: "session-1",
			sessionName: options.sessionName,
			sessionDir: "/tmp/project/.pi/sessions",
			currentLeafId: null,
		},
		transcript: {
			entries: [],
			currentLeafId: null,
		},
		run: {
			isStreaming: false,
			isBashRunning: false,
			retryAttempt: 0,
			pendingUserMessages: [],
			pendingApprovals: [],
			activeToolExecutions: [],
		},
		tools: { active: [], available: [] },
		resources: {
			skills: [],
			promptTemplates: [],
			themes: [],
			extensions: [],
			agentsFiles: [],
		},
		modelRegistry: { available: [] },
		diagnostics: { resources: [], extensions: [] },
		config: {
			autoCompaction: true,
			steeringMode: "all",
			followUpMode: "all",
			availableThinkingLevels: ["off"],
			scopedModels: [],
		},
		commands: [],
	};
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}
