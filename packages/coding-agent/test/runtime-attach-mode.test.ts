import { describe, expect, test } from "vitest";
import { ATTACH_LOCAL_COMMANDS, parseRuntimeCommand, toRuntimeIpcArgs } from "../src/modes/runtime-attach-mode.ts";

describe("runtime attach mode", () => {
	test("rewrites attach-ipc mode to runtime-ipc for child process", () => {
		expect(toRuntimeIpcArgs(["--mode", "attach-ipc", "--model", "test"])).toEqual([
			"--mode",
			"runtime-ipc",
			"--model",
			"test",
		]);
	});

	test("adds runtime-ipc mode when mode was omitted", () => {
		expect(toRuntimeIpcArgs(["--model", "test"])).toEqual(["--model", "test", "--mode", "runtime-ipc"]);
	});

	test("parses runtime slash commands", () => {
		expect(parseRuntimeCommand("/compact now please")).toEqual({
			name: "compact",
			args: "now please",
		});
		expect(parseRuntimeCommand(" /reload ")).toEqual({
			name: "reload",
			args: "",
		});
		expect(parseRuntimeCommand("plain prompt")).toBeUndefined();
	});

	test("exposes attach-local slash commands for autocomplete", () => {
		expect(ATTACH_LOCAL_COMMANDS.map((command) => command.name)).toEqual(
			expect.arrayContaining(["attach", "runtimes", "broadcast", "abort", "exit", "quit"]),
		);
		expect(ATTACH_LOCAL_COMMANDS.map((command) => command.name)).not.toContain("switch");
		expect(ATTACH_LOCAL_COMMANDS.map((command) => command.name)).not.toContain("next");
		expect(ATTACH_LOCAL_COMMANDS.map((command) => command.name)).not.toContain("prev");
	});
});
