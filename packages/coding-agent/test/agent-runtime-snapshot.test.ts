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
import type { ExtensionFactory, ExtensionUIContext, RuntimeExtensionAPI } from "../src/core/extensions/index.ts";
import { createInProcessRuntimeClient } from "../src/core/runtime-client.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("Agent runtime snapshot", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(options: { extensionFactories?: ExtensionFactory[] } = {}) {
		const tempDir = join(tmpdir(), `pi-runtime-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage("hello from runtime"),
			fauxAssistantMessage("monitor event observed"),
			fauxAssistantMessage("monitor completed observed"),
		]);

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
				extensionFactories: options.extensionFactories,
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
		expect(snapshot.capabilities).toContain("a2a");
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
		expect(snapshot.tools.active).toContain("monitor");
		expect(snapshot.resources.skills).toEqual([]);
		expect(snapshot.resources.promptTemplates).toEqual([]);
		expect(snapshot.config.autoCompaction).toBeTypeOf("boolean");
		expect(snapshot.config.steeringMode).toBe("one-at-a-time");
		expect(snapshot.config.availableThinkingLevels).toContain("off");
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

	it("delivers transcript_changed to in-process store subscribers", async () => {
		const { runtimeHost } = await createRuntimeHost();
		const client = createInProcessRuntimeClient(runtimeHost);
		const events: AgentRuntimeEvent[] = [];
		client.store.subscribe((_snapshot, event) => {
			if (event) {
				events.push(event);
			}
		});
		await client.attach();

		await runtimeHost.session.prompt("hello");

		expect(events.some((event) => event.type === "transcript_changed")).toBe(true);
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

	it("snapshots and executes runtime extension commands through the runtime client", async () => {
		const calls: string[] = [];
		const commandExtension = ((pi: RuntimeExtensionAPI) => {
			pi.runtime.registerCommand("mark", {
				description: "Mark from test",
				handler: async (args) => {
					calls.push(args);
				},
			});
		}) as unknown as ExtensionFactory & { placement: "runtime" };
		commandExtension.placement = "runtime";
		const legacyExtension = ((pi) => {
			pi.registerCommand("legacy-mark", {
				handler: async () => {},
			});
		}) satisfies ExtensionFactory;
		const { runtimeHost } = await createRuntimeHost({ extensionFactories: [commandExtension, legacyExtension] });
		const client = createInProcessRuntimeClient(runtimeHost);

		expect(client.store.snapshot.commands.map((command) => [command.name, command.placement])).toEqual([
			["mark", "runtime"],
			["legacy-mark", "legacy"],
		]);
		await expect(client.executeCommand("mark", "hello")).resolves.toBe(true);
		await expect(client.executeCommand("missing", "")).resolves.toBe(false);
		expect(calls).toEqual(["hello"]);
	});

	it("emits commands_changed when runtime commands are rebuilt", async () => {
		const commandExtension = ((pi: RuntimeExtensionAPI) => {
			pi.runtime.registerCommand("mark", { handler: async () => {} });
		}) as unknown as ExtensionFactory & { placement: "runtime" };
		commandExtension.placement = "runtime";
		const { runtimeHost } = await createRuntimeHost({ extensionFactories: [commandExtension] });
		const events: AgentRuntimeEvent[] = [];
		const unsubscribe = runtimeHost.subscribeRuntimeEvents((event) => {
			events.push(event);
		});

		await runtimeHost.session.reload();
		unsubscribe();

		expect(events.some((event) => event.type === "commands_changed")).toBe(true);
		expect(events.find((event) => event.type === "commands_changed")).toMatchObject({
			type: "commands_changed",
			commands: [{ name: "mark", placement: "runtime" }],
		});
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

	it("projects monitor events and runtime notifications", async () => {
		const { runtimeHost } = await createRuntimeHost();
		const client = createInProcessRuntimeClient(runtimeHost);
		const events: AgentRuntimeEvent[] = [];
		client.store.subscribe((_snapshot, event) => {
			if (event) {
				events.push(event);
			}
		});
		await client.attach();

		const monitorTool = runtimeHost.session.getToolDefinition("monitor");
		expect(monitorTool).toBeDefined();
		await monitorTool?.execute(
			"monitor-call",
			{
				command: "printf 'alpha\\nbeta\\n'",
				description: "test monitor",
				timeoutSeconds: 2,
			},
			undefined,
			undefined,
			{} as never,
		);

		await waitFor(() =>
			client.store.snapshot.monitors.recent.some((monitor) => monitor.description === "test monitor"),
		);
		await waitFor(() => client.store.snapshot.run.pendingNotifications.length === 0);
		await waitFor(() =>
			client.store.snapshot.transcript.entries.some(
				(entry) => entry.type === "custom_message" && entry.customType === "monitor-notification",
			),
		);

		expect(events.map((event) => event.type)).toContain("monitor_started");
		expect(events.map((event) => event.type)).toContain("monitor_output");
		expect(events.map((event) => event.type)).toContain("monitor_ended");
		expect(events.map((event) => event.type)).toContain("notification_queued");
		expect(events.map((event) => event.type)).toContain("notification_delivered");
		expect(client.store.snapshot.monitors.recent[0]?.lineCount).toBe(2);
		expect(
			client.store.snapshot.transcript.entries.some(
				(entry) => entry.type === "custom_message" && entry.customType === "monitor-notification",
			),
		).toBe(true);
	});

	it("projects A2A task status events", async () => {
		const { runtimeHost } = await createRuntimeHost();
		const client = createInProcessRuntimeClient(runtimeHost);
		const events: AgentRuntimeEvent[] = [];
		client.store.subscribe((_snapshot, event) => {
			if (event) {
				events.push(event);
			}
		});
		await client.attach();

		runtimeHost.emitA2ATaskChanged({
			id: "task-1",
			contextId: "context-1",
			owner: "backend",
			state: "completed",
			timestamp: "2026-05-28T00:00:00.000Z",
		});

		expect(events).toContainEqual(
			expect.objectContaining({
				type: "a2a_task_changed",
				task: expect.objectContaining({ id: "task-1", state: "completed" }),
			}),
		);
		expect(client.store.snapshot.eventCursor).toBe(events.at(-1)?.id);
	});
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
