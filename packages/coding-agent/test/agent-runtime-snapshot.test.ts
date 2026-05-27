import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRuntimeEvent } from "../src/core/agent-runtime-snapshot.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import { createInProcessRuntimeClient } from "../src/core/runtime-client.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("Agent runtime snapshot", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost() {
		const tempDir = join(tmpdir(), `pi-runtime-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("hello from runtime")]);

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

		return { runtimeHost, tempDir };
	}

	it("returns a semantic snapshot for the current session", async () => {
		const { runtimeHost, tempDir } = await createRuntimeHost();

		const snapshot = runtimeHost.getSnapshot();

		expect(snapshot.protocolVersion).toBe(1);
		expect(snapshot.capabilities).toContain("event_replay");
		expect(snapshot.capabilities).toContain("extension_events");
		expect(snapshot.eventCursor).toBe(0);
		expect(snapshot.agent.agentId).toBe("backend");
		expect(snapshot.agent.agentLabel).toBe("Backend");
		expect(snapshot.agent.cwd).toBe(tempDir);
		expect(snapshot.agent.status).toBe("idle");
		expect(snapshot.session.sessionId).toBe(runtimeHost.session.sessionId);
		expect(snapshot.agent.agentId).not.toBe(snapshot.session.sessionId);
		expect(snapshot.session.sessionDir).toBe(runtimeHost.session.sessionManager.getSessionDir());
		expect(snapshot.transcript.entries.every((entry) => entry.type !== "message")).toBe(true);
		expect(snapshot.run.isStreaming).toBe(false);
		expect(snapshot.run.isBashRunning).toBe(false);
		expect(snapshot.run.streamingMessage).toBeUndefined();
		expect(snapshot.run.pendingApprovals).toEqual([]);
		expect(snapshot.run.pendingUserMessages).toEqual([]);
		expect(snapshot.tools.active.length).toBeGreaterThan(0);
		expect(snapshot.resources.skills).toEqual([]);
		expect(snapshot.resources.promptTemplates).toEqual([]);
		expect(snapshot.config.autoCompaction).toBeTypeOf("boolean");
		expect(snapshot.config.steeringMode).toBe("one-at-a-time");
	});

	it("projects session events into attach protocol events", async () => {
		const { runtimeHost } = await createRuntimeHost();
		const events: AgentRuntimeEvent[] = [];
		const unsubscribe = runtimeHost.subscribeRuntimeEvents((event) => {
			events.push(event);
		});

		await runtimeHost.session.prompt("hello");
		unsubscribe();

		expect(events.map((event) => event.type)).toContain("status_changed");
		expect(events.map((event) => event.type)).toContain("message_start");
		expect(events.map((event) => event.type)).toContain("message_end");
		expect(events.map((event) => event.type)).toContain("transcript_changed");
		expect(events.at(-1)?.id).toBe(events.length);
		expect(runtimeHost.getSnapshot().eventCursor).toBe(events.at(-1)?.id);
		expect(runtimeHost.getRuntimeEventsAfter(0).map((event) => event.id)).toEqual(events.map((event) => event.id));
		const attachResult = runtimeHost.attachRuntime({ lastSeenEventId: 0 });
		expect(attachResult.initialEvents.map((event) => event.id)).toEqual(events.map((event) => event.id));
		expect(attachResult.initialEventsComplete).toBe(true);
		attachResult.unsubscribe();

		const snapshot = runtimeHost.getSnapshot();
		expect(snapshot.transcript.entries.length).toBeGreaterThanOrEqual(2);
		expect(snapshot.agent.status).toBe("idle");
	});

	it("emits namespaced extension runtime events", async () => {
		const { runtimeHost } = await createRuntimeHost();
		const events: AgentRuntimeEvent[] = [];
		const unsubscribe = runtimeHost.subscribeRuntimeEvents((event) => {
			events.push(event);
		});

		runtimeHost.emitExtensionRuntimeEvent("example.widget", { count: 1 });
		unsubscribe();

		expect(events).toEqual([
			{
				id: 1,
				type: "extension_event",
				namespace: "example.widget",
				payload: { count: 1 },
			},
		]);
	});

	it("dedupes attach events in the in-process runtime client", async () => {
		const { runtimeHost } = await createRuntimeHost();
		const client = createInProcessRuntimeClient(runtimeHost);
		const liveEvents: AgentRuntimeEvent[] = [];

		const attachResult = await client.attach({
			listener: (event) => liveEvents.push(event),
		});
		runtimeHost.emitExtensionRuntimeEvent("example.widget", { count: 1 });

		expect(client.store.snapshot.eventCursor).toBe(1);
		expect(client.store.lastAppliedEventId).toBe(1);
		expect(liveEvents).toHaveLength(1);
		expect(client.store.apply(liveEvents[0])).toBe(false);
		expect(client.store.lastAppliedEventId).toBe(1);

		attachResult.unsubscribe();
	});

	it("refreshes the in-process client store after commands", async () => {
		const { runtimeHost } = await createRuntimeHost();
		const client = createInProcessRuntimeClient(runtimeHost);
		await client.attach();

		await client.prompt("hello");

		expect(client.store.snapshot.agent.status).toBe("idle");
		expect(client.store.snapshot.run.isStreaming).toBe(false);
		expect(client.store.snapshot.transcript.entries.filter((entry) => entry.type === "message")).toHaveLength(2);
		expect(client.store.snapshot.transcript.entries.at(-1)?.type).toBe("message");
	});

	it("refreshes the in-process client store after live transcript changes", async () => {
		const { runtimeHost } = await createRuntimeHost();
		const client = createInProcessRuntimeClient(runtimeHost);
		await client.attach();

		await runtimeHost.session.prompt("hello");

		expect(client.store.snapshot.transcript.entries.filter((entry) => entry.type === "message")).toHaveLength(2);
	});

	it("binds and unbinds extension UI through the in-process runtime client", async () => {
		const { runtimeHost } = await createRuntimeHost();
		const client = createInProcessRuntimeClient(runtimeHost);
		const uiContext = {
			confirm: async () => true,
		} as unknown as ExtensionUIContext;

		await client.bindUI({ uiContext });
		expect(runtimeHost.session.extensionRunner.hasUI()).toBe(true);

		await client.unbindUI();
		expect(runtimeHost.session.extensionRunner.hasUI()).toBe(false);
	});

	it("loads the session tree lazily through the in-process runtime client", async () => {
		const { runtimeHost } = await createRuntimeHost();
		const client = createInProcessRuntimeClient(runtimeHost);

		await client.prompt("hello");

		const tree = await client.getSessionTree();
		expect(tree.length).toBe(1);
		const stack = [...tree];
		let messageCount = 0;
		while (stack.length > 0) {
			const node = stack.pop()!;
			if (node.entry.type === "message") {
				messageCount += 1;
			}
			stack.push(...node.children);
		}
		expect(messageCount).toBe(2);
	});
});
