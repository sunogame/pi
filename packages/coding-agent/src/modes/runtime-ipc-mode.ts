import { Writable } from "node:stream";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { takeOverStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
import { createRuntimeIpcServer } from "../core/runtime-ipc-server.ts";
import { createStreamRuntimeTransport } from "../core/runtime-transport.ts";

export async function runRuntimeIpcMode(runtimeHost: AgentSessionRuntime): Promise<void> {
	takeOverStdout();

	const output = new Writable({
		write(chunk, _encoding, callback) {
			writeRawStdout(Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk));
			void waitForRawStdoutBackpressure().then(
				() => callback(),
				(error) => callback(error instanceof Error ? error : new Error(String(error))),
			);
		},
	});
	const transport = createStreamRuntimeTransport(process.stdin, output);
	const server = createRuntimeIpcServer(runtimeHost, transport);

	process.stdin.resume();

	await new Promise<void>(() => {
		process.stdin.once("end", () => {
			server.dispose();
			process.exit(0);
		});
	});
}
