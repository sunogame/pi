import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getDefaultRuntimeSocketPath,
	getRuntimeRegistryDir,
	getRuntimeRegistryPath,
	listRuntimeRegistryEntries,
	type RuntimeRegistryEntry,
	readRuntimeRegistryEntry,
	removeRuntimeRegistryEntry,
	sanitizeRuntimeId,
	writeRuntimeRegistryEntry,
} from "../src/core/runtime-registry.ts";

describe("runtime registry", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function createTempAgentDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-runtime-registry-"));
		tempDirs.push(dir);
		return dir;
	}

	function createEntry(agentDir: string, agentId = "backend"): RuntimeRegistryEntry {
		const socketPath = getDefaultRuntimeSocketPath(agentDir, agentId);
		mkdirSync(getRuntimeRegistryDir(agentDir), { recursive: true });
		writeFileSync(socketPath, "");
		return {
			agentId,
			socketPath,
			pid: process.pid,
			cwd: "/repo",
			sessionId: "session-1",
			status: "idle",
			protocolVersion: 1,
			capabilities: ["event_replay"],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		};
	}

	it("writes and reads live runtime entries", () => {
		const agentDir = createTempAgentDir();
		const entry = createEntry(agentDir);

		writeRuntimeRegistryEntry(agentDir, entry);

		expect(readRuntimeRegistryEntry(agentDir, "backend")).toEqual(entry);
	});

	it("removes stale entries", () => {
		const agentDir = createTempAgentDir();
		const entry = { ...createEntry(agentDir), pid: -1 };

		writeRuntimeRegistryEntry(agentDir, entry);

		expect(readRuntimeRegistryEntry(agentDir, "backend")).toBeUndefined();
		expect(readRuntimeRegistryEntry(agentDir, "backend")).toBeUndefined();
	});

	it("sanitizes runtime ids for registry and socket paths", () => {
		const agentDir = createTempAgentDir();

		expect(sanitizeRuntimeId("backend/api")).toBe("backend_api");
		expect(getRuntimeRegistryDir(agentDir)).toBe(join(agentDir, "runtimes"));
		expect(getRuntimeRegistryPath(agentDir, "backend/api")).toBe(join(agentDir, "runtimes", "backend_api.json"));
		expect(getDefaultRuntimeSocketPath(agentDir, "backend/api")).toBe(join(agentDir, "runtimes", "backend_api.sock"));
	});

	it("removes entries explicitly", () => {
		const agentDir = createTempAgentDir();
		writeRuntimeRegistryEntry(agentDir, createEntry(agentDir));

		removeRuntimeRegistryEntry(agentDir, "backend");

		expect(readRuntimeRegistryEntry(agentDir, "backend")).toBeUndefined();
	});

	it("lists live entries and removes stale entries", () => {
		const agentDir = createTempAgentDir();
		writeRuntimeRegistryEntry(agentDir, createEntry(agentDir, "qa"));
		writeRuntimeRegistryEntry(agentDir, { ...createEntry(agentDir, "backend"), pid: -1 });

		expect(listRuntimeRegistryEntries(agentDir).map((entry) => entry.agentId)).toEqual(["qa"]);
		expect(readRuntimeRegistryEntry(agentDir, "backend")).toBeUndefined();
	});
});
