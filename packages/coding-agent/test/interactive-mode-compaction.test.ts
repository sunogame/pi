import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode compaction events", () => {
	test("rebuilds chat after transcript changes from compaction", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			tuiExtensionRunner: { emitRuntimeEvent: vi.fn(async () => {}) },
			createTuiExtensionContext: vi.fn(() => ({})),
			chatContainer: { clear: vi.fn() },
			renderRuntimeSnapshot: vi.fn(),
			runtimeSnapshot: { transcript: { entries: [] } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleRuntimeEvent") as (
			this: typeof fakeThis,
			event: {
				type: "transcript_changed";
				reason: "compaction";
				id: number;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "transcript_changed",
			reason: "compaction",
			id: 1,
		});
		await Promise.resolve();

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.renderRuntimeSnapshot).toHaveBeenCalledWith(fakeThis.runtimeSnapshot, { updateFooter: true });
	});
});
