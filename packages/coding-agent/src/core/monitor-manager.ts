import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "../utils/ansi.ts";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	sanitizeBinaryOutput,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../utils/shell.ts";
import { xmlEscape } from "../utils/xml.ts";

export type MonitorStatus = "running" | "completed" | "failed" | "stopped";

export interface MonitorTaskSnapshot {
	id: string;
	command: string;
	description: string;
	persistent: boolean;
	status: MonitorStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	outputFile: string;
	lineCount: number;
	notificationCount: number;
	lastEvent?: string;
	error?: string;
}

export interface RuntimeNotification {
	id: string;
	kind: "monitor" | "a2a";
	customType?: string;
	createdAt: number;
	text: string;
	source: Record<string, string>;
}

export interface MonitorManagerOptions {
	cwd: string;
	shellPath?: string;
	commandPrefix?: string;
	onNotification: (notification: RuntimeNotification) => void;
	onMonitorStarted?: (monitor: MonitorTaskSnapshot) => void;
	onMonitorOutput?: (event: { monitorId: string; lineCount: number; preview: string }) => void;
	onMonitorEnded?: (monitor: MonitorTaskSnapshot) => void;
	onMonitorStopped?: (monitorId: string) => void;
	defaults?: Partial<MonitorLimits>;
}

export interface MonitorStartOptions {
	command: string;
	description: string;
	persistent?: boolean;
	timeoutSeconds?: number;
}

export interface MonitorLimits {
	batchMs: number;
	maxLineBytes: number;
	maxBatchLines: number;
	maxEventsPerMinute: number;
	maxTotalEvents: number;
	maxRuntimeMs: number;
}

const DEFAULT_LIMITS: MonitorLimits = {
	batchMs: 200,
	maxLineBytes: 4096,
	maxBatchLines: 20,
	maxEventsPerMinute: 60,
	maxTotalEvents: 200,
	maxRuntimeMs: 10 * 60 * 1000,
};

interface MonitorTaskInternal {
	snapshot: MonitorTaskSnapshot;
	child: ChildProcess;
	outputStream: WriteStream;
	lineBuffer: string;
	batchLines: string[];
	batchTimer?: NodeJS.Timeout;
	timeoutTimer?: NodeJS.Timeout;
	notificationTimestamps: number[];
	finalized: boolean;
	forceStatus?: MonitorStatus;
	forceError?: string;
}

export class MonitorManager {
	private readonly cwd: string;
	private readonly shellPath?: string;
	private readonly commandPrefix?: string;
	private readonly onNotification: (notification: RuntimeNotification) => void;
	private readonly onMonitorStarted?: (monitor: MonitorTaskSnapshot) => void;
	private readonly onMonitorOutput?: (event: { monitorId: string; lineCount: number; preview: string }) => void;
	private readonly onMonitorEnded?: (monitor: MonitorTaskSnapshot) => void;
	private readonly onMonitorStopped?: (monitorId: string) => void;
	private readonly limits: MonitorLimits;
	private readonly monitors = new Map<string, MonitorTaskInternal>();
	private readonly recent: MonitorTaskSnapshot[] = [];

	constructor(options: MonitorManagerOptions) {
		this.cwd = options.cwd;
		this.shellPath = options.shellPath;
		this.commandPrefix = options.commandPrefix;
		this.onNotification = options.onNotification;
		this.onMonitorStarted = options.onMonitorStarted;
		this.onMonitorOutput = options.onMonitorOutput;
		this.onMonitorEnded = options.onMonitorEnded;
		this.onMonitorStopped = options.onMonitorStopped;
		this.limits = { ...DEFAULT_LIMITS, ...options.defaults };
	}

	start(options: MonitorStartOptions): MonitorTaskSnapshot {
		const id = `m_${randomBytes(5).toString("hex")}`;
		const outputFile = join(tmpdir(), `pi-monitor-${id}.log`);
		const command = this.commandPrefix ? `${this.commandPrefix}\n${options.command}` : options.command;
		const { shell, args } = getShellConfig(this.shellPath);
		const child = spawnProcess(shell, [...args, command], {
			cwd: this.cwd,
			detached: process.platform !== "win32",
			env: getShellEnv(),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		if (child.pid && process.platform !== "win32") {
			trackDetachedChildPid(child.pid);
		}
		const outputStream = createWriteStream(outputFile);
		const snapshot: MonitorTaskSnapshot = {
			id,
			command: options.command,
			description: options.description,
			persistent: options.persistent === true,
			status: "running",
			startedAt: Date.now(),
			outputFile,
			lineCount: 0,
			notificationCount: 0,
		};
		const task: MonitorTaskInternal = {
			snapshot,
			child,
			outputStream,
			lineBuffer: "",
			batchLines: [],
			notificationTimestamps: [],
			finalized: false,
		};
		outputStream.on("error", (error) => {
			this.failAndStop(task, `Monitor output file error: ${error.message}`);
		});
		this.monitors.set(id, task);
		this.onMonitorStarted?.(this.clone(snapshot));

		child.stdout?.on("data", (data: Buffer) => this.handleStdout(task, data));
		child.stderr?.on("data", (data: Buffer) => {
			this.writeOutput(task, data);
		});

		const timeoutMs = options.timeoutSeconds
			? options.timeoutSeconds * 1000
			: snapshot.persistent
				? undefined
				: this.limits.maxRuntimeMs;
		if (timeoutMs !== undefined && timeoutMs > 0) {
			task.timeoutTimer = setTimeout(() => {
				this.failAndStop(task, `Monitor timed out after ${Math.round(timeoutMs / 1000)} seconds`);
			}, timeoutMs);
		}

		void waitForChildProcess(child)
			.then((exitCode) => {
				this.finalize(task, exitCode ?? undefined);
			})
			.catch((error: unknown) => {
				this.failAndStop(task, error instanceof Error ? error.message : String(error));
			});

		return this.clone(snapshot);
	}

	stop(id: string): MonitorTaskSnapshot | undefined {
		const task = this.monitors.get(id);
		if (!task) {
			return undefined;
		}
		task.forceStatus = "stopped";
		this.onMonitorStopped?.(id);
		if (task.child.pid) {
			killProcessTree(task.child.pid);
		}
		return this.clone(task.snapshot);
	}

	stopAll(): void {
		for (const id of this.monitors.keys()) {
			this.stop(id);
		}
	}

	getActive(): MonitorTaskSnapshot[] {
		return Array.from(this.monitors.values()).map((task) => this.clone(task.snapshot));
	}

	getRecent(): MonitorTaskSnapshot[] {
		return this.recent.map((task) => this.clone(task));
	}

	private handleStdout(task: MonitorTaskInternal, data: Buffer): void {
		this.writeOutput(task, data);
		const text = sanitizeBinaryOutput(stripAnsi(data.toString("utf8"))).replace(/\r/g, "");
		task.lineBuffer += text;
		let newlineIndex = task.lineBuffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = task.lineBuffer.slice(0, newlineIndex);
			task.lineBuffer = task.lineBuffer.slice(newlineIndex + 1);
			this.enqueueLine(task, line);
			newlineIndex = task.lineBuffer.indexOf("\n");
		}
	}

	private writeOutput(task: MonitorTaskInternal, data: Buffer): void {
		if (task.outputStream.destroyed || task.outputStream.closed) {
			return;
		}
		task.outputStream.write(data);
	}

	private enqueueLine(task: MonitorTaskInternal, line: string): void {
		if (task.finalized || task.snapshot.status !== "running") {
			return;
		}
		const truncated = truncateBytes(line, this.limits.maxLineBytes);
		task.snapshot.lineCount++;
		task.snapshot.lastEvent = truncated;
		task.batchLines.push(truncated);
		if (task.batchLines.length >= this.limits.maxBatchLines) {
			this.flushBatch(task);
			return;
		}
		task.batchTimer ??= setTimeout(() => {
			task.batchTimer = undefined;
			this.flushBatch(task);
		}, this.limits.batchMs);
	}

	private flushBatch(task: MonitorTaskInternal): void {
		if (task.batchTimer) {
			clearTimeout(task.batchTimer);
			task.batchTimer = undefined;
		}
		if (task.batchLines.length === 0 || task.finalized || task.snapshot.status !== "running") {
			return;
		}
		const lines = task.batchLines.splice(0, this.limits.maxBatchLines);
		const now = Date.now();
		task.notificationTimestamps = task.notificationTimestamps.filter((timestamp) => now - timestamp < 60_000);
		if (task.notificationTimestamps.length >= this.limits.maxEventsPerMinute) {
			this.failAndStop(task, "Monitor produced too many notifications per minute");
			return;
		}
		if (!task.snapshot.persistent && task.snapshot.notificationCount >= this.limits.maxTotalEvents) {
			this.failAndStop(task, "Monitor produced too many notifications");
			return;
		}
		task.notificationTimestamps.push(now);
		task.snapshot.notificationCount++;
		const eventText = lines.join("\n");
		const notification = this.createNotification(task, "event", eventText);
		this.onNotification(notification);
		this.onMonitorOutput?.({
			monitorId: task.snapshot.id,
			lineCount: lines.length,
			preview: truncateBytes(eventText, 500),
		});
	}

	private failAndStop(task: MonitorTaskInternal, error: string): void {
		if (task.finalized) {
			return;
		}
		task.forceStatus = "failed";
		task.forceError = error;
		if (task.child.pid) {
			killProcessTree(task.child.pid);
		} else {
			this.finalize(task, undefined);
		}
	}

	private finalize(task: MonitorTaskInternal, exitCode: number | undefined): void {
		if (task.finalized) {
			return;
		}
		if (task.batchTimer) {
			clearTimeout(task.batchTimer);
			task.batchTimer = undefined;
		}
		if (task.timeoutTimer) {
			clearTimeout(task.timeoutTimer);
			task.timeoutTimer = undefined;
		}
		if (task.lineBuffer.length > 0) {
			this.enqueueLine(task, task.lineBuffer);
			task.lineBuffer = "";
		}
		this.flushBatch(task);
		task.finalized = true;
		const status = task.forceStatus ?? (exitCode === 0 ? "completed" : "failed");
		task.snapshot.status = status;
		task.snapshot.endedAt = Date.now();
		task.snapshot.exitCode = exitCode;
		task.snapshot.error =
			task.forceError ?? (status === "failed" ? `Monitor exited with code ${exitCode ?? "unknown"}` : undefined);
		task.outputStream.end();
		if (task.child.pid && process.platform !== "win32") {
			untrackDetachedChildPid(task.child.pid);
		}
		this.monitors.delete(task.snapshot.id);
		this.recent.unshift(this.clone(task.snapshot));
		if (this.recent.length > 20) {
			this.recent.splice(20);
		}
		this.onNotification(this.createNotification(task, status));
		this.onMonitorEnded?.(this.clone(task.snapshot));
	}

	private createNotification(
		task: MonitorTaskInternal,
		status: "event" | MonitorStatus,
		eventText?: string,
	): RuntimeNotification {
		return {
			id: `n_${randomBytes(6).toString("hex")}`,
			kind: "monitor",
			createdAt: Date.now(),
			source: { monitorId: task.snapshot.id },
			text: formatMonitorNotification(task.snapshot, status, eventText),
		};
	}

	private clone(snapshot: MonitorTaskSnapshot): MonitorTaskSnapshot {
		return { ...snapshot };
	}
}

function truncateBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) {
		return text;
	}
	return `${buffer.subarray(0, Math.max(0, maxBytes - 20)).toString("utf8")}...[truncated]`;
}

function formatMonitorNotification(
	monitor: MonitorTaskSnapshot,
	status: "event" | MonitorStatus,
	eventText?: string,
): string {
	const parts = [
		"<monitor-notification>",
		`<monitor-id>${xmlEscape(monitor.id)}</monitor-id>`,
		`<status>${xmlEscape(status)}</status>`,
		`<description>${xmlEscape(monitor.description)}</description>`,
		`<output-file>${xmlEscape(monitor.outputFile)}</output-file>`,
	];
	if (monitor.exitCode !== undefined) {
		parts.push(`<exit-code>${monitor.exitCode}</exit-code>`);
	}
	if (monitor.error) {
		parts.push(`<error>${xmlEscape(monitor.error)}</error>`);
	}
	if (eventText !== undefined) {
		parts.push("<event>", xmlEscape(eventText), "</event>");
	}
	parts.push("</monitor-notification>");
	return parts.join("\n");
}
