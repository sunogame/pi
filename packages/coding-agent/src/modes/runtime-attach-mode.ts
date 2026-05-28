import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	CombinedAutocompleteProvider,
	Container,
	Loader,
	ProcessTerminal,
	type SlashCommand,
	Spacer,
	setKeybindings,
	Text,
	TUI,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { APP_NAME, APP_TITLE, VERSION } from "../config.ts";
import type { AgentRuntimeEvent, AgentRuntimeSnapshot } from "../core/agent-runtime-snapshot.ts";
import { FooterDataProvider } from "../core/footer-data-provider.ts";
import { createIpcRuntimeClient, type IpcRuntimeClient } from "../core/ipc-runtime-client.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import {
	listRuntimeRegistryEntries,
	readRuntimeRegistryEntry,
	removeRuntimeRegistryEntry,
} from "../core/runtime-registry.ts";
import { connectRuntimeSocket } from "../core/runtime-socket-transport.ts";
import { createStreamRuntimeTransport, type RuntimeTransport } from "../core/runtime-transport.ts";
import { CountdownTimer } from "./interactive/components/countdown-timer.ts";
import { CustomEditor } from "./interactive/components/custom-editor.ts";
import { RuntimeFooterComponent } from "./interactive/components/footer.ts";
import { keyHint, keyText, rawKeyHint } from "./interactive/components/keybinding-hints.ts";
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

export interface RuntimeAttachModeOptions {
	agentDir?: string;
	attach?: string;
	runtimeSocket?: string;
}

export async function runRuntimeAttachMode(
	args: readonly string[] = process.argv.slice(2),
	options: RuntimeAttachModeOptions = {},
): Promise<void> {
	const connection = await createRuntimeAttachConnection(args, options);
	const client = createIpcRuntimeClient(connection.transport, createPlaceholderSnapshot(connection.cwd));
	initTheme(undefined, true);
	const tui = new TUI(new ProcessTerminal(), true);
	const view = new RuntimeAttachView(tui, client, {
		agentDir: options.agentDir,
		child: connection.child,
	});

	await view.run();
}

async function createRuntimeAttachConnection(
	args: readonly string[],
	options: RuntimeAttachModeOptions,
): Promise<{ transport: RuntimeTransport; cwd: string; child?: ChildProcessWithoutNullStreams }> {
	if (options.runtimeSocket) {
		return {
			transport: await connectRuntimeSocket(options.runtimeSocket),
			cwd: process.cwd(),
		};
	}
	if (options.attach) {
		if (!options.agentDir) {
			throw new Error("--attach requires an agent directory");
		}
		const entry = readRuntimeRegistryEntry(options.agentDir, options.attach);
		if (!entry) {
			throw new Error(`No running runtime registered as "${options.attach}"`);
		}
		let transport: RuntimeTransport;
		try {
			transport = await connectRuntimeSocket(entry.socketPath);
		} catch (error) {
			removeRuntimeRegistryEntry(options.agentDir, options.attach);
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Registered runtime "${options.attach}" is unavailable: ${message}`);
		}
		return {
			transport,
			cwd: entry.cwd,
		};
	}

	const child = spawnRuntimeProcess(args);
	return {
		transport: createStreamRuntimeTransport(child.stdout, child.stdin),
		cwd: process.cwd(),
		child,
	};
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
	private client: IpcRuntimeClient;
	private child?: ChildProcessWithoutNullStreams;
	private readonly agentDir?: string;
	private readonly root = new Container();
	private readonly header = new RuntimeAttachHeader();
	private readonly runtimeBar = new Text("", 1, 0);
	private readonly statusContainer = new Container();
	private readonly transcript: RuntimeTranscriptView;
	private readonly pendingMessages = new RuntimePendingMessagesView();
	private readonly help = new Text("", 1, 0);
	private readonly editor: CustomEditor;
	private readonly keybindings: KeybindingsManager;
	private readonly footerDataProvider: FooterDataProvider;
	private readonly footer: RuntimeFooterComponent;
	private stopped = false;
	private lastError: string | undefined;
	private childStderr = "";
	private statusLoader: Loader | undefined;
	private retryCountdown: CountdownTimer | undefined;
	private statusKind: string | undefined;
	private toolOutputExpanded = false;
	private hideThinkingBlock = false;
	private unsubscribeStore?: () => void;
	private finish?: () => void;

	constructor(
		tui: TUI,
		client: IpcRuntimeClient,
		options: { agentDir?: string; child?: ChildProcessWithoutNullStreams },
	) {
		this.tui = tui;
		this.client = client;
		this.agentDir = options.agentDir;
		this.child = options.child;
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
		this.editor.onAction("app.tools.expand", () => {
			this.toolOutputExpanded = !this.toolOutputExpanded;
			this.transcript.updateOptions({ toolOutputExpanded: this.toolOutputExpanded });
			this.transcript.renderSnapshot(this.client.store.snapshot);
		});
		this.editor.onAction("app.thinking.toggle", () => {
			this.hideThinkingBlock = !this.hideThinkingBlock;
			this.transcript.updateOptions({ hideThinkingBlock: this.hideThinkingBlock });
			this.transcript.renderSnapshot(this.client.store.snapshot);
		});

		this.root.addChild(this.header);
		this.root.addChild(this.runtimeBar);
		this.root.addChild(this.statusContainer);
		this.root.addChild(this.transcript);
		this.root.addChild(this.pendingMessages);
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
				this.stopStatusLoader();
				this.footerDataProvider.dispose();
				this.client.close();
				if (this.child && !this.child.killed) {
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

			this.bindChildHandlers(finish);

			this.tui.addInputListener((data) => {
				if (data === "\x03" || data === "\x04") {
					finish();
					return { consume: true };
				}
				return undefined;
			});

			this.subscribeClient();
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
			if (await this.executeAttachCommand(trimmed)) {
				return;
			}
			await this.executeRuntimeCommand(trimmed);
			return;
		}

		this.lastError = undefined;
		this.renderStatus(this.client.store.snapshot);
		await this.client.prompt(text).catch((error: unknown) => this.setError(error));
	}

	private async executeAttachCommand(input: string): Promise<boolean> {
		const command = parseRuntimeCommand(input);
		if (!command) {
			return false;
		}
		if (command.name === "attach" || command.name === "switch") {
			const runtimeId = command.args.trim();
			if (!runtimeId) {
				this.showRuntimeList();
				return true;
			}
			await this.switchRuntime(runtimeId);
			return true;
		}
		if (command.name === "next" || command.name === "prev") {
			await this.switchAdjacentRuntime(command.name === "next" ? 1 : -1);
			return true;
		}
		if (command.name === "runtimes") {
			this.showRuntimeList();
			return true;
		}
		return false;
	}

	private async switchRuntime(runtimeId: string): Promise<void> {
		if (!this.agentDir) {
			this.showStatusMessage(theme.fg("warning", "Runtime registry is unavailable in this attach session."));
			return;
		}
		const entry = readRuntimeRegistryEntry(this.agentDir, runtimeId);
		if (!entry) {
			this.showStatusMessage(theme.fg("warning", `No running runtime registered as "${runtimeId}"`));
			return;
		}
		try {
			const transport = await connectRuntimeSocket(entry.socketPath);
			const nextClient = createIpcRuntimeClient(transport, createPlaceholderSnapshot(entry.cwd));
			await nextClient.attach();
			this.unsubscribeStore?.();
			this.unsubscribeStore = undefined;
			this.client.close();
			if (this.child && !this.child.killed) {
				this.child.kill("SIGTERM");
			}
			this.child = undefined;
			this.childStderr = "";
			this.lastError = undefined;
			this.client = nextClient;
			this.subscribeClient();
			this.setupAutocompleteProvider(this.client.store.snapshot);
			this.transcript.updateOptions({ cwd: this.client.store.snapshot.agent.cwd });
			this.renderSnapshot(this.client.store.snapshot);
		} catch (error) {
			this.setError(error);
		}
	}

	private async switchAdjacentRuntime(direction: 1 | -1): Promise<void> {
		if (!this.agentDir) {
			this.showStatusMessage(theme.fg("warning", "Runtime registry is unavailable in this attach session."));
			return;
		}
		const entries = listRuntimeRegistryEntries(this.agentDir);
		if (entries.length === 0) {
			this.showStatusMessage(theme.fg("muted", "No registered runtimes."));
			return;
		}
		const currentId = this.client.store.snapshot.agent.agentId;
		const currentIndex = Math.max(
			0,
			entries.findIndex((entry) => entry.agentId === currentId),
		);
		const nextIndex = (currentIndex + direction + entries.length) % entries.length;
		await this.switchRuntime(entries[nextIndex].agentId);
	}

	private showRuntimeList(): void {
		if (!this.agentDir) {
			this.showStatusMessage(theme.fg("warning", "Runtime registry is unavailable in this attach session."));
			return;
		}
		const entries = listRuntimeRegistryEntries(this.agentDir);
		if (entries.length === 0) {
			this.showStatusMessage(theme.fg("muted", "No registered runtimes."));
			return;
		}
		this.showStatusMessage(
			entries
				.map(
					(entry) =>
						`${entry.agentId}:${entry.status}${entry.agentId === this.client.store.snapshot.agent.agentId ? "*" : ""}`,
				)
				.join("  "),
		);
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
				this.showStatusMessage(theme.fg("warning", `Unsupported command in attach mode: /${command.name}`));
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
		this.header.renderSnapshot(snapshot);
		this.renderStatus(snapshot);
		this.transcript.renderSnapshot(snapshot, { populateHistory: true });
		this.pendingMessages.renderSnapshot(snapshot);
	}

	private renderStatus(snapshot: AgentRuntimeSnapshot): void {
		this.updateTerminalTitle(snapshot);
		this.header.renderSnapshot(snapshot);
		this.renderRuntimeBar(snapshot);
		this.footerDataProvider.setCwd(snapshot.agent.cwd);
		this.footer.setSnapshot(snapshot);
		this.pendingMessages.renderSnapshot(snapshot);
		this.tui.terminal.setProgress(snapshot.agent.status !== "idle" && snapshot.agent.status !== "waiting_input");
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
		this.renderRuntimeStatus(snapshot, statusParts.join("  "));
		this.help.setText(
			chalk.dim(
				"Enter sends prompt. Esc aborts. /attach <id> switches. /next cycles. /runtimes lists. /exit quits.",
			),
		);
		this.tui.requestRender();
	}

	private renderRuntimeBar(snapshot: AgentRuntimeSnapshot): void {
		if (!this.agentDir) {
			this.runtimeBar.setText("");
			return;
		}
		const entries = listRuntimeRegistryEntries(this.agentDir);
		if (entries.length === 0) {
			this.runtimeBar.setText(theme.fg("dim", "No registered runtimes."));
			return;
		}
		this.runtimeBar.setText(
			entries
				.map((entry) => {
					const active = entry.agentId === snapshot.agent.agentId;
					const label = `${entry.agentId}:${entry.status}`;
					return active ? theme.bold(theme.fg("accent", `[${label}]`)) : theme.fg("dim", label);
				})
				.join(theme.fg("muted", "  ")),
		);
	}

	private updateTerminalTitle(snapshot: AgentRuntimeSnapshot): void {
		const cwdName = snapshot.agent.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? snapshot.agent.cwd;
		const sessionName = snapshot.session.sessionName;
		this.tui.terminal.setTitle(
			sessionName ? `${APP_TITLE} - ${sessionName} - ${cwdName}` : `${APP_TITLE} - ${cwdName}`,
		);
	}

	private renderRuntimeStatus(snapshot: AgentRuntimeSnapshot, fallbackText: string): void {
		if (this.lastError || this.childStderr) {
			this.showStatusMessage(fallbackText);
			return;
		}

		switch (snapshot.agent.status) {
			case "running":
				this.showLoader("running", "Working...");
				break;
			case "compacting":
				this.showLoader("compacting", "Compacting context...");
				break;
			case "retrying":
				if (this.statusKind !== "retrying") {
					this.showLoader("retrying", "Retrying...");
				}
				break;
			case "waiting_input":
				this.showStatusMessage(fallbackText);
				break;
			case "error":
				this.showStatusMessage(theme.fg("error", fallbackText));
				break;
			case "idle":
				this.clearStatus();
				break;
		}
	}

	private showLoader(kind: string, message: string): void {
		if (this.statusKind === kind && this.statusLoader) {
			this.statusLoader.setMessage(message);
			return;
		}
		this.stopStatusLoader();
		this.statusKind = kind;
		this.statusContainer.clear();
		this.statusLoader = new Loader(
			this.tui,
			(spinner) => theme.fg(kind === "retrying" ? "warning" : "accent", spinner),
			(text) => theme.fg("muted", text),
			message,
		);
		this.statusContainer.addChild(this.statusLoader);
	}

	private showStatusMessage(message: string): void {
		this.stopStatusLoader();
		this.statusKind = "message";
		this.statusContainer.clear();
		this.statusContainer.addChild(new Text(message, 1, 0));
		this.tui.requestRender();
	}

	private clearStatus(): void {
		if (!this.statusKind && this.statusContainer.children.length === 0) {
			return;
		}
		this.stopStatusLoader();
		this.statusKind = undefined;
		this.statusContainer.clear();
	}

	private stopStatusLoader(): void {
		this.statusLoader?.stop();
		this.statusLoader = undefined;
		this.retryCountdown?.dispose();
		this.retryCountdown = undefined;
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
			case "queue_changed":
				this.pendingMessages.renderSnapshot(snapshot);
				break;
			case "auto_retry_start":
				this.showLoader("retrying", `Retrying (${event.attempt}/${event.maxAttempts})...`);
				this.retryCountdown?.dispose();
				this.retryCountdown = new CountdownTimer(
					event.delayMs,
					this.tui,
					(seconds) =>
						this.statusLoader?.setMessage(`Retrying (${event.attempt}/${event.maxAttempts}) in ${seconds}s...`),
					() => {
						this.retryCountdown = undefined;
					},
				);
				break;
			case "auto_retry_end":
				this.clearStatus();
				if (!event.success) {
					this.showStatusMessage(theme.fg("error", event.finalError ?? "Retry failed"));
				}
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

	private subscribeClient(): void {
		this.unsubscribeStore = this.client.store.subscribe((snapshot, event) => {
			this.renderStatus(snapshot);
			if (event) {
				this.handleRuntimeEvent(event, snapshot);
			} else {
				this.transcript.renderSnapshot(snapshot, { populateHistory: true });
			}
		});
	}

	private bindChildHandlers(finish: (error?: Error) => void): void {
		if (!this.child) {
			return;
		}
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
	}
}

class RuntimeAttachHeader extends Container {
	private renderedCursor: number | undefined;

	renderSnapshot(snapshot: AgentRuntimeSnapshot): void {
		if (this.renderedCursor === snapshot.eventCursor) {
			return;
		}
		this.renderedCursor = snapshot.eventCursor;
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.formatHeader(), 1, 0));
		const resources = this.formatResources(snapshot);
		if (resources) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(resources, 1, 0));
		}
		const diagnostics = this.formatDiagnostics(snapshot);
		if (diagnostics) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(diagnostics, 1, 0));
		}
		this.addChild(new Spacer(1));
	}

	private formatHeader(): string {
		const logo = theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${VERSION} attach`);
		const compactInstructions = [
			keyHint("app.interrupt", "interrupt"),
			rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
			rawKeyHint("/", "runtime commands"),
		].join(theme.fg("muted", " · "));
		const boundary = theme.fg("dim", "IPC attach: model/auth, session tree, and legacy extension UI are disabled.");
		return `${logo}\n${compactInstructions}\n${boundary}`;
	}

	private formatResources(snapshot: AgentRuntimeSnapshot): string {
		const sections: string[] = [];
		const agentsFiles = snapshot.resources.agentsFiles.map((file) => file.path);
		if (agentsFiles.length > 0) {
			sections.push(this.formatSection("Context", agentsFiles));
		}
		if (snapshot.resources.skills.length > 0) {
			sections.push(
				this.formatSection(
					"Skills",
					snapshot.resources.skills.map((skill) => skill.name),
				),
			);
		}
		if (snapshot.resources.promptTemplates.length > 0) {
			sections.push(
				this.formatSection(
					"Prompts",
					snapshot.resources.promptTemplates.map((prompt) => `/${prompt.name}`),
				),
			);
		}
		if (snapshot.resources.extensions.length > 0) {
			sections.push(
				this.formatSection(
					"Extensions",
					snapshot.resources.extensions.map((extension) => extension.path),
				),
			);
		}
		const themes = snapshot.resources.themes
			.map((theme) => theme.name ?? theme.sourcePath)
			.filter((value): value is string => value !== undefined);
		if (themes.length > 0) {
			sections.push(this.formatSection("Themes", themes));
		}
		return sections.join("\n");
	}

	private formatSection(name: string, values: string[]): string {
		const body = values
			.map((value) => value.trim())
			.filter((value) => value.length > 0)
			.sort((a, b) => a.localeCompare(b))
			.join(", ");
		return `${theme.fg("mdHeading", `[${name}]`)}\n${theme.fg("dim", `  ${body}`)}`;
	}

	private formatDiagnostics(snapshot: AgentRuntimeSnapshot): string {
		const diagnostics = [
			...snapshot.diagnostics.resources.map((diagnostic) => diagnostic.message),
			...snapshot.diagnostics.extensions.map((diagnostic) => `${diagnostic.path}: ${diagnostic.error}`),
		];
		if (diagnostics.length === 0) {
			return "";
		}
		return `${theme.fg("warning", "[Issues]")}\n${diagnostics
			.map((diagnostic) => theme.fg("dim", `  ${diagnostic}`))
			.join("\n")}`;
	}
}

class RuntimePendingMessagesView extends Container {
	private renderedKey = "";

	renderSnapshot(snapshot: AgentRuntimeSnapshot): void {
		const key = JSON.stringify(snapshot.run.pendingUserMessages);
		if (this.renderedKey === key) {
			return;
		}
		this.renderedKey = key;
		this.clear();
		if (snapshot.run.pendingUserMessages.length === 0) {
			return;
		}

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "[Queued messages]"), 1, 0));
		for (const message of snapshot.run.pendingUserMessages) {
			const label = message.kind === "follow_up" ? "follow-up" : "steer";
			this.addChild(new Text(`${theme.fg("accent", label)} ${theme.fg("dim", message.text)}`, 1, 0));
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
