import { describe, expect, test } from "vitest";
import { toRuntimeIpcArgs } from "../src/modes/runtime-attach-mode.ts";

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
});
