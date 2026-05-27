import type { Readable, Writable } from "node:stream";
import { attachJsonlLineReader } from "./jsonl.ts";

export interface RuntimeTransport {
	send(line: string): Promise<void>;
	onLine(cb: (line: string) => void): () => void;
	close(): void;
}

export class RuntimeTransportClosedError extends Error {
	constructor() {
		super("Runtime transport is closed");
		this.name = "RuntimeTransportClosedError";
	}
}

export class StreamRuntimeTransport implements RuntimeTransport {
	private readonly input: Readable;
	private readonly output: Writable;
	private readonly listeners = new Set<(line: string) => void>();
	private readonly detachReader: () => void;
	private closed = false;

	constructor(input: Readable, output: Writable) {
		this.input = input;
		this.output = output;
		this.detachReader = attachJsonlLineReader(input, (line) => {
			for (const listener of this.listeners) {
				listener(line);
			}
		});
		input.once("end", () => {
			this.closed = true;
		});
		input.once("close", () => {
			this.closed = true;
		});
		output.once("close", () => {
			this.closed = true;
		});
	}

	async send(line: string): Promise<void> {
		if (this.closed || this.output.destroyed || !this.output.writable) {
			throw new RuntimeTransportClosedError();
		}

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};
			const cleanup = () => {
				this.output.off("error", onError);
			};

			this.output.once("error", onError);
			this.output.write(line, (error?: Error | null) => {
				cleanup();
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});
	}

	onLine(cb: (line: string) => void): () => void {
		if (this.closed) {
			return () => {};
		}
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.detachReader();
		this.listeners.clear();
		this.input.destroy();
		this.output.end();
	}
}

export function createStreamRuntimeTransport(input: Readable, output: Writable): StreamRuntimeTransport {
	return new StreamRuntimeTransport(input, output);
}
