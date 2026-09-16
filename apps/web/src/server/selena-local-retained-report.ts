import { createHash } from "node:crypto";
import { buildUniversalReportView, universalReportSchema } from "./selena-universal-report";

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b, "en"))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
export function retainedReportHash(value: unknown) {
	return createHash("sha256").update(canonical(value)).digest("hex");
}
export function prepareRetainedLocalReport(value: unknown, scope: { organizationId: string; projectId: string }) {
	const report = universalReportSchema.parse(value);
	buildUniversalReportView(report, scope);
	if (report.measurementMode !== "PROVIDER") throw new Error("PRODUCTION_FIXTURE_REPORT_FORBIDDEN");
	return { report, contentHash: retainedReportHash(report) };
}
