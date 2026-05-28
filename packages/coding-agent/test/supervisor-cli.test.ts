import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeRuntimeStateEntry } from "../src/core/runtime-registry.ts";
import {
	handleSupervisorCommand,
	runtimeSpecToStartOptions,
	validateSupervisorAgentCardNames,
} from "../src/supervisor-cli.ts";

describe("supervisor CLI", () => {
	it("converts runtime specs to runtime start options", () => {
		const options = runtimeSpecToStartOptions({
			id: "backend",
			cwd: "./backend",
			model: "sonnet",
			tools: ["read", "bash"],
			args: ["--no-skills"],
			socketPath: "/tmp/backend.sock",
		});

		expect(options.agentId).toBe("backend");
		expect(options.cwd).toMatch(/backend$/);
		expect(options.socketPath).toBe("/tmp/backend.sock");
		expect(options.runtimeArgs).toEqual(["--no-skills", "--continue", "--model", "sonnet", "--tools", "read,bash"]);
	});

	it("passes team config metadata to runtime processes", () => {
		const options = runtimeSpecToStartOptions(
			{
				id: "backend",
				cwd: "./backend",
			},
			"/work/.pi/runtimes.json",
		);

		expect(options.runtimeArgs).toEqual([
			"--continue",
			"--team-config",
			"/work/.pi/runtimes.json",
			"--team-member-name",
			"backend",
		]);
	});

	it("does not add default continue when runtime args already select a session", () => {
		const options = runtimeSpecToStartOptions({
			id: "backend",
			cwd: "./backend",
			args: ["--session", "abc123"],
		});

		expect(options.runtimeArgs).toEqual(["--session", "abc123"]);
	});

	it("uses the persisted runtime session file instead of default continue", ({ task }) => {
		const root = join("/tmp", `pi-supervisor-state-${task.id}`);
		const agentDir = join(root, ".pi");
		const sessionFile = join(root, "sessions", "current.jsonl");
		mkdirSync(join(root, "sessions"), { recursive: true });
		writeFileSync(sessionFile, "", "utf8");
		writeRuntimeStateEntry(agentDir, {
			agentId: "backend",
			cwd: root,
			sessionId: "current",
			sessionFile,
			updatedAt: new Date().toISOString(),
		});

		const options = runtimeSpecToStartOptions(
			{
				id: "backend",
				cwd: "./backend",
			},
			undefined,
			agentDir,
		);

		expect(options.runtimeArgs).toEqual(["--session", sessionFile]);
	});

	it("documents supervisor restart in help output", async () => {
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (message?: unknown) => {
			logs.push(String(message));
		};
		try {
			await expect(handleSupervisorCommand(["supervisor", "--help"])).resolves.toBe(true);
		} finally {
			console.log = originalLog;
		}

		expect(logs.join("\n")).toContain("supervisor restart");
	});

	it("rejects Agent Card names that do not match runtime ids", ({ task }) => {
		const root = join("/tmp", `pi-supervisor-${task.id}`);
		const backend = join(root, "backend");
		mkdirSync(backend, { recursive: true });
		writeFileSync(
			join(backend, "AGENTS.md"),
			`---
name: backend-srv
description: Backend.
---
`,
			"utf8",
		);

		expect(() =>
			validateSupervisorAgentCardNames(
				{
					runtimes: [{ id: "backend", cwd: "./backend" }],
				},
				root,
			),
		).toThrow(/frontmatter name must match runtime id/);
	});
});
