import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { connectRuntimeSocket, listenRuntimeSocket } from "../src/core/runtime-socket-transport.ts";
import { createStreamRuntimeTransport, RuntimeTransportClosedError } from "../src/core/runtime-transport.ts";

describe("StreamRuntimeTransport", () => {
	it("delivers LF-framed input lines", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const transport = createStreamRuntimeTransport(input, output);
		const lines: string[] = [];

		transport.onLine((line) => lines.push(line));
		input.write('{"a":1}\n{"b":');
		input.write("2}\r\n");

		await new Promise((resolve) => setImmediate(resolve));
		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
		transport.close();
	});

	it("writes lines to the output stream", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const transport = createStreamRuntimeTransport(input, output);
		const chunks: string[] = [];
		output.on("data", (chunk) => chunks.push(chunk.toString("utf-8")));

		await transport.send('{"ok":true}\n');

		expect(chunks.join("")).toBe('{"ok":true}\n');
		transport.close();
	});

	it("unsubscribes line listeners", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const transport = createStreamRuntimeTransport(input, output);
		const lines: string[] = [];
		const unsubscribe = transport.onLine((line) => lines.push(line));

		unsubscribe();
		input.write("ignored\n");

		await new Promise((resolve) => setImmediate(resolve));
		expect(lines).toEqual([]);
		transport.close();
	});

	it("rejects sends after close", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const transport = createStreamRuntimeTransport(input, output);

		transport.close();

		await expect(transport.send("late\n")).rejects.toBeInstanceOf(RuntimeTransportClosedError);
	});

	it("connects stream transports over a Unix socket", async () => {
		if (process.platform === "win32") {
			return;
		}
		const socketPath = join(tmpdir(), `pi-runtime-transport-${process.pid}-${Date.now()}.sock`);
		let serverLine = "";
		const server = await listenRuntimeSocket(socketPath, (transport) => {
			transport.onLine((line) => {
				serverLine = line;
				void transport.send(`${line}-reply\n`);
			});
		});
		const client = await connectRuntimeSocket(socketPath);
		const reply = new Promise<string>((resolve) => {
			client.onLine((line) => resolve(line));
		});

		await client.send("hello\n");
		await expect(reply).resolves.toBe("hello-reply");

		expect(serverLine).toBe("hello");
		client.close();
		await server.close();
	});
});
