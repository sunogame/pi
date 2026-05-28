import { describe, expect, it } from "vitest";
import { readXmlTag, xmlEscape } from "../src/utils/xml.ts";

describe("xml utils", () => {
	it("escapes and reads XML tag text", () => {
		const text = 'talking about <text> tags & "quotes"';
		const raw = `<text>${xmlEscape(text)}</text>`;

		expect(readXmlTag(raw, "text")).toBe(text);
	});

	it("reads through unescaped nested same-name tags when input is malformed", () => {
		const raw = "<text>outer <text>inner</text> tail</text>";

		expect(readXmlTag(raw, "text")).toBe("outer <text>inner</text> tail");
	});
});
