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

	const declaredName = readString(frontmatter.name) ?? readString(frontmatter.id) ?? readString(frontmatter.role);
	if (declaredName && declaredName !== spec.id) {
		const source = cardPath ?? cwd;
		throw new Error(`A2A Agent Card name "${declaredName}" must match runtime id "${spec.id}" in ${source}`);
	}
	const name = spec.id;
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
	const peerCards = selfName ? cards.filter((card) => card.name !== selfName) : [...cards];

	const lines = [
		"<a2a_rules>",
		"Peer agents are available through A2A-style tools.",
		"Peer agents are opaque and do not share your private memory; include the necessary context when asking them to help.",
		"Use Agent Cards to choose the right peer.",
		"a2a_send_message creates a peer-owned A2A Task. Non-terminal tasks are watched automatically and later produce <a2a-task-notification> runtime notifications.",
		"<receiving>",
		"When you receive an <a2a-message>, answer it directly in the current turn. That assistant response completes the peer-owned Task.",
		"</receiving>",
		"<notifications>",
		"An <a2a-task-notification> is a runtime notification, not a human message.",
		"A notification message may contain multiple task notifications; handle each task id separately.",
		"If a watcher reports timeout or error, use a2a_get_task once for the latest status, then decide whether to retry, summarize uncertainty, or ask the user.",
		"</notifications>",
		"</a2a_rules>",
		"",
		"<available_peer_agents>",
	];

	for (const card of peerCards) {
		lines.push(`  <agent_card name="${escapeXml(card.name)}">`);
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
