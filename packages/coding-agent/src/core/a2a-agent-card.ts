import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parseFrontmatter } from "../utils/frontmatter.ts";

export interface PiA2AAgentCapabilities {
	streaming?: boolean;
	pushNotifications?: boolean;
	extendedAgentCard?: boolean;
}

export interface PiA2AAgentCard {
	name: string;
	description: string;
	version: string;
	capabilities: PiA2AAgentCapabilities;
	defaultInputModes: string[];
	defaultOutputModes: string[];
	cwd: string;
	cardPath?: string;
	url?: string;
}

export interface TeamRuntimeCardSpec {
	id: string;
	cwd?: string;
}

interface AgentCardFrontmatter extends Record<string, unknown> {
	id?: unknown;
	name?: unknown;
	role?: unknown;
	description?: unknown;
	url?: unknown;
	version?: unknown;
	capabilities?: unknown;
	defaultInputModes?: unknown;
	defaultOutputModes?: unknown;
	default_input_modes?: unknown;
	default_output_modes?: unknown;
	inputModes?: unknown;
	outputModes?: unknown;
	input_modes?: unknown;
	output_modes?: unknown;
}

export function loadTeamAgentCards(specs: TeamRuntimeCardSpec[], baseCwd = process.cwd()): PiA2AAgentCard[] {
	return specs.map((spec) => loadTeamAgentCard(spec, baseCwd));
}

export function loadTeamAgentCard(spec: TeamRuntimeCardSpec, baseCwd = process.cwd()): PiA2AAgentCard {
	const cwd = resolve(baseCwd, spec.cwd ?? ".");
	const cardPath = findAgentCardPath(cwd);
	let frontmatter: AgentCardFrontmatter = {};
	if (cardPath) {
		frontmatter = parseFrontmatter<AgentCardFrontmatter>(readFileSync(cardPath, "utf8")).frontmatter;
	}

	const name = readString(frontmatter.name) ?? readString(frontmatter.id) ?? readString(frontmatter.role) ?? spec.id;
	const defaultInputModes = readStringArray(
		frontmatter.defaultInputModes ??
			frontmatter.default_input_modes ??
			frontmatter.inputModes ??
			frontmatter.input_modes,
		["text/plain"],
	);
	const defaultOutputModes = readStringArray(
		frontmatter.defaultOutputModes ??
			frontmatter.default_output_modes ??
			frontmatter.outputModes ??
			frontmatter.output_modes,
		["text/plain"],
	);

	return {
		name,
		description: readString(frontmatter.description) ?? "",
		version: readString(frontmatter.version) ?? "1.0.0",
		capabilities: readCapabilities(frontmatter.capabilities),
		defaultInputModes,
		defaultOutputModes,
		cwd,
		cardPath,
		url: readString(frontmatter.url) ?? `pi-runtime://${name}`,
	};
}

export function formatTeamAgentCardsForPrompt(cards: readonly PiA2AAgentCard[], selfName?: string): string {
	if (cards.length === 0) {
		return "";
	}

	const lines = [
		"Peer agents are available through local A2A-style tools.",
		"Use Agent Cards to choose the right peer agent for a question or task.",
		"Peer agents are opaque: they do not share your private memory, filesystem, or tools. Include necessary context in your message.",
		"Use a2a_send_message to contact a peer. It returns an A2A Task; use a2a_get_task with the peer name and task id to check status and results. Leave blocking unset for normal peer messages, especially broadcasts. Set blocking=true only when you need to wait for one specific peer before continuing. Use a2a_cancel_task only when the remote task is no longer needed or should stop.",
		"",
		"<available_peer_agents>",
	];

	for (const card of cards) {
		const self = card.name === selfName ? ' self="true"' : "";
		lines.push(`  <agent_card name="${escapeXml(card.name)}"${self}>`);
		lines.push(`    <description>${escapeXml(card.description)}</description>`);
		lines.push(`    <default_input_modes>${card.defaultInputModes.map(escapeXml).join(", ")}</default_input_modes>`);
		lines.push(
			`    <default_output_modes>${card.defaultOutputModes.map(escapeXml).join(", ")}</default_output_modes>`,
		);
		lines.push("  </agent_card>");
	}

	lines.push("</available_peer_agents>");
	return lines.join("\n");
}

export function formatRelativeCardPath(card: PiA2AAgentCard, baseCwd = process.cwd()): string {
	return card.cardPath ? relative(baseCwd, card.cardPath) || basename(card.cardPath) : "";
}

function findAgentCardPath(cwd: string): string | undefined {
	for (const name of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
		const path = join(cwd, name);
		if (existsSync(path)) {
			return path;
		}
	}
	return undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown, fallback: string[] = []): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter(Boolean);
	}
	if (typeof value === "string") {
		return value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	}
	return fallback;
}

function readCapabilities(value: unknown): PiA2AAgentCapabilities {
	if (typeof value !== "object" || value === null) {
		return { streaming: false, pushNotifications: false, extendedAgentCard: false };
	}
	const record = value as Record<string, unknown>;
	return {
		streaming: record.streaming === true,
		pushNotifications: record.pushNotifications === true || record.push_notifications === true,
		extendedAgentCard: record.extendedAgentCard === true || record.extended_agent_card === true,
	};
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
