import type { AgentMessage } from "@earendil-works/pi-agent-core";
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

	it("serves new session and compact requests", async () => {
		const { clientTransport, serverTransport } = createTransportPair();
		const runtime = createFakeRuntime(snapshot(1, "idle"));
		createRuntimeIpcServer(runtime.host, serverTransport);
		const client = createIpcRuntimeClient(clientTransport, snapshot(0, "idle"));

		await expect(client.newSession()).resolves.toEqual({ cancelled: false });
		expect(runtime.newSession).toHaveBeenCalledTimes(1);

		await expect(client.compact("keep decisions")).resolves.toEqual({ summary: "compacted" });
		expect(runtime.compact).toHaveBeenCalledWith("keep decisions");
		client.close();
	});

	it("serves monitor stop requests", async () => {
		const { clientTransport, serverTransport } = createTransportPair();
		const runtime = createFakeRuntime(snapshot(1, "idle"));
		createRuntimeIpcServer(runtime.host, serverTransport);
		const client = createIpcRuntimeClient(clientTransport, snapshot(0, "idle"));

		await expect(client.stopMonitor("m_123")).resolves.toBe(true);
		expect(runtime.stopMonitor).toHaveBeenCalledWith("m_123");
		client.close();
	});

	it("serves local A2A message/send and tasks/get", async () => {
		const { clientTransport, serverTransport } = createTransportPair();
		const runtime = createFakeRuntime(snapshot(1, "idle"));
		runtime.prompt.mockImplementation(async () => {
			runtime.currentSnapshot = snapshot(2, "idle", {
				entries: [
					{
						id: "assistant-1",
						parentId: null,
						type: "message",
						timestamp: new Date().toISOString(),
						message: {
							role: "assistant",
							content: [{ type: "text", text: "backend answer" }],
						} as unknown as AgentMessage,
					},
				],
			});
		});
		createRuntimeIpcServer(runtime.host, serverTransport);
		const client = createIpcRuntimeClient(clientTransport, snapshot(0, "idle"));

		const task = await client.a2aSendMessage({
			message: {
				kind: "message",
				messageId: "msg-1",
				role: "user",
				parts: [{ kind: "text", text: "hello" }],
			},
			configuration: { blocking: true },
		});

		expect(task.status.state).toBe("completed");
		expect(task.artifacts?.[0]?.parts[0]).toEqual({ kind: "text", text: "backend answer" });
		expect(task.history).toBeUndefined();
		expect(task.metadata).toMatchObject({ historyOmitted: true, historyLength: 3 });
		const fetched = await client.a2aGetTask({ id: task.id });
		expect(fetched).toMatchObject({
			id: task.id,
			status: { state: "completed" },
			metadata: expect.objectContaining({ historyOmitted: true, historyLength: 3 }),
		});
		expect(fetched.history).toBeUndefined();
		await expect(client.a2aGetTask({ id: task.id, historyLength: 1 })).resolves.toMatchObject({
			id: task.id,
			history: [{ role: "agent" }],
		});
		client.close();
	});

	it("queues local A2A tasks and cancels submitted tasks without aborting the active prompt", async () => {
		const { clientTransport, serverTransport } = createTransportPair();
		const runtime = createFakeRuntime(snapshot(1, "idle"));
		let releasePrompt: (() => void) | undefined;
		runtime.prompt.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					releasePrompt = resolve;
				}),
		);
		createRuntimeIpcServer(runtime.host, serverTransport);
		const client = createIpcRuntimeClient(clientTransport, snapshot(0, "idle"));

		const first = await client.a2aSendMessage({
			message: {
				kind: "message",
				messageId: "msg-1",
				role: "user",
				parts: [{ kind: "text", text: "first" }],
			},
			configuration: { blocking: false },
		});
		const second = await client.a2aSendMessage({
			message: {
				kind: "message",
				messageId: "msg-2",
				role: "user",
				parts: [{ kind: "text", text: "second" }],
			},
			configuration: { blocking: false },
		});

		await tick();
		expect(runtime.prompt).toHaveBeenCalledTimes(1);
		await expect(client.a2aGetTask({ id: first.id })).resolves.toMatchObject({ status: { state: "working" } });
		await expect(client.a2aGetTask({ id: second.id })).resolves.toMatchObject({ status: { state: "submitted" } });

		const canceled = await client.a2aCancelTask({ id: second.id });
		expect(canceled.status.state).toBe("canceled");
		expect(runtime.abort).not.toHaveBeenCalled();

		releasePrompt?.();
		await tick();
		client.close();
	});

	it("does not block on queued local A2A tasks even when blocking is true", async () => {
		const { clientTransport, serverTransport } = createTransportPair();
		const runtime = createFakeRuntime(snapshot(1, "idle"));
		let releasePrompt: (() => void) | undefined;
		runtime.prompt.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					releasePrompt = resolve;
				}),
		);
		createRuntimeIpcServer(runtime.host, serverTransport);
		const client = createIpcRuntimeClient(clientTransport, snapshot(0, "idle"));

		const first = await client.a2aSendMessage({
			message: {
				kind: "message",
				messageId: "msg-1",
				role: "user",
				parts: [{ kind: "text", text: "first" }],
			},
			configuration: { blocking: false },
		});
		await tick();
		await expect(client.a2aGetTask({ id: first.id })).resolves.toMatchObject({ status: { state: "working" } });

		const second = await client.a2aSendMessage({
			message: {
				kind: "message",
				messageId: "msg-2",
				role: "user",
				parts: [{ kind: "text", text: "second" }],
			},
			configuration: { blocking: true },
		});

		expect(second.status.state).toBe("submitted");
		expect(runtime.prompt).toHaveBeenCalledTimes(1);

		releasePrompt?.();
		await tick();
		client.close();
	});

	it("returns an IPC error for unknown local A2A tasks", async () => {
		const { clientTransport, serverTransport } = createTransportPair();
		const runtime = createFakeRuntime(snapshot(1, "idle"));
		createRuntimeIpcServer(runtime.host, serverTransport);
		const client = createIpcRuntimeClient(clientTransport, snapshot(0, "idle"));

		await expect(client.a2aGetTask({ id: "missing" })).rejects.toThrow("Task not found: missing");
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
	newSession: ReturnType<typeof vi.fn>;
	compact: ReturnType<typeof vi.fn>;
	stopMonitor: ReturnType<typeof vi.fn>;
	abort: ReturnType<typeof vi.fn>;
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
		abort: vi.fn(async () => {}),
		executeExtensionCommand: vi.fn(async () => true),
		newSession: vi.fn(async () => ({ cancelled: false })),
		compact: vi.fn(async () => ({ summary: "compacted" })),
		stopMonitor: vi.fn(() => ({ id: "m_123" })),
	};

	return {
		host: {
			getSnapshot: () => fake.currentSnapshot,
			attachRuntime: fake.attachRuntime,
			newSession: fake.newSession,
			session: {
				prompt: fake.prompt,
				abort: fake.abort,
				compact: fake.compact,
				stopMonitor: fake.stopMonitor,
				agent: { waitForIdle: vi.fn(async () => {}) },
				executeExtensionCommand: fake.executeExtensionCommand,
			},
		} as unknown as AgentSessionRuntime,
		attachRuntime: fake.attachRuntime,
		prompt: fake.prompt,
		abort: fake.abort,
		executeExtensionCommand: fake.executeExtensionCommand,
		newSession: fake.newSession,
		compact: fake.compact,
		stopMonitor: fake.stopMonitor,
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
	options: { sessionName?: string; entries?: AgentRuntimeSnapshot["transcript"]["entries"] } = {},
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
			entries: options.entries ?? [],
			currentLeafId: null,
		},
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
