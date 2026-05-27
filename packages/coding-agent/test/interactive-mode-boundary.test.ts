import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("InteractiveMode runtime boundary", () => {
	it("does not import AgentSession directly", () => {
		const source = readFileSync(join(process.cwd(), "src/modes/interactive/interactive-mode.ts"), "utf8");

		expect(source).not.toMatch(
			/import\s+\{[^}]*\bAgentSession\b[^}]*\}\s+from\s+["']\.\.\/\.\.\/core\/agent-session\.ts["']/,
		);
		expect(source).not.toContain("type AgentSession,");
	});
});
