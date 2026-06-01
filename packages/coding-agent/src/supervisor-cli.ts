import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { APP_NAME, getAgentDir } from "./config.ts";
import {
	listRuntimeRegistryEntries,
	readRuntimeRegistryEntry,
	readRuntimeStateEntry,
} from "./core/runtime-registry.ts";
import { type RuntimeStartOptions, startRuntime, stopRuntime } from "./runtime-cli.ts";

export interface RuntimeSpec {
	id: string;
	cwd?: string;
	model?: string;
	tools?: string[];
	args?: string[];
	socketPath?: string;
}

export interface SupervisorConfig {
	runtimes: RuntimeSpec[];
}

export async function handleSupervisorCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "supervisor" && args[0] !== "org") {
		return false;
	}
	const command = args[1];
	if (!command || command === "--help" || command === "-h") {
		printSupervisorHelp();
		return true;
	}
	try {
		switch (command) {
			case "start":
				await startSupervisor(parseConfigPath(args.slice(2)));
				return true;
			case "restart":
				await restartSupervisor(parseConfigPath(args.slice(2)));
				return true;
			case "status":
			case "list":
				printSupervisorStatus(parseConfigPath(args.slice(2)));
				return true;
			default:
				console.error(chalk.red(`Unknown supervisor command: ${command}`));
				printSupervisorHelp();
				process.exitCode = 1;
				return true;
		}
	} catch (error) {
		console.error(chalk.red(error instanceof Error ? error.message : String(error)));
		process.exitCode = 1;
		return true;
	}
}

export function loadSupervisorConfig(configPath = defaultSupervisorConfigPath()): SupervisorConfig {
	if (!existsSync(configPath)) {
		throw new Error(`Supervisor config not found: ${configPath}`);
	}
	const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
	if (!isSupervisorConfig(parsed)) {
		throw new Error(`Invalid supervisor config: ${configPath}`);
	}
	return parsed;
}

export function runtimeSpecToStartOptions(
	spec: RuntimeSpec,
	configPath?: string,
	agentDir = getAgentDir(),
): RuntimeStartOptions {
	const runtimeArgs = [...(spec.args ?? [])];
	if (!hasSessionSelectionFlag(runtimeArgs)) {
		const state = readRuntimeStateEntry(agentDir, spec.id);
		if (state?.sessionFile && existsSync(state.sessionFile)) {
			runtimeArgs.push("--session", state.sessionFile);
		} else if (!state) {
			runtimeArgs.push("--continue");
		}
	}
	if (spec.model) {
		runtimeArgs.push("--model", spec.model);
	}
	if (spec.tools && spec.tools.length > 0) {
		runtimeArgs.push("--tools", spec.tools.join(","));
	}
	if (configPath) {
		runtimeArgs.push("--team-config", configPath, "--team-member-name", spec.id);
	}
	return {
		agentId: spec.id,
		cwd: resolve(spec.cwd ?? process.cwd()),
		socketPath: spec.socketPath,
		runtimeArgs,
	};
}

async function startSupervisor(configPath: string): Promise<void> {
	const config = loadSupervisorConfig(configPath);
	await startSupervisorRuntimes(config, configPath);
}

async function restartSupervisor(configPath: string): Promise<void> {
	const config = loadSupervisorConfig(configPath);
	for (const spec of config.runtimes) {
		try {
			await stopRuntime(getAgentDir(), spec.id);
		} catch (error) {
			console.log(
				chalk.dim(
					`Runtime "${spec.id}" was not stopped: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
		}
	}
	await startSupervisorRuntimes(config, configPath);
}

async function startSupervisorRuntimes(config: SupervisorConfig, configPath: string): Promise<void> {
	const errors: string[] = [];
	for (const spec of config.runtimes) {
		try {
			await startRuntime(runtimeSpecToStartOptions(spec, configPath));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`${spec.id}: ${message}`);
			console.error(chalk.red(`Runtime "${spec.id}" was not started: ${message}`));
		}
	}
	if (errors.length > 0) {
		throw new Error(`Failed to start ${errors.length} runtime(s): ${errors.join("; ")}`);
	}
}

function printSupervisorStatus(configPath: string): void {
	const config = loadSupervisorConfig(configPath);
	const entries = listRuntimeRegistryEntries(getAgentDir());
	for (const spec of config.runtimes) {
		const entry = readRuntimeRegistryEntry(getAgentDir(), spec.id);
		const status = entry ? `${entry.status} pid=${entry.pid}` : "stopped";
		console.log(`${spec.id}  ${status}  ${resolve(spec.cwd ?? process.cwd())}`);
	}
	const configured = new Set(config.runtimes.map((runtime) => runtime.id));
	for (const entry of entries) {
		if (!configured.has(entry.agentId)) {
			console.log(`${entry.agentId}  ${entry.status} pid=${entry.pid}  ${entry.cwd}`);
		}
	}
}

function parseConfigPath(args: string[]): string {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--config" && i + 1 < args.length) {
			return resolve(args[i + 1]);
		}
	}
	return defaultSupervisorConfigPath();
}

function defaultSupervisorConfigPath(): string {
	return resolve(".pi", "runtimes.json");
}

function printSupervisorHelp(): void {
	console.log(`${chalk.bold(APP_NAME)} supervisor - start configured local runtimes

${chalk.bold("Usage:")}
  ${APP_NAME} supervisor start [--config .pi/runtimes.json]
  ${APP_NAME} supervisor restart [--config .pi/runtimes.json]
  ${APP_NAME} supervisor status [--config .pi/runtimes.json]
  ${APP_NAME} org start [--config .pi/runtimes.json]

${chalk.bold("Config:")}
  {
    "runtimes": [
      { "id": "backend", "cwd": "./backend", "model": "sonnet", "tools": ["read", "bash"] }
    ]
  }

Supervisor runtimes restore the runtime's last known session file when available, then fall back to --continue.
Set args to include --session, --resume, --continue, --fork, or --no-session to override session selection.`);
}

function hasSessionSelectionFlag(args: readonly string[]): boolean {
	return args.some((arg) => ["--session", "--resume", "--continue", "-c", "--fork", "--no-session"].includes(arg));
}

function isSupervisorConfig(value: unknown): value is SupervisorConfig {
	return (
		typeof value === "object" &&
		value !== null &&
		"runtimes" in value &&
		Array.isArray(value.runtimes) &&
		value.runtimes.every(isRuntimeSpec)
	);
}

function isRuntimeSpec(value: unknown): value is RuntimeSpec {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		(!("cwd" in value) || typeof value.cwd === "string") &&
		(!("model" in value) || typeof value.model === "string") &&
		(!("socketPath" in value) || typeof value.socketPath === "string") &&
		(!("tools" in value) || (Array.isArray(value.tools) && value.tools.every((tool) => typeof tool === "string"))) &&
		(!("args" in value) || (Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string")))
	);
}
