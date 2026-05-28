export function xmlEscape(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function xmlUnescape(text: string): string {
	return text
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&amp;/g, "&");
}

export function readXmlTag(raw: string, tag: string): string | undefined {
	const open = `<${tag}>`;
	const close = `</${tag}>`;
	const start = raw.indexOf(open);
	if (start === -1) {
		return undefined;
	}
	const end = raw.lastIndexOf(close);
	if (end === -1 || end < start + open.length) {
		return undefined;
	}
	return xmlUnescape(raw.slice(start + open.length, end).trim());
}
