import { createHash } from "node:crypto";

export type MonitoringSnapshot = {
	collectedAt: string;
	mentions: number;
	citations: number;
	positions: Record<string, number>;
	competitors: string[];
	recommendationStatuses: Record<string, string>;
};

export type MonitoringChange = {
	metric: string;
	before: unknown;
	after: unknown;
	direction: "improved" | "declined" | "changed";
};

export function compareMonitoringSnapshots(
	previous: MonitoringSnapshot,
	current: MonitoringSnapshot,
): MonitoringChange[] {
	const changes: MonitoringChange[] = [];
	const compareNumber = (metric: string, before: number, after: number) => {
		if (before !== after) changes.push({ metric, before, after, direction: after > before ? "improved" : "declined" });
	};
	compareNumber("mentions", previous.mentions, current.mentions);
	compareNumber("citations", previous.citations, current.citations);
	for (const key of new Set([...Object.keys(previous.positions), ...Object.keys(current.positions)])) {
		const before = previous.positions[key] ?? null;
		const after = current.positions[key] ?? null;
		if (before !== after) changes.push({ metric: `position:${key}`, before, after, direction: "changed" });
	}
	if (JSON.stringify([...previous.competitors].sort()) !== JSON.stringify([...current.competitors].sort())) {
		changes.push({
			metric: "competitors",
			before: previous.competitors,
			after: current.competitors,
			direction: "changed",
		});
	}
	for (const key of new Set([
		...Object.keys(previous.recommendationStatuses),
		...Object.keys(current.recommendationStatuses),
	])) {
		const before = previous.recommendationStatuses[key] ?? null;
		const after = current.recommendationStatuses[key] ?? null;
		if (before !== after) changes.push({ metric: `recommendation:${key}`, before, after, direction: "changed" });
	}
	return changes;
}

export type MonitoringCyclePlan = {
	cycleId: string;
	dispatchKey: string;
	state: "READY" | "BUDGET_BLOCKED" | "CARDINALITY_BLOCKED" | "DUPLICATE";
	reason?: string;
};

export function planMonitoringCycle(input: {
	cycleId: string;
	projectId: string;
	expectedRuns: number;
	estimatedCost: number;
	budgetCap: number;
	existingDispatchKeys?: string[];
}): MonitoringCyclePlan {
	const dispatchKey = createHash("sha256").update(`${input.projectId}:${input.cycleId}`).digest("hex");
	if (input.existingDispatchKeys?.includes(dispatchKey))
		return { cycleId: input.cycleId, dispatchKey, state: "DUPLICATE" };
	if (input.expectedRuns < 1 || input.expectedRuns > 100)
		return {
			cycleId: input.cycleId,
			dispatchKey,
			state: "CARDINALITY_BLOCKED",
			reason: "expectedRuns must be between 1 and 100",
		};
	if (input.estimatedCost > input.budgetCap)
		return {
			cycleId: input.cycleId,
			dispatchKey,
			state: "BUDGET_BLOCKED",
			reason: "estimated cost exceeds cycle budget",
		};
	return { cycleId: input.cycleId, dispatchKey, state: "READY" };
}
