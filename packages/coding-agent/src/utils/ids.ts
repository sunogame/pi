export function shortId(id: string, length = 8): string {
	return id.length > length ? id.slice(0, length) : id;
}
