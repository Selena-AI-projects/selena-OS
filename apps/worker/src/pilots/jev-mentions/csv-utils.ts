export function csvField(value: unknown): string {
	return `"${String(value).replace(/"/g, '""')}"`;
}
