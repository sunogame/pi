import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createIpcRuntimeClient } from "../src/core/ipc-runtime-client.ts";
import { createRuntimeIpcServer } from "../src/core/runtime-ipc-server.ts";
import type { RuntimeTransport } from "../src/core/runtime-transport.ts";
import { SessionManager } from "../src/core/session-manager.ts";

class MemoryRuntimeTransport implements RuntimeTransport {
	peer?: MemoryRuntimeTransport;
	private readonly listeners = new Set<(line: string) => void>();
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

	close(): void {
		this.closed = true;
		this.listeners.clear();
	}

	private emit(line: string): void {
		for (const listener of this.listeners) {
			listener(line);
		}
	}
}

const cleanups: Array<() => Promise<void> | void> = [];

describe("runtime IPC e2e", () => {
	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("attaches to a real runtime and sends a prompt", async () => {
		const runtimeHost = await createRuntimeHost();
		const { clientTransport, serverTransport } = createTransportPair();
		const server = createRuntimeIpcServer(runtimeHost, serverTransport);
		const client = createIpcRuntimeClient(clientTransport, runtimeHost.getSnapshot());
		cleanups.push(() => {
			client.close();
			server.dispose();
		});

		await client.attach();
		await client.prompt("hello");
		await client.waitForIdle();
		await tick();

		expect(client.store.snapshot.transcript.entries.some((entry) => entry.type === "message")).toBe(true);
		expect(client.store.snapshot.agent.agentId).toBe("backend");
	});

	it("replays retained events and falls back to snapshot when the buffer is exceeded", async () => {
		const runtimeHost = await createRuntimeHost({ eventLogLimit: 2 });
		const retainedBase = runtimeHost.getSnapshot();

		runtimeHost.emitExtensionRuntimeEvent("test", { index: 1 });
		const retainedCursor = runtimeHost.getSnapshot().eventCursor;
		runtimeHost.emitExtensionRuntimeEvent("test", { index: 2 });
		runtimeHost.emitExtensionRuntimeEvent("test", { index: 3 });

		const retained = attachClient(runtimeHost, retainedBase);
		cleanups.push(retained.cleanup);
		const retainedAttach = await retained.client.attach({ lastSeenEventId: retainedCursor });
		expect(retainedAttach.initialEventsComplete).toBe(true);
		expect(retainedAttach.initialEvents.map((event) => event.id)).toEqual([retainedCursor + 1, retainedCursor + 2]);
		expect(retained.client.store.lastAppliedEventId).toBe(retainedCursor + 2);

		const staleBase = retainedBase;
		const stale = attachClient(runtimeHost, staleBase);
		cleanups.push(stale.cleanup);
		const staleAttach = await stale.client.attach({ lastSeenEventId: staleBase.eventCursor });
		expect(staleAttach.initialEventsComplete).toBe(false);
		expect(stale.client.store.snapshot.eventCursor).toBe(runtimeHost.getSnapshot().eventCursor);
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

function attachClient(
	runtimeHost: Awaited<ReturnType<typeof createRuntimeHost>>,
	initialSnapshot = runtimeHost.getSnapshot(),
) {
	const { clientTransport, serverTransport } = createTransportPair();
	const server = createRuntimeIpcServer(runtimeHost, serverTransport);
	const client = createIpcRuntimeClient(clientTransport, initialSnapshot);
	return {
		client,
		cleanup: () => {
			client.close();
			server.dispose();
		},
	};
}

async function createRuntimeHost(options: { eventLogLimit?: number } = {}) {
	const tempDir = join(tmpdir(), `pi-runtime-ipc-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("hello from ipc")]);

	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

	const runtimeOptions = {
		agentDir: tempDir,
		authStorage,
		model: faux.getModel(),
		resourceLoaderOptions: {
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		},
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			...runtimeOptions,
			cwd,
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtimeHost = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: SessionManager.create(tempDir),
		runtimeOptions: {
			identity: { agentId: "backend", agentLabel: "Backend" },
			eventLogLimit: options.eventLogLimit,
		},
	});
	await runtimeHost.session.bindExtensions({});

	cleanups.push(async () => {
		await runtimeHost.dispose();
		faux.unregister();
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
	return runtimeHost;
}

async function tick(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}
