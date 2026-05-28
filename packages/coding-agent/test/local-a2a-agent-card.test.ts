import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatTeamAgentCardsForPrompt, loadTeamAgentCards } from "../src/core/a2a-agent-card.ts";

describe("local A2A Agent Cards", () => {
	it("loads minimal Agent Card frontmatter from runtime AGENTS.md files", ({ task }) => {
		const root = join("/tmp", `pi-a2a-${task.id}`);
		const backend = join(root, "backend");
		mkdirSync(backend, { recursive: true });
		writeFileSync(
			join(backend, "AGENTS.md"),
			`---
name: backend
description: Handles APIs and persistence.
---

# Backend
`,
			"utf8",
		);

		const cards = loadTeamAgentCards([{ id: "backend", cwd: "./backend" }], root);

		expect(cards).toMatchObject([
			{
				name: "backend",
				description: "Handles APIs and persistence.",
				defaultInputModes: ["text/plain"],
				defaultOutputModes: ["text/plain"],
			},
		]);
	});

	it("formats a concise prompt block without exposing url or skills", () => {
		const prompt = formatTeamAgentCardsForPrompt(
			[
				{
					name: "backend",
					description: "Handles APIs.",
					version: "1.0.0",
					capabilities: {},
					defaultInputModes: ["text/plain"],
					defaultOutputModes: ["text/plain"],
					cwd: "/work/backend",
					url: "pi-runtime://backend",
				},
			],
			"backend",
		);

		expect(prompt).toContain('<agent_card name="backend" self="true">');
		expect(prompt).toContain("<description>Handles APIs.</description>");
		expect(prompt).not.toContain("pi-runtime://backend");
		expect(prompt).not.toContain("<skills>");
	});
});
