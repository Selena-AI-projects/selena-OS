import { z } from "zod";
// Type-only import: a value import would create a circular module evaluation
// with index.ts, which re-exports this file.
import type { SystemChannel } from "./index.js";

const measurementChannels = ["VISITOR", "API"] as const satisfies readonly SystemChannel[];

// The dispatch key omits channel, so a system listed twice (even on different
// channels) or a repeated scenario would collide; the scope must be a set.
export const measurementScopeSchema = z
	.object({
		scenarios: z.array(z.string().uuid()).min(1),
		systems: z.array(z.object({ systemId: z.string().min(1), channel: z.enum(measurementChannels) })).min(1),
		repeats: z.number().int().min(1),
	})
	.refine((scope) => new Set(scope.scenarios).size === scope.scenarios.length, "Scenarios must be unique")
	.refine(
		(scope) => new Set(scope.systems.map((system) => system.systemId)).size === scope.systems.length,
		"Systems must be unique",
	);
export type MeasurementScope = z.infer<typeof measurementScopeSchema>;

export function expectedRunsFromScope(scope: MeasurementScope): number {
	return scope.scenarios.length * scope.systems.length * scope.repeats;
}

/**
 * Reads the measurement scope block from a configuration-lock snapshot.
 * Absence is a legal state (older locks predate the block) and returns null;
 * a present but malformed block is corruption and throws.
 */
export function parseMeasurementScope(snapshot: unknown): MeasurementScope | null {
	if (typeof snapshot !== "object" || snapshot === null) return null;
	const block = (snapshot as Record<string, unknown>).measurementScope;
	if (block === undefined || block === null) return null;
	return measurementScopeSchema.parse(block);
}
