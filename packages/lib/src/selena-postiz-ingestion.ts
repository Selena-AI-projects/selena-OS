import { sha256 } from "./selena-control-room";

export const POSTIZ_ANALYTICS_DEFINITION_VERSION = "postiz.analytics/v1";

export type PostizAnalyticsPayload = Array<{
	data: Array<{ date: string; total: number | string }>;
	label: string;
	percentageChange?: number;
}>;

export type NormalizedPostizAnalytics = {
	definitionVersion: typeof POSTIZ_ANALYTICS_DEFINITION_VERSION;
	payloadSha256: string;
	values: {
		metrics: Record<string, { percentageChange: number | null; points: Array<{ observedOn: string; total: number }> }>;
		provider: "postiz";
	};
};

export type PostizPerformanceSnapshot = {
	capturedAt: string;
	checkpoint: "analytics";
	definitionVersion: typeof POSTIZ_ANALYTICS_DEFINITION_VERSION;
	payload: PostizAnalyticsPayload;
	payloadSha256: string;
	quality: "COMPLETE";
	requestKey: string;
	values: NormalizedPostizAnalytics["values"];
	windowEndedAt: string;
	windowStartedAt: string;
};

function metricKey(label: string): string {
	const value = label
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!value) throw new Error("Postiz analytics metric label is invalid");
	return value;
}

function metricTotal(value: number | string): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Postiz analytics total is invalid");
	return parsed;
}

function observedOn(value: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) throw new Error("Postiz analytics date is invalid");
	return parsed.toISOString();
}

/**
 * Converts a Postiz analytics response into a versioned, immutable value
 * object. The raw response remains the provenance payload; no inferred values
 * are added here.
 */
export function normalizePostizAnalytics(payload: PostizAnalyticsPayload): NormalizedPostizAnalytics {
	if (!Array.isArray(payload)) throw new Error("Postiz analytics payload must be an array");
	const metrics: NormalizedPostizAnalytics["values"]["metrics"] = {};
	for (const metric of payload) {
		if (!metric || typeof metric.label !== "string" || !Array.isArray(metric.data)) {
			throw new Error("Postiz analytics payload is invalid");
		}
		const key = metricKey(metric.label);
		if (metrics[key]) throw new Error("Postiz analytics has duplicate normalized metric labels");
		metrics[key] = {
			percentageChange:
				typeof metric.percentageChange === "number" && Number.isFinite(metric.percentageChange)
					? metric.percentageChange
					: null,
			points: metric.data.map((point) => ({ observedOn: observedOn(point.date), total: metricTotal(point.total) })),
		};
	}
	return {
		definitionVersion: POSTIZ_ANALYTICS_DEFINITION_VERSION,
		payloadSha256: sha256(payload),
		values: { metrics, provider: "postiz" },
	};
}

function isoTimestamp(value: string, name: string): string {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) throw new Error(`${name} is invalid`);
	return parsed.toISOString();
}

/**
 * Prepares an immutable, provider-attributed snapshot before a database
 * boundary persists its raw payload and normalized values together.
 */
export function createPostizPerformanceSnapshot(input: {
	capturedAt: string;
	payload: PostizAnalyticsPayload;
	publicationAttemptId: string;
	windowEndedAt: string;
	windowStartedAt: string;
}): PostizPerformanceSnapshot {
	if (!input.publicationAttemptId) throw new Error("Postiz publication attempt ID is required");
	const windowStartedAt = isoTimestamp(input.windowStartedAt, "Postiz analytics window start");
	const windowEndedAt = isoTimestamp(input.windowEndedAt, "Postiz analytics window end");
	const capturedAt = isoTimestamp(input.capturedAt, "Postiz analytics capture time");
	if (new Date(windowStartedAt) > new Date(windowEndedAt)) {
		throw new Error("Postiz analytics window is invalid");
	}
	const normalized = normalizePostizAnalytics(input.payload);
	return {
		capturedAt,
		checkpoint: "analytics",
		definitionVersion: normalized.definitionVersion,
		payload: input.payload,
		payloadSha256: normalized.payloadSha256,
		quality: "COMPLETE",
		requestKey: sha256({
			checkpoint: "postiz.analytics/v1",
			publicationAttemptId: input.publicationAttemptId,
			windowEndedAt,
			windowStartedAt,
		}),
		values: normalized.values,
		windowEndedAt,
		windowStartedAt,
	};
}
