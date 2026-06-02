import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { APP_NAME, getAgentDir } from "./config.ts";
import type { AgentRuntimeSnapshot } from "./core/agent-runtime-snapshot.ts";
import { createIpcRuntimeClient } from "./core/ipc-runtime-client.ts";
import {
	getRuntimeLogPath,
	getRuntimeRegistryDir,
	listRuntimeRegistryEntries,
	type RuntimeRegistryEntry,
	readRuntimeRegistryEntry,
	removeRuntimeRegistryEntry,
} from "./core/runtime-registry.ts";
import { connectRuntimeSocket } from "./core/runtime-socket-transport.ts";

export interface RuntimeStartOptions {
	agentId: string;
	cwd: string;
	socketPath?: string;
	runtimeArgs: string[];
}

export async function handleRuntimeCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "runtime") {
		return false;
	}

	const command = args[1];
	if (!command || command === "--help" || command === "-h") {
		printRuntimeHelp();
		return true;
	}

	try {
		switch (command) {
			case "list":
				printRuntimeList(getAgentDir());
				return true;
			case "inspect":
				await inspectRuntime(getAgentDir(), args[2]);
				return true;
			case "stop":
				await stopRuntime(getAgentDir(), args[2]);
				return true;
			case "start":
				await startRuntime(parseRuntimeStartArgs(args.slice(2)));
				return true;
			default:
				console.error(chalk.red(`Unknown runtime command: ${command}`));
				printRuntimeHelp();
				process.exitCode = 1;
				return true;
		}
	} catch (error) {
		console.error(chalk.red(error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
		return true;
	}
}

function printRuntimeHelp(): void {
	console.log(`${chalk.bold(APP_NAME)} runtime - manage local runtime processes

${chalk.bold("Usage:")}
  ${APP_NAME} runtime list
  ${APP_NAME} runtime inspect <id>
  ${APP_NAME} runtime stop <id>
  ${APP_NAME} runtime start <id> [--cwd <dir>] [--runtime-socket <path>] [runtime flags...]

${chalk.bold("Examples:")}
  ${APP_NAME} runtime start backend --cwd ./backend --model sonnet
  ${APP_NAME} runtime list
  ${APP_NAME} --mode attach-ipc --attach backend
  ${APP_NAME} runtime stop backend`);
}

function printRuntimeList(agentDir: string): void {
	const entries = listRuntimeRegistryEntries(agentDir);
	if (entries.length === 0) {
		console.log(chalk.dim("No registered runtimes."));
		return;
	}

	const rows = entries.map((entry) => ({
		id: entry.agentId,
		pid: String(entry.pid),
		status: entry.status,
		session: entry.sessionName ?? entry.sessionId.slice(0, 8),
		cwd: entry.cwd,
	}));
	const widths = {
		id: Math.max(2, ...rows.map((row) => row.id.length)),
		pid: Math.max(3, ...rows.map((row) => row.pid.length)),
		status: Math.max(6, ...rows.map((row) => row.status.length)),
		session: Math.max(7, ...rows.map((row) => row.session.length)),
	};
	console.log(
		[
			chalk.bold(
				`${"ID".padEnd(widths.id)}  ${"PID".padEnd(widths.pid)}  ${"STATUS".padEnd(widths.status)}  ${"SESSION".padEnd(widths.session)}  CWD`,
			),
			...rows.map(
				(row) =>
					`${row.id.padEnd(widths.id)}  ${row.pid.padEnd(widths.pid)}  ${row.status.padEnd(widths.status)}  ${row.session.padEnd(widths.session)}  ${row.cwd}`,
			),
		].join("\n"),
	);
}

async function inspectRuntime(agentDir: string, agentId?: string): Promise<void> {
	if (!agentId) {
		throw new Error("Missing runtime id. Usage: pi runtime inspect <id>");
	}
	const entry = readRuntimeRegistryEntry(agentDir, agentId);
	if (!entry) {
		throw new Error(`No running runtime registered as "${agentId}"`);
	}
	let snapshot: AgentRuntimeSnapshot | undefined;
	try {
		const transport = await connectRuntimeSocket(entry.socketPath);
		const client = createIpcRuntimeClient(transport, createPlaceholderSnapshot(entry));
		const attached = await client.attach();
		snapshot = attached.snapshot;
		client.close();
	} catch {
		// Registry data is still useful when snapshot fetch fails.
	}
	console.log(JSON.stringify({ registry: entry, snapshot }, null, 2));
}

export async function stopRuntime(agentDir: string, agentId?: string): Promise<void> {
	if (!agentId) {
		throw new Error("Missing runtime id. Usage: pi runtime stop <id>");
	}
	const entry = readRuntimeRegistryEntry(agentDir, agentId);
	if (!entry) {
		throw new Error(`No running runtime registered as "${agentId}"`);
	}
	try {
		const transport = await connectRuntimeSocket(entry.socketPath);
		const client = createIpcRuntimeClient(transport, createPlaceholderSnapshot(entry));
		await client.shutdown();
		client.close();
		await waitForRuntimeExit(agentDir, agentId, 2000);
		console.log(`Stopped runtime "${agentId}".`);
	} catch (error) {
		removeRuntimeRegistryEntry(agentDir, agentId);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Runtime "${agentId}" was unavailable; removed stale registry entry. ${message}`);
	}
}

export async function startRuntime(options: RuntimeStartOptions): Promise<RuntimeRegistryEntry> {
	const existing = readRuntimeRegistryEntry(getAgentDir(), options.agentId);
	if (existing) {
		console.log(`Runtime "${options.agentId}" is already running pid=${existing.pid} socket=${existing.socketPath}`);
		return existing;
	}
	validateRuntimeStartOptions(options);
	const entrypoint = process.argv[1];
	if (!entrypoint) {
		throw new Error("Cannot start runtime: missing CLI entrypoint");
	}
	if (!existsSync(entrypoint)) {
		throw new Error(`Cannot start runtime "${options.agentId}": CLI entrypoint does not exist: ${entrypoint}`);
	}
	const args = [
		...options.runtimeArgs,
		"--mode",
		"runtime-ipc",
		"--runtime-id",
		options.agentId,
		...(options.socketPath ? ["--runtime-socket", options.socketPath] : []),
	];
	const logPath = prepareRuntimeLog(getAgentDir(), options.agentId, options.cwd, args);
	const logFd = openSync(logPath, "a");
	const child = spawn(process.execPath, [entrypoint, ...args], {
		cwd: options.cwd,
		env: process.env,
		detached: true,
		stdio: ["ignore", logFd, logFd],
	});
	closeSync(logFd);
	child.unref();
	const entry = await waitForRuntimeEntryOrExit(getAgentDir(), options.agentId, 10_000, child);
	if (!entry) {
		throw new Error(`Started runtime "${options.agentId}" but it did not register within 10s. See ${logPath}`);
	}
	console.log(`Started runtime "${options.agentId}" pid=${entry.pid} socket=${entry.socketPath} log=${logPath}`);
	return entry;
}

export function parseRuntimeStartArgs(args: string[]): RuntimeStartOptions {
	const agentId = args[0];
	if (!agentId || agentId.startsWith("-")) {
		throw new Error("Missing runtime id. Usage: pi runtime start <id> [--cwd <dir>] [runtime flags...]");
	}
	const runtimeArgs: string[] = [];
	let cwd = process.cwd();
	let socketPath: string | undefined;
	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--cwd") {
			if (i + 1 >= args.length || args[i + 1]?.startsWith("-")) {
				throw new Error(`Missing value for --cwd. Usage: pi runtime start ${agentId} --cwd <dir>`);
			}
			cwd = resolve(args[++i]);
		} else if (arg === "--runtime-socket") {
			if (i + 1 >= args.length || args[i + 1]?.startsWith("-")) {
				throw new Error(
					`Missing value for --runtime-socket. Usage: pi runtime start ${agentId} --runtime-socket <path>`,
				);
			}
			socketPath = args[++i];
		} else if (arg === "--") {
			runtimeArgs.push(...args.slice(i + 1));
			break;
		} else {
			runtimeArgs.push(arg);
		}
	}
	return { agentId, cwd, socketPath, runtimeArgs };
}

function validateRuntimeStartOptions(options: RuntimeStartOptions): void {
	if (!options.agentId.trim()) {
		throw new Error("Cannot start runtime: runtime id is empty");
	}
	if (!existsSync(options.cwd)) {
		throw new Error(`Cannot start runtime "${options.agentId}": cwd does not exist: ${options.cwd}`);
	}
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(options.cwd);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot start runtime "${options.agentId}": cannot access cwd ${options.cwd}: ${message}`);
	}
	if (!stat.isDirectory()) {
		throw new Error(`Cannot start runtime "${options.agentId}": cwd is not a directory: ${options.cwd}`);
	}
}

async function waitForRuntimeEntryOrExit(
	agentDir: string,
	agentId: string,
	timeoutMs: number,
	child: ReturnType<typeof spawn>,
): Promise<RuntimeRegistryEntry | undefined> {
	let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	let spawnError: Error | undefined;
	child.once("error", (error) => {
		spawnError = error;
	});
	child.once("exit", (code, signal) => {
		exited = { code, signal };
	});

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const entry = readRuntimeRegistryEntry(agentDir, agentId);
		if (entry) {
			return entry;
		}
		if (spawnError) {
			throw new Error(
				`Runtime "${agentId}" could not be spawned: ${formatSpawnError(spawnError)}. See ${getRuntimeLogPath(agentDir, agentId)}`,
			);
		}
		if (exited) {
			throw new Error(
				`Runtime "${agentId}" exited before registering (code=${exited.code ?? "null"} signal=${exited.signal ?? "null"}). See ${getRuntimeLogPath(agentDir, agentId)}`,
			);
		}
		await delay(100);
	}
	return undefined;
}

function formatSpawnError(error: Error): string {
	const code = "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
	if (code === "ENOENT") {
		return `${error.message}. Check that the runtime cwd and Node executable exist`;
	}
	if (code === "EACCES") {
		return `${error.message}. Check executable permissions`;
	}
	return error.message;
}

async function waitForRuntimeExit(agentDir: string, agentId: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!existsSync(readRuntimeRegistryEntry(agentDir, agentId)?.socketPath ?? "")) {
			return;
		}
		await delay(100);
	}
}

function prepareRuntimeLog(agentDir: string, agentId: string, cwd: string, args: readonly string[]): string {
	mkdirSync(getRuntimeRegistryDir(agentDir), { recursive: true });
	const logPath = getRuntimeLogPath(agentDir, agentId);
	appendFileSync(
		logPath,
		[
			"",
			`===== ${new Date().toISOString()} starting runtime ${agentId} =====`,
			`cwd: ${cwd}`,
			`argv: ${process.execPath} ${process.argv[1] ?? ""} ${args.join(" ")}`,
			"",
		].join("\n"),
		"utf8",
	);
	return logPath;
}

function createPlaceholderSnapshot(entry: RuntimeRegistryEntry): AgentRuntimeSnapshot {
	return {
		protocolVersion: 1,
		capabilities: entry.capabilities,
		eventCursor: 0,
		agent: {
			agentId: entry.agentId,
			cwd: entry.cwd,
			model: {},
			thinkingLevel: "off",
			status: entry.status,
		},
		session: {
			sessionId: entry.sessionId,
			sessionName: entry.sessionName,
			sessionDir: "",
			currentLeafId: null,
		},
		transcript: { entries: [], currentLeafId: null },
		run: {
			isStreaming: false,
			isBashRunning: false,
			retryAttempt: 0,
			pendingUserMessages: [],
			pendingNotifications: [],
			pendingApprovals: [],
			activeToolExecutions: [],
		},
		monitors: { active: [], recent: [] },
		tools: { active: [], available: [] },
		resources: { skills: [], promptTemplates: [], themes: [], extensions: [], agentsFiles: [] },
		modelRegistry: { available: [] },
		diagnostics: { resources: [], extensions: [] },
		config: {
			autoCompaction: false,
			steeringMode: "all",
			followUpMode: "all",
			availableThinkingLevels: [],
			scopedModels: [],
		},
		commands: [],
	};
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
