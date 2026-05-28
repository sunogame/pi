import { describe, expect, it } from "vitest";
import { parseRuntimeStartArgs } from "../src/runtime-cli.ts";

describe("runtime CLI", () => {
	it("parses runtime start options and passes through runtime flags", () => {
		const parsed = parseRuntimeStartArgs([
			"backend",
			"--cwd",
			"./backend",
			"--runtime-socket",
			"/tmp/backend.sock",
			"--model",
			"sonnet",
			"--tools",
			"read,bash",
		]);

		expect(parsed.agentId).toBe("backend");
		expect(parsed.cwd).toMatch(/backend$/);
		expect(parsed.socketPath).toBe("/tmp/backend.sock");
		expect(parsed.runtimeArgs).toEqual(["--model", "sonnet", "--tools", "read,bash"]);
	});

	it("requires a runtime id", () => {
		expect(() => parseRuntimeStartArgs(["--cwd", "."])).toThrow(/Missing runtime id/);
	});
});
