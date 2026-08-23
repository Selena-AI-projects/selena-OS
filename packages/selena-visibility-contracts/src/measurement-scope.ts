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
		systems: z
			.array(z.object({ systemId: z.string().min(1), channel: z.enum(measurementChannels) }))
			.min(1),
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

/**
 * Who a measurement looks for in an answer, frozen into the lock alongside the
 * scope. Reading these from the live profile instead would let a report change
 * under a customer who edited their competitor list afterwards — the lock is
 * what the run was sold against, so it answers this too.
 */
export const analysisSubjectSchema = z.object({
	name: z.string().min(1),
	aliases: z.array(z.string().min(1)).optional(),
	domain: z.string().min(1).optional(),
});

export const analysisSubjectsSchema = z.object({
	brand: analysisSubjectSchema,
	competitors: z.array(analysisSubjectSchema).default([]),
});
export type AnalysisSubjects = z.infer<typeof analysisSubjectsSchema>;

/** Absent on locks written before subjects were frozen; malformed throws. */
export function parseAnalysisSubjects(snapshot: unknown): AnalysisSubjects | null {
	if (typeof snapshot !== "object" || snapshot === null) return null;
	const block = (snapshot as Record<string, unknown>).analysisSubjects;
	if (block === undefined || block === null) return null;
	return analysisSubjectsSchema.parse(block);
}
