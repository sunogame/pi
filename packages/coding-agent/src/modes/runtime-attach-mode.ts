import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	Container,
	Editor,
	type EditorTheme,
	ProcessTerminal,
	type SelectListTheme,
	Text,
	TUI,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { AgentRuntimeSnapshot } from "../core/agent-runtime-snapshot.ts";
import { createIpcRuntimeClient, type IpcRuntimeClient } from "../core/ipc-runtime-client.ts";
import { createStreamRuntimeTransport } from "../core/runtime-transport.ts";
import { RuntimeTranscriptView } from "./interactive/runtime-transcript-view.ts";
import { initTheme } from "./interactive/theme/theme.ts";

export function toRuntimeIpcArgs(args: readonly string[]): string[] {
	const next = [...args];
	for (let i = 0; i < next.length - 1; i++) {
		if (next[i] === "--mode") {
			next[i + 1] = "runtime-ipc";
			return next;
		}
	}
	next.push("--mode", "runtime-ipc");
	return next;
}

export async function runRuntimeAttachMode(args: readonly string[] = process.argv.slice(2)): Promise<void> {
	const child = spawnRuntimeProcess(args);
	const client = createIpcRuntimeClient(
		createStreamRuntimeTransport(child.stdout, child.stdin),
		createPlaceholderSnapshot(process.cwd()),
	);
	initTheme(undefined, true);
	const tui = new TUI(new ProcessTerminal(), true);
	const view = new RuntimeAttachView(tui, client, child);

	await view.run();
}

function spawnRuntimeProcess(args: readonly string[]): ChildProcessWithoutNullStreams {
	const entrypoint = process.argv[1];
	if (!entrypoint) {
		throw new Error("Cannot start runtime IPC child process: missing CLI entrypoint");
	}

	return spawn(process.execPath, [entrypoint, ...toRuntimeIpcArgs(args)], {
		cwd: process.cwd(),
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

class RuntimeAttachView {
	private readonly tui: TUI;
	private readonly client: IpcRuntimeClient;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly root = new Container();
	private readonly status = new Text("", 1, 0);
	private readonly transcript: RuntimeTranscriptView;
	private readonly help = new Text("", 1, 0);
	private readonly editor: Editor;
	private stopped = false;
	private lastError: string | undefined;
	private childStderr = "";
	private unsubscribeStore?: () => void;
	private finish?: () => void;

	constructor(tui: TUI, client: IpcRuntimeClient, child: ChildProcessWithoutNullStreams) {
		this.tui = tui;
		this.client = client;
		this.child = child;
		this.transcript = new RuntimeTranscriptView({
			tui,
			cwd: client.store.snapshot.agent.cwd,
			onPopulateHistory: (text) => this.editor.addToHistory(text),
		});
		this.editor = new Editor(tui, createEditorTheme(), { paddingX: 1 });
		this.editor.onSubmit = (text) => {
			void this.submit(text);
		};

		this.root.addChild(this.status);
		this.root.addChild(this.transcript);
		this.root.addChild(this.help);
		this.root.addChild(this.editor);
		this.tui.addChild(this.root);
		this.tui.setFocus(this.editor);
	}

	async run(): Promise<void> {
		return new Promise((resolve, reject) => {
			const finish = (error?: Error) => {
				if (this.stopped) {
					return;
				}
				this.stopped = true;
				this.unsubscribeStore?.();
				this.client.close();
				if (!this.child.killed) {
					this.child.kill("SIGTERM");
				}
				this.tui.stop();
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			};
			this.finish = () => finish();

			this.child.stderr.on("data", (chunk: Buffer) => {
				this.childStderr = chunk.toString("utf8").trim().split("\n").at(-1) ?? "";
				this.render(this.client.store.snapshot);
			});
			this.child.on("error", (error) => finish(error));
			this.child.on("exit", (code, signal) => {
				if (!this.stopped) {
					finish(new Error(`Runtime IPC child exited (${signal ?? code ?? "unknown"})`));
				}
			});

			this.tui.addInputListener((data) => {
				if (data === "\x03" || data === "\x04") {
					finish();
					return { consume: true };
				}
				if (data === "\x1b") {
					void this.client.abort().catch((error: unknown) => {
						this.setError(error);
					});
					return { consume: true };
				}
				return undefined;
			});

			this.unsubscribeStore = this.client.store.subscribe((snapshot) => {
				this.render(snapshot);
			});
			this.tui.start();
			this.render(this.client.store.snapshot);

			this.client
				.attach()
				.then(() => {
					this.render(this.client.store.snapshot);
				})
				.catch((error: unknown) => {
					finish(error instanceof Error ? error : new Error(String(error)));
				});
		});
	}

	private async submit(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) {
			return;
		}
		this.editor.addToHistory(text);
		this.editor.setText("");

		if (trimmed === "/exit" || trimmed === "/quit") {
			this.finish?.();
			return;
		}
		if (trimmed === "/abort") {
			await this.client.abort().catch((error: unknown) => this.setError(error));
			return;
		}

		this.lastError = undefined;
		this.render(this.client.store.snapshot);
		await this.client.prompt(text).catch((error: unknown) => this.setError(error));
	}

	private setError(error: unknown): void {
		this.lastError = error instanceof Error ? error.message : String(error);
		this.render(this.client.store.snapshot);
	}

	private render(snapshot: AgentRuntimeSnapshot): void {
		const statusParts = [
			chalk.bold(snapshot.session.sessionName ?? snapshot.session.sessionId.slice(0, 8)),
			chalk.dim(snapshot.agent.cwd),
			formatStatus(snapshot),
		];
		if (this.lastError) {
			statusParts.push(chalk.red(this.lastError));
		} else if (this.childStderr) {
			statusParts.push(chalk.yellow(this.childStderr));
		}
		this.status.setText(statusParts.join("  "));
		this.transcript.renderSnapshot(snapshot);
		this.help.setText(chalk.dim("Enter sends prompt. Esc aborts. /abort aborts. /exit quits."));
		this.tui.requestRender();
	}
}

function formatStatus(snapshot: AgentRuntimeSnapshot): string {
	const status = snapshot.agent.status;
	const tools = snapshot.run.activeToolExecutions.length;
	const suffixes: string[] = [];
	if (snapshot.run.isStreaming) {
		suffixes.push("streaming");
	}
	if (snapshot.run.isBashRunning) {
		suffixes.push("bash");
	}
	if (tools > 0) {
		suffixes.push(`${tools} tool${tools === 1 ? "" : "s"}`);
	}
	return suffixes.length > 0 ? `${status} (${suffixes.join(", ")})` : status;
}

function createEditorTheme(): EditorTheme {
	const selectList: SelectListTheme = {
		selectedPrefix: (text) => chalk.cyan(text),
		selectedText: (text) => chalk.inverse(text),
		description: (text) => chalk.dim(text),
		scrollInfo: (text) => chalk.dim(text),
		noMatch: (text) => chalk.dim(text),
	};
	return {
		borderColor: (text) => chalk.dim(text),
		selectList,
	};
}

function createPlaceholderSnapshot(cwd: string): AgentRuntimeSnapshot {
	return {
		protocolVersion: 1,
		capabilities: [],
		eventCursor: 0,
		agent: {
			agentId: "runtime",
			cwd,
			model: {},
			thinkingLevel: "off",
			status: "idle",
		},
		session: {
			sessionId: "pending",
			sessionDir: "",
			currentLeafId: null,
		},
		transcript: {
			entries: [],
			currentLeafId: null,
		},
		run: {
			isStreaming: false,
			isBashRunning: false,
			retryAttempt: 0,
			pendingUserMessages: [],
			pendingApprovals: [],
			activeToolExecutions: [],
		},
		tools: {
			active: [],
			available: [],
		},
		resources: {
			skills: [],
			promptTemplates: [],
			themes: [],
			extensions: [],
			agentsFiles: [],
		},
		modelRegistry: {
			available: [],
		},
		diagnostics: {
			resources: [],
			extensions: [],
		},
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
