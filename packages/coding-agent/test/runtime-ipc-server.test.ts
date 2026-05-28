import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeEvent, AgentRuntimeSnapshot } from "../src/core/agent-runtime-snapshot.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createIpcRuntimeClient } from "../src/core/ipc-runtime-client.ts";
import { createRuntimeIpcServer } from "../src/core/runtime-ipc-server.ts";
import type { RuntimeTransport } from "../src/core/runtime-transport.ts";

class MemoryRuntimeTransport implements RuntimeTransport {
	peer?: MemoryRuntimeTransport;
	private readonly listeners = new Set<(line: string) => void>();
	private readonly closeListeners = new Set<() => void>();
	private closed = false;

	async send(line: string): Promise<void> {
		if (!this.closed) {
			this.peer?.emit(line);
		}
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
		this.closed = true;
		this.listeners.clear();
		for (const listener of this.closeListeners) {
			listener();
		}
		this.closeListeners.clear();
	}

	private emit(line: string): void {
		for (const listener of this.listeners) {
			listener(line);
		}
	}
}

describe("RuntimeIpcServer", () => {
	it("serves attach, prompt, command, and runtime event notifications", async () => {
		const { clientTransport, serverTransport } = createTransportPair();
		const runtime = createFakeRuntime(snapshot(1, "idle"));
		const server = createRuntimeIpcServer(runtime.host, serverTransport);
		const client = createIpcRuntimeClient(clientTransport, snapshot(0, "idle"));

		await client.attach();
		expect(runtime.attachRuntime).toHaveBeenCalledWith({
			lastSeenEventId: 0,
			listener: expect.any(Function),
		});
		expect(client.store.snapshot.eventCursor).toBe(1);

		await client.prompt("hello");
		expect(runtime.prompt).toHaveBeenCalledWith("hello", undefined);

		await expect(client.executeCommand("mark", "arg")).resolves.toBe(true);
		expect(runtime.executeExtensionCommand).toHaveBeenCalledWith("mark", "arg");

		runtime.listener?.({ id: 2, type: "status_changed", status: "running" });
		await tick();
		expect(client.store.snapshot.agent.status).toBe("running");

		server.dispose();
		client.close();
	});

	it("supports getSnapshot for client resynchronization", async () => {
		const { clientTransport, serverTransport } = createTransportPair();
		const runtime = createFakeRuntime(snapshot(1, "idle"));
		createRuntimeIpcServer(runtime.host, serverTransport);
		const client = createIpcRuntimeClient(clientTransport, snapshot(1, "idle"));

		await client.attach({ lastSeenEventId: 1 });
		runtime.currentSnapshot = snapshot(2, "idle", { sessionName: "resynced" });
		runtime.listener?.({ id: 2, type: "transcript_changed", reason: "compaction" });
		await tick();
		await tick();

		expect(client.store.snapshot.session.sessionName).toBe("resynced");
	});

	it("detaches runtime listeners when the transport closes", async () => {
		const { clientTransport, serverTransport } = createTransportPair();
		const runtime = createFakeRuntime(snapshot(1, "idle"));
		createRuntimeIpcServer(runtime.host, serverTransport);
		const client = createIpcRuntimeClient(clientTransport, snapshot(0, "idle"));

		await client.attach();
		expect(runtime.listener).toBeDefined();

		serverTransport.close();

		expect(runtime.listener).toBeUndefined();
		client.close();
	});

	it("serves shutdown requests", async () => {
		const { clientTransport, serverTransport } = createTransportPair();
		const runtime = createFakeRuntime(snapshot(1, "idle"));
		const onShutdown = vi.fn();
		createRuntimeIpcServer(runtime.host, serverTransport, { onShutdown });
		const client = createIpcRuntimeClient(clientTransport, snapshot(0, "idle"));

		await client.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(onShutdown).toHaveBeenCalledTimes(1);
		client.close();
	});
});

function createTransportPair(): {
	clientTransport: MemoryRuntimeTransport;
	serverTransport: MemoryRuntimeTransport;
} {
	const clientTransport = new MemoryRuntimeTransport();
	const serverTransport = new MemoryRuntimeTransport();
	clientTransport.peer = serverTransport;
	serverTransport.peer = clientTransport;
	return { clientTransport, serverTransport };
}

function createFakeRuntime(initialSnapshot: AgentRuntimeSnapshot): {
	host: AgentSessionRuntime;
	attachRuntime: ReturnType<typeof vi.fn>;
	prompt: ReturnType<typeof vi.fn>;
	executeExtensionCommand: ReturnType<typeof vi.fn>;
	currentSnapshot: AgentRuntimeSnapshot;
	listener?: (event: AgentRuntimeEvent) => void;
} {
	const fake = {
		currentSnapshot: initialSnapshot,
		listener: undefined as ((event: AgentRuntimeEvent) => void) | undefined,
		attachRuntime: vi.fn((options?: { lastSeenEventId?: number; listener?: (event: AgentRuntimeEvent) => void }) => {
			fake.listener = options?.listener;
			return {
				snapshot: fake.currentSnapshot,
				initialEvents: [],
				initialEventsComplete: true,
				unsubscribe: () => {
					fake.listener = undefined;
				},
			};
		}),
		prompt: vi.fn(async () => {}),
		executeExtensionCommand: vi.fn(async () => true),
	};

	return {
		host: {
			getSnapshot: () => fake.currentSnapshot,
			attachRuntime: fake.attachRuntime,
			session: {
				prompt: fake.prompt,
				abort: vi.fn(async () => {}),
				agent: { waitForIdle: vi.fn(async () => {}) },
				executeExtensionCommand: fake.executeExtensionCommand,
			},
		} as unknown as AgentSessionRuntime,
		attachRuntime: fake.attachRuntime,
		prompt: fake.prompt,
		executeExtensionCommand: fake.executeExtensionCommand,
		get currentSnapshot() {
			return fake.currentSnapshot;
		},
		set currentSnapshot(snapshot: AgentRuntimeSnapshot) {
			fake.currentSnapshot = snapshot;
		},
		get listener() {
			return fake.listener;
		},
	};
}

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
