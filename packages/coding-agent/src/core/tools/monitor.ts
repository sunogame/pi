import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
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
	};
}

export function createMonitorTool(monitorManager?: MonitorManager): AgentTool<typeof monitorSchema> {
	return wrapToolDefinition(createMonitorToolDefinition(monitorManager));
}
