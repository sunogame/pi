import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	CombinedAutocompleteProvider,
	Container,
	ProcessTerminal,
	type SlashCommand,
	setKeybindings,
	Text,
	TUI,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import type { AgentRuntimeEvent, AgentRuntimeSnapshot } from "../core/agent-runtime-snapshot.ts";
import { FooterDataProvider } from "../core/footer-data-provider.ts";
import { createIpcRuntimeClient, type IpcRuntimeClient } from "../core/ipc-runtime-client.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { createStreamRuntimeTransport } from "../core/runtime-transport.ts";
import { CustomEditor } from "./interactive/components/custom-editor.ts";
import { RuntimeFooterComponent } from "./interactive/components/footer.ts";
import { RuntimeTranscriptView } from "./interactive/runtime-transcript-view.ts";
import { getEditorTheme, initTheme, theme } from "./interactive/theme/theme.ts";

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
	private readonly editor: CustomEditor;
	private readonly keybindings: KeybindingsManager;
	private readonly footerDataProvider: FooterDataProvider;
	private readonly footer: RuntimeFooterComponent;
	private stopped = false;
	private lastError: string | undefined;
	private childStderr = "";
	private unsubscribeStore?: () => void;
	private finish?: () => void;

	constructor(tui: TUI, client: IpcRuntimeClient, child: ChildProcessWithoutNullStreams) {
		this.tui = tui;
		this.client = client;
		this.child = child;
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		this.footerDataProvider = new FooterDataProvider(client.store.snapshot.agent.cwd);
		this.footer = new RuntimeFooterComponent(client.store.snapshot, this.footerDataProvider);
		this.transcript = new RuntimeTranscriptView({
			tui,
			cwd: client.store.snapshot.agent.cwd,
			onPopulateHistory: (text) => this.editor.addToHistory(text),
		});
		this.editor = new CustomEditor(tui, getEditorTheme(), this.keybindings, { paddingX: 1 });
		this.setupAutocompleteProvider(client.store.snapshot);
		this.editor.onSubmit = (text) => {
			void this.submit(text);
		};
		this.editor.onEscape = () => {
			void this.client.abort().catch((error: unknown) => {
				this.setError(error);
			});
		};
		this.editor.onCtrlD = () => {
			this.finish?.();
		};
		this.editor.onAction("app.clear", () => {
			this.editor.setText("");
		});

		this.root.addChild(this.status);
		this.root.addChild(this.transcript);
		this.root.addChild(this.help);
		this.root.addChild(this.editor);
		this.root.addChild(this.footer);
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
				this.footerDataProvider.dispose();
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
				this.renderStatus(this.client.store.snapshot);
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
				return undefined;
			});

			this.unsubscribeStore = this.client.store.subscribe((snapshot, event) => {
				this.renderStatus(snapshot);
				if (event) {
					this.handleRuntimeEvent(event, snapshot);
				} else {
					this.transcript.renderSnapshot(snapshot, { populateHistory: true });
				}
			});
			this.tui.start();
			this.renderSnapshot(this.client.store.snapshot);

			this.client
				.attach()
				.then(() => {
					this.renderSnapshot(this.client.store.snapshot);
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
		if (trimmed.startsWith("/")) {
			await this.executeRuntimeCommand(trimmed);
			return;
		}

		this.lastError = undefined;
		this.renderStatus(this.client.store.snapshot);
		await this.client.prompt(text).catch((error: unknown) => this.setError(error));
	}

	private async executeRuntimeCommand(input: string): Promise<void> {
		const command = parseRuntimeCommand(input);
		if (!command) {
			return;
		}
		this.lastError = undefined;
		try {
			const handled = await this.client.executeCommand(command.name, command.args);
			if (!handled) {
				this.status.setText(theme.fg("warning", `Unsupported command in attach mode: /${command.name}`));
				this.tui.requestRender();
			}
		} catch (error: unknown) {
			this.setError(error);
		}
	}

	private setError(error: unknown): void {
		this.lastError = error instanceof Error ? error.message : String(error);
		this.renderStatus(this.client.store.snapshot);
	}

	private renderSnapshot(snapshot: AgentRuntimeSnapshot): void {
		this.renderStatus(snapshot);
		this.transcript.renderSnapshot(snapshot, { populateHistory: true });
	}

	private renderStatus(snapshot: AgentRuntimeSnapshot): void {
		this.footerDataProvider.setCwd(snapshot.agent.cwd);
		this.footer.setSnapshot(snapshot);
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
		this.help.setText(chalk.dim("Enter sends prompt. Esc aborts. /abort aborts. /exit quits."));
		this.tui.requestRender();
	}

	private setupAutocompleteProvider(snapshot: AgentRuntimeSnapshot): void {
		const commands: SlashCommand[] = snapshot.commands
			.filter((command) => command.placement === "runtime")
			.map((command) => ({
				name: command.invocationName,
				description: command.description,
			}));
		this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, snapshot.agent.cwd));
	}

	private handleRuntimeEvent(event: AgentRuntimeEvent, snapshot: AgentRuntimeSnapshot): void {
		switch (event.type) {
			case "commands_changed":
				this.setupAutocompleteProvider(snapshot);
				break;
			case "message_start":
				this.transcript.handleMessageStart(event.message);
				break;
			case "message_delta":
				this.transcript.handleMessageDelta(event.message);
				break;
			case "message_end":
				this.transcript.handleMessageEnd(event.message, snapshot.run.retryAttempt);
				break;
			case "tool_start":
				this.transcript.handleToolStart(event.tool.toolName, event.tool.toolCallId, event.tool.input);
				break;
			case "tool_update":
				this.transcript.handleToolUpdate(event.toolCallId, event.patch);
				break;
			case "tool_end":
				this.transcript.handleToolEnd(
					event.tool.toolName,
					event.tool.toolCallId,
					event.tool.input,
					event.tool.result,
					event.tool.isError ?? false,
				);
				break;
			case "session_changed":
			case "transcript_changed":
				this.transcript.renderSnapshot(snapshot, { populateHistory: true });
				break;
			default:
				break;
		}
	}
}

export function parseRuntimeCommand(input: string): { name: string; args: string } | undefined {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) {
		return undefined;
	}
	const command = trimmed.slice(1).trim();
	if (!command) {
		return undefined;
	}
	const match = command.match(/^(\S+)(?:\s+([\s\S]*))?$/);
	if (!match) {
		return undefined;
	}
	return {
		name: match[1],
		args: match[2] ?? "",
	};
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
