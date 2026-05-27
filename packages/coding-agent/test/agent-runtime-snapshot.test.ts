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
		expect(snapshot.agent.cwd).toBe(tempDir);
		expect(snapshot.agent.status).toBe("idle");
		expect(snapshot.session.sessionId).toBe(runtimeHost.session.sessionId);
		expect(snapshot.session.sessionDir).toBe(runtimeHost.session.sessionManager.getSessionDir());
		expect(snapshot.transcript.entries.every((entry) => entry.type !== "message")).toBe(true);
		expect(snapshot.run.isStreaming).toBe(false);
		expect(snapshot.run.pendingUserMessages).toEqual([]);
		expect(snapshot.tools.active.length).toBeGreaterThan(0);
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
		expect(events.at(-1)?.id).toBe(events.length);

		const snapshot = runtimeHost.getSnapshot();
		expect(snapshot.transcript.entries.length).toBeGreaterThanOrEqual(2);
		expect(snapshot.agent.status).toBe("idle");
	});
});
