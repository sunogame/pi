import type { Readable, Writable } from "node:stream";
import { attachJsonlLineReader } from "./jsonl.ts";

export interface RuntimeTransport {
	send(line: string): Promise<void>;
	onLine(cb: (line: string) => void): () => void;
	onClose(cb: () => void): () => void;
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
	private readonly closeListeners = new Set<() => void>();
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
		input.once("end", () => this.markClosed());
		input.once("close", () => this.markClosed());
		output.once("close", () => this.markClosed());
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

	onClose(cb: () => void): () => void {
		if (this.closed) {
			queueMicrotask(cb);
			return () => {};
		}
		this.closeListeners.add(cb);
		return () => {
			this.closeListeners.delete(cb);
		};
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.markClosed();
		this.detachReader();
		this.listeners.clear();
		this.input.destroy();
		this.output.end();
	}

	private markClosed(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		const listeners = [...this.closeListeners];
		this.closeListeners.clear();
		for (const listener of listeners) {
			listener();
		}
	}
}

export function createStreamRuntimeTransport(input: Readable, output: Writable): StreamRuntimeTransport {
	return new StreamRuntimeTransport(input, output);
}
