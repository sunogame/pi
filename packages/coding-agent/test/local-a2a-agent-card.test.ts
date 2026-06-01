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

	it("uses the runtime id as the Agent Card name even when frontmatter has another name", ({ task }) => {
		const root = join("/tmp", `pi-a2a-mismatch-${task.id}`);
		const backend = join(root, "backend");
		mkdirSync(backend, { recursive: true });
		writeFileSync(
			join(backend, "AGENTS.md"),
			`---
name: backend-srv
description: Handles APIs.
---
`,
			"utf8",
		);

		const cards = loadTeamAgentCards([{ id: "backend", cwd: "./backend" }], root);

		expect(cards[0]?.name).toBe("backend");
		expect(cards[0]?.description).toBe("Handles APIs.");
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
				{
					name: "qa",
					description: "Tests contracts.",
					version: "1.0.0",
					capabilities: {},
					defaultInputModes: ["text/plain"],
					defaultOutputModes: ["text/plain"],
					cwd: "/work/qa",
					url: "pi-runtime://qa",
				},
			],
			"backend",
		);

		expect(prompt).toContain("<a2a_rules>");
		expect(prompt).not.toContain('name="backend"');
		expect(prompt).toContain('<agent_card name="qa">');
		expect(prompt).toContain("<description>Tests contracts.</description>");
		expect(prompt).toContain("Non-terminal A2A tasks are watched automatically");
		expect(prompt).not.toContain("local A2A");
		expect(prompt).not.toContain("pi-runtime://backend");
		expect(prompt).not.toContain("<skills>");
	});
});
