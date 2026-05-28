import type { TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Box;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;

		this.addChild(new Spacer(1));

		// Create box with purple background (used for default rendering)
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		// Remove previous content component
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.box);

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(this.message, { expanded: this._expanded }, theme);
				if (component) {
					// Custom renderer provides its own styled component
					this.customComponent = component;
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
		}

		const text = getCustomMessageText(this.message);
		if (this.message.customType === "monitor-notification") {
			const component = renderMonitorNotification(text);
			if (component) {
				this.customComponent = component;
				this.addChild(component);
				return;
			}
		}
		if (this.message.customType === "a2a-message") {
			const component = renderA2AMessage(text);
			if (component) {
				this.customComponent = component;
				this.addChild(component);
				return;
			}
		}
		if (this.message.customType === "a2a-task-notification") {
			const component = renderA2ATaskNotification(text);
			if (component) {
				this.customComponent = component;
				this.addChild(component);
				return;
			}
		}

		// Default rendering uses our box
		this.addChild(this.box);
		this.box.clear();

		// Default rendering: label + content
		const label = theme.fg("customMessageLabel", `\x1b[1m[${this.message.customType}]\x1b[22m`);
		this.box.addChild(new Text(label, 0, 0));
		this.box.addChild(new Spacer(1));

		this.box.addChild(
			new Markdown(text, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}
}

function getCustomMessageText(message: CustomMessage<unknown>): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

interface MonitorNotificationView {
	id?: string;
	status?: string;
	description?: string;
	outputFile?: string;
	exitCode?: string;
	error?: string;
	event?: string;
}

interface A2AMessageView {
	from?: string;
	messageId?: string;
	contextId?: string;
	taskId?: string;
	text?: string;
}

interface A2ATaskNotificationView {
	agent?: string;
	taskId?: string;
	contextId?: string;
	notificationStatus?: string;
	state?: string;
	message?: string;
	artifact?: string;
	error?: string;
}

function renderA2AMessage(raw: string): Component | undefined {
	const message = parseA2AMessage(raw);
	if (!message) {
		return undefined;
	}

	const container = new Container();
	const from = message.from ? ` from ${theme.fg("accent", message.from)}` : "";
	const header = `${theme.fg("accent", "●")} ${theme.fg("toolTitle", theme.bold("A2A message"))}${from}`;
	container.addChild(new Text(header, 0, 0));

	if (message.text) {
		const body = message.text
			.trimEnd()
			.split("\n")
			.map((line) => `  ${theme.fg("customMessageText", line)}`)
			.join("\n");
		container.addChild(new Text(body, 0, 0));
	}

	const meta: string[] = [];
	if (message.taskId) meta.push(`task ${shortId(message.taskId)}`);
	if (message.contextId) meta.push(`context ${shortId(message.contextId)}`);
	if (message.messageId) meta.push(`message ${shortId(message.messageId)}`);
	if (meta.length > 0) {
		container.addChild(new Text(theme.fg("muted", `  ${meta.join(" · ")}`), 0, 0));
	}

	return container;
}

function renderA2ATaskNotification(raw: string): Component | undefined {
	const notification = parseA2ATaskNotification(raw);
	if (!notification) {
		return undefined;
	}

	const container = new Container();
	const state = notification.state ?? notification.notificationStatus ?? "updated";
	const stateLabel =
		state === "completed"
			? theme.fg("success", state)
			: state === "failed" || state === "canceled" || state === "rejected"
				? theme.fg("error", state)
				: theme.fg("warning", state);
	const agent = notification.agent ? ` · ${theme.fg("accent", notification.agent)}` : "";
	const header = `${theme.fg("accent", "●")} ${theme.fg("toolTitle", theme.bold("A2A task"))} · ${stateLabel}${agent}`;
	container.addChild(new Text(header, 0, 0));

	const body = notification.artifact || notification.message;
	if (body) {
		container.addChild(
			new Text(
				body
					.trimEnd()
					.split("\n")
					.map((line) => `  ${theme.fg("customMessageText", line)}`)
					.join("\n"),
				0,
				0,
			),
		);
	}

	const meta: string[] = [];
	if (notification.taskId) meta.push(`task ${shortId(notification.taskId)}`);
	if (notification.contextId) meta.push(`context ${shortId(notification.contextId)}`);
	if (notification.error) meta.push(notification.error);
	if (meta.length > 0) {
		container.addChild(new Text(theme.fg(notification.error ? "error" : "muted", `  ${meta.join(" · ")}`), 0, 0));
	}

	return container;
}

function parseA2AMessage(raw: string): A2AMessageView | undefined {
	if (!raw.includes("<a2a-message>")) {
		return undefined;
	}
	return {
		from: readXmlTag(raw, "from"),
		messageId: readXmlTag(raw, "message-id"),
		contextId: readXmlTag(raw, "context-id"),
		taskId: readXmlTag(raw, "task-id"),
		text: readXmlTag(raw, "text"),
	};
}

function parseA2ATaskNotification(raw: string): A2ATaskNotificationView | undefined {
	if (!raw.includes("<a2a-task-notification>")) {
		return undefined;
	}
	return {
		agent: readXmlTag(raw, "agent"),
		taskId: readXmlTag(raw, "task-id"),
		contextId: readXmlTag(raw, "context-id"),
		notificationStatus: readXmlTag(raw, "notification-status"),
		state: readXmlTag(raw, "state"),
		message: readXmlTag(raw, "message"),
		artifact: readXmlTag(raw, "artifact"),
		error: readXmlTag(raw, "error"),
	};
}

function renderMonitorNotification(raw: string): Component | undefined {
	const notification = parseMonitorNotification(raw);
	if (!notification) {
		return undefined;
	}

	const container = new Container();
	const status = notification.status ?? "event";
	const isEvent = status === "event";
	const statusLabel =
		status === "completed"
			? theme.fg("success", "completed")
			: status === "failed"
				? theme.fg("error", "failed")
				: status === "stopped"
					? theme.fg("warning", "stopped")
					: theme.fg("accent", "event");
	const title = isEvent ? "Monitor event" : "Monitor";
	const description = notification.description ? ` · ${theme.fg("text", notification.description)}` : "";
	const header = `${theme.fg("accent", "●")} ${theme.fg("toolTitle", theme.bold(title))} · ${statusLabel}${description}`;
	container.addChild(new Text(header, 0, 0));

	if (notification.event) {
		const eventLines = notification.event
			.trimEnd()
			.split("\n")
			.map((line) => `  ${theme.fg("customMessageText", line)}`);
		container.addChild(new Text(eventLines.join("\n"), 0, 0));
	}

	const meta: string[] = [];
	if (notification.id) meta.push(notification.id);
	if (notification.outputFile) meta.push(notification.outputFile);
	if (notification.exitCode !== undefined) meta.push(`exit ${notification.exitCode}`);
	if (notification.error) meta.push(notification.error);
	if (meta.length > 0) {
		const color = notification.error ? "error" : "muted";
		container.addChild(new Text(theme.fg(color, `  ${meta.join(" · ")}`), 0, 0));
	}

	return container;
}

function shortId(id: string): string {
	return id.length > 8 ? id.slice(0, 8) : id;
}

function parseMonitorNotification(raw: string): MonitorNotificationView | undefined {
	if (!raw.includes("<monitor-notification>")) {
		return undefined;
	}
	return {
		id: readXmlTag(raw, "monitor-id"),
		status: readXmlTag(raw, "status"),
		description: readXmlTag(raw, "description"),
		outputFile: readXmlTag(raw, "output-file"),
		exitCode: readXmlTag(raw, "exit-code"),
		error: readXmlTag(raw, "error"),
		event: readXmlTag(raw, "event"),
	};
}

function readXmlTag(raw: string, tag: string): string | undefined {
	const match = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
	return match ? xmlUnescape(match[1].trim()) : undefined;
}

function xmlUnescape(text: string): string {
	return text
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&");
}
