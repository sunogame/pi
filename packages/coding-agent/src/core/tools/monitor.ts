import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { MonitorManager, MonitorTaskSnapshot } from "../monitor-manager.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const monitorSchema = Type.Object({
	command: Type.String({
		description: "Shell command to run as a background monitor. Each stdout line is an event notification.",
	}),
	description: Type.String({
		description: "Short label shown in monitor notifications and task lists.",
	}),
	persistent: Type.Optional(
		Type.Boolean({
			description: "Keep watching until stopped or the session exits. Defaults to false.",
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description: "Maximum runtime in seconds for this monitor. Non-persistent monitors default to 600 seconds.",
		}),
	),
});

export type MonitorToolInput = Static<typeof monitorSchema>;
export type MonitorToolDetails = MonitorTaskSnapshot;

function formatMonitorCall(args: Partial<MonitorToolInput> | undefined, theme: Theme): string {
	const description = args?.description?.trim();
	const label = description ? theme.fg("accent", description) : theme.fg("toolOutput", "...");
	const suffix = args?.persistent ? theme.fg("muted", " persistent") : "";
	return `${theme.fg("toolTitle", theme.bold("monitor"))} ${label}${suffix}`;
}

function formatMonitorResult(details: MonitorTaskSnapshot | undefined, theme: Theme): string {
	if (!details) {
		return theme.fg("toolOutput", "Monitor started");
	}
	const status =
		details.status === "running"
			? theme.fg("success", "started")
			: details.status === "failed"
				? theme.fg("error", "failed")
				: details.status === "stopped"
					? theme.fg("warning", "stopped")
					: theme.fg("success", "completed");
	const pieces = [
		`${theme.fg("toolTitle", theme.bold("Monitor"))} ${status}`,
		theme.fg("muted", details.id),
		theme.fg("muted", details.outputFile),
	];
	if (details.exitCode !== undefined) {
		pieces.push(theme.fg("muted", `exit ${details.exitCode}`));
	}
	if (details.error) {
		pieces.push(theme.fg("error", details.error));
	}
	return pieces.join(" · ");
}

export function createMonitorToolDefinition(
	monitorManager?: MonitorManager,
): ToolDefinition<typeof monitorSchema, MonitorToolDetails> {
	return {
		name: "monitor",
		label: "monitor",
		description:
			"Start a background monitor that streams events from a long-running shell command. Each stdout line is an event; notifications arrive in the chat while you keep working. Notifications are runtime events, not user replies. Use selective filters, use grep --line-buffered in pipelines, redirect stderr with 2>&1 only if stderr should notify, and cover both success and failure terminal states. Monitors that produce too many events may be stopped automatically.",
		promptSnippet: "Start background monitors for log tails, readiness checks, CI polling, and recurring events.",
		promptGuidelines: [
			"Use monitor when each stdout line should become an event notification.",
			"Keep monitor output selective; raw noisy logs can flood the conversation.",
			"Use grep --line-buffered in pipelines so events are not delayed by buffering.",
			"stderr is written to the monitor output file but does not notify unless the command redirects it with 2>&1.",
			"Notifications are runtime events and are not replies from the user.",
		],
		parameters: monitorSchema,
		async execute(_toolCallId, params: MonitorToolInput, signal?: AbortSignal) {
			if (!monitorManager) {
				throw new Error("Monitor tool is unavailable in this context");
			}
			if (signal?.aborted) {
				throw new Error("Monitor start aborted");
			}
			const monitor = monitorManager.start({
				command: params.command,
				description: params.description,
				persistent: params.persistent,
				timeoutSeconds: params.timeoutSeconds,
			});
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(
							{
								monitorId: monitor.id,
								status: monitor.status,
								description: monitor.description,
								outputFile: monitor.outputFile,
							},
							null,
							2,
						),
					},
				],
				details: monitor,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatMonitorCall(args, theme));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatMonitorResult(result.details, theme));
			return text;
		},
	};
}

export function createMonitorTool(monitorManager?: MonitorManager): AgentTool<typeof monitorSchema> {
	return wrapToolDefinition(createMonitorToolDefinition(monitorManager));
}
