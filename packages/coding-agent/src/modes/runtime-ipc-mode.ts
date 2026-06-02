import { Writable } from "node:stream";
import { type AgentRuntimeEvent, statusFromSession } from "../core/agent-runtime-snapshot.ts";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { takeOverStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
import type { RuntimeIpcServer } from "../core/runtime-ipc-server.ts";
import { createRuntimeIpcServer } from "../core/runtime-ipc-server.ts";
import {
	getDefaultRuntimeSocketPath,
	type RuntimeRegistryEntry,
	removeRuntimeRegistryEntry,
	writeRuntimeRegistryEntry,
} from "../core/runtime-registry.ts";
import { listenRuntimeSocket } from "../core/runtime-socket-transport.ts";
import { createStreamRuntimeTransport } from "../core/runtime-transport.ts";

export interface RuntimeIpcModeOptions {
	agentDir?: string;
	runtimeId?: string;
	socketPath?: string;
}

export async function runRuntimeIpcMode(
	runtimeHost: AgentSessionRuntime,
	options: RuntimeIpcModeOptions = {},
): Promise<void> {
	if (options.runtimeId || options.socketPath) {
		await runRuntimeSocketIpcMode(runtimeHost, options);
		return;
	}

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
	const server = createRuntimeIpcServer(runtimeHost, transport, {
		onShutdown: () => process.stdin.emit("end"),
	});

	process.stdin.resume();

	await new Promise<void>(() => {
		process.stdin.once("end", () => {
			server.dispose();
			process.exit(0);
		});
	});
}

async function runRuntimeSocketIpcMode(
	runtimeHost: AgentSessionRuntime,
	options: RuntimeIpcModeOptions,
): Promise<void> {
	const agentDir = options.agentDir;
	const runtimeId = options.runtimeId ?? "runtime";
	if (!agentDir && !options.socketPath) {
		throw new Error("runtime-ipc socket mode requires either agentDir or socketPath");
	}
	const socketPath = options.socketPath ?? getDefaultRuntimeSocketPath(agentDir as string, runtimeId);
	const servers = new Set<RuntimeIpcServer>();
	const createdAt = new Date().toISOString();
	let requestShutdown: (() => void) | undefined;
	const socketServer = await listenRuntimeSocket(socketPath, (transport) => {
		const server = createRuntimeIpcServer(runtimeHost, transport, {
			onShutdown: () => requestShutdown?.(),
		});
		servers.add(server);
	});

	const writeRegistry = () => {
		if (!agentDir) {
			return;
		}
		writeRuntimeRegistryEntry(agentDir, createRegistryEntry(runtimeHost, runtimeId, socketPath, createdAt));
	};
	let registryWriteTimer: ReturnType<typeof setTimeout> | undefined;
	const scheduleRegistryWrite = () => {
		if (registryWriteTimer) {
			return;
		}
		registryWriteTimer = setTimeout(() => {
			registryWriteTimer = undefined;
			writeRegistry();
		}, 75);
	};
	const unsubscribeRegistryUpdates = runtimeHost.subscribeRuntimeEvents((event: AgentRuntimeEvent) => {
		if (event.type === "session_changed") {
			writeRegistry();
		} else if (event.type === "status_changed") {
			scheduleRegistryWrite();
		}
	});
	writeRegistry();
	process.stderr.write(`Runtime IPC listening on ${socketPath}\n`);

	await new Promise<void>((resolve) => {
		requestShutdown = resolve;
		const cleanup = () => {
			process.off("SIGINT", cleanup);
			process.off("SIGTERM", cleanup);
			resolve();
		};
		process.once("SIGINT", cleanup);
		process.once("SIGTERM", cleanup);
	});

	unsubscribeRegistryUpdates();
	if (registryWriteTimer) {
		clearTimeout(registryWriteTimer);
		registryWriteTimer = undefined;
	}
	for (const server of servers) {
		server.dispose();
	}
	try {
		await socketServer.close();
		await runtimeHost.dispose();
	} finally {
		if (agentDir) {
			removeRuntimeRegistryEntry(agentDir, runtimeId);
		}
	}
}

function createRegistryEntry(
	runtimeHost: AgentSessionRuntime,
	runtimeId: string,
	socketPath: string,
	createdAt: string,
): RuntimeRegistryEntry {
	const session = runtimeHost.session;
	const sessionManager = session.sessionManager;
	const now = new Date().toISOString();
	return {
		agentId: runtimeId,
		socketPath,
		pid: process.pid,
		cwd: sessionManager.getCwd(),
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		sessionName: session.sessionName,
		status: statusFromSession(session),
		protocolVersion: 1,
		capabilities: runtimeHost.getRuntimeCapabilities(),
		createdAt,
		updatedAt: now,
	};
}
