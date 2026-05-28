import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { dirname } from "node:path";
import { createStreamRuntimeTransport, type RuntimeTransport } from "./runtime-transport.ts";

export interface RuntimeSocketServer {
	socketPath: string;
	close(): Promise<void>;
}

export async function connectRuntimeSocket(socketPath: string): Promise<RuntimeTransport> {
	if (process.platform === "win32") {
		throw new Error("Runtime socket transport is not supported on Windows yet");
	}

	const socket = createConnection(socketPath);
	socket.setMaxListeners(0);
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			socket.off("connect", onConnect);
			socket.off("error", onError);
		};
		const onConnect = () => {
			cleanup();
			resolve();
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});

	return createStreamRuntimeTransport(socket, socket);
}

export async function listenRuntimeSocket(
	socketPath: string,
	onConnection: (transport: RuntimeTransport) => void,
): Promise<RuntimeSocketServer> {
	if (process.platform === "win32") {
		throw new Error("Runtime socket transport is not supported on Windows yet");
	}

	mkdirSync(dirname(socketPath), { recursive: true });
	if (existsSync(socketPath)) {
		rmSync(socketPath, { force: true });
	}

	const server = createServer((socket) => {
		socket.setMaxListeners(0);
		onConnection(createStreamRuntimeTransport(socket, socket));
	});

	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			server.off("listening", onListening);
			server.off("error", onError);
		};
		const onListening = () => {
			cleanup();
			resolve();
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		server.once("listening", onListening);
		server.once("error", onError);
		server.listen(socketPath);
	});

	return {
		socketPath,
		close: () => closeSocketServer(server, socketPath),
	};
}

async function closeSocketServer(server: Server, socketPath: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
	rmSync(socketPath, { force: true });
}
