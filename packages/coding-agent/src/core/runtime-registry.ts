import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntimeStatus } from "./agent-runtime-snapshot.ts";

export interface RuntimeRegistryEntry {
	agentId: string;
	socketPath: string;
	pid: number;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	status: AgentRuntimeStatus;
	protocolVersion: number;
	capabilities: string[];
	createdAt: string;
	updatedAt: string;
}

export interface RuntimeStateEntry {
	agentId: string;
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	updatedAt: string;
}

export function getRuntimeRegistryDir(agentDir: string): string {
	return join(agentDir, "runtimes");
}

export function getRuntimeRegistryPath(agentDir: string, agentId: string): string {
	return join(getRuntimeRegistryDir(agentDir), `${sanitizeRuntimeId(agentId)}.json`);
}

export function getDefaultRuntimeSocketPath(agentDir: string, agentId: string): string {
	return join(getRuntimeRegistryDir(agentDir), `${sanitizeRuntimeId(agentId)}.sock`);
}

export function getRuntimeStatePath(agentDir: string, agentId: string): string {
	return join(getRuntimeRegistryDir(agentDir), `${sanitizeRuntimeId(agentId)}.state.json`);
}

export function sanitizeRuntimeId(agentId: string): string {
	const sanitized = agentId.trim().replace(/[^A-Za-z0-9._-]/g, "_");
	return sanitized.length > 0 ? sanitized : "runtime";
}

export function writeRuntimeRegistryEntry(agentDir: string, entry: RuntimeRegistryEntry): void {
	mkdirSync(getRuntimeRegistryDir(agentDir), { recursive: true });
	writeFileSync(getRuntimeRegistryPath(agentDir, entry.agentId), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
	writeRuntimeStateEntry(agentDir, runtimeStateFromRegistry(entry));
}

export function writeRuntimeStateEntry(agentDir: string, entry: RuntimeStateEntry): void {
	mkdirSync(getRuntimeRegistryDir(agentDir), { recursive: true });
	writeFileSync(getRuntimeStatePath(agentDir, entry.agentId), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}

export function readRuntimeStateEntry(agentDir: string, agentId: string): RuntimeStateEntry | undefined {
	const statePath = getRuntimeStatePath(agentDir, agentId);
	if (!existsSync(statePath)) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
		return isRuntimeStateEntry(parsed) ? parsed : undefined;
	} catch {
		rmSync(statePath, { force: true });
		return undefined;
	}
}

export function readRuntimeRegistryEntry(agentDir: string, agentId: string): RuntimeRegistryEntry | undefined {
	const registryPath = getRuntimeRegistryPath(agentDir, agentId);
	if (!existsSync(registryPath)) {
		return undefined;
	}

	let entry: RuntimeRegistryEntry;
	try {
		entry = JSON.parse(readFileSync(registryPath, "utf8")) as RuntimeRegistryEntry;
	} catch {
		removeRuntimeRegistryEntry(agentDir, agentId);
		return undefined;
	}

	if (!isRuntimeRegistryEntry(entry) || isStaleRuntimeRegistryEntry(entry)) {
		removeRuntimeRegistryEntry(agentDir, agentId);
		return undefined;
	}

	return entry;
}

export function listRuntimeRegistryEntries(agentDir: string): RuntimeRegistryEntry[] {
	const registryDir = getRuntimeRegistryDir(agentDir);
	if (!existsSync(registryDir)) {
		return [];
	}
	const entries: RuntimeRegistryEntry[] = [];
	for (const name of readdirSync(registryDir)) {
		if (!name.endsWith(".json")) {
			continue;
		}
		const registryPath = join(registryDir, name);
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(registryPath, "utf8")) as unknown;
		} catch {
			rmSync(registryPath, { force: true });
			continue;
		}
		if (name.endsWith(".state.json")) {
			continue;
		}
		if (!isRuntimeRegistryEntry(parsed) || isStaleRuntimeRegistryEntry(parsed)) {
			rmSync(registryPath, { force: true });
			continue;
		}
		entries.push(parsed);
	}
	return entries.sort((a, b) => a.agentId.localeCompare(b.agentId));
}

export function removeRuntimeRegistryEntry(agentDir: string, agentId: string): void {
	rmSync(getRuntimeRegistryPath(agentDir, agentId), { force: true });
}

export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isStaleRuntimeRegistryEntry(entry: RuntimeRegistryEntry): boolean {
	return !isProcessAlive(entry.pid) || !existsSync(entry.socketPath);
}

function isRuntimeRegistryEntry(value: unknown): value is RuntimeRegistryEntry {
	return (
		typeof value === "object" &&
		value !== null &&
		"agentId" in value &&
		typeof value.agentId === "string" &&
		"socketPath" in value &&
		typeof value.socketPath === "string" &&
		"pid" in value &&
		typeof value.pid === "number" &&
		"cwd" in value &&
		typeof value.cwd === "string" &&
		"sessionId" in value &&
		typeof value.sessionId === "string" &&
		(!("sessionFile" in value) || typeof value.sessionFile === "string") &&
		"status" in value &&
		typeof value.status === "string"
	);
}

function runtimeStateFromRegistry(entry: RuntimeRegistryEntry): RuntimeStateEntry {
	return {
		agentId: entry.agentId,
		cwd: entry.cwd,
		sessionId: entry.sessionId,
		sessionFile: entry.sessionFile,
		sessionName: entry.sessionName,
		updatedAt: entry.updatedAt,
	};
}

function isRuntimeStateEntry(value: unknown): value is RuntimeStateEntry {
	return (
		typeof value === "object" &&
		value !== null &&
		"agentId" in value &&
		typeof value.agentId === "string" &&
		"cwd" in value &&
		typeof value.cwd === "string" &&
		"sessionId" in value &&
		typeof value.sessionId === "string" &&
		(!("sessionFile" in value) || typeof value.sessionFile === "string") &&
		(!("sessionName" in value) || typeof value.sessionName === "string") &&
		"updatedAt" in value &&
		typeof value.updatedAt === "string"
	);
}
