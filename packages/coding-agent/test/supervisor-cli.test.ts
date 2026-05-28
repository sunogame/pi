import { describe, expect, it } from "vitest";
import { runtimeSpecToStartOptions } from "../src/supervisor-cli.ts";

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
		expect(options.runtimeArgs).toEqual(["--no-skills", "--model", "sonnet", "--tools", "read,bash"]);
	});
});
