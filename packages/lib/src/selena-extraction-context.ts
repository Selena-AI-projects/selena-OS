import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import * as schema from "./db/schema";
import type { ExtractionContext } from "./selena-answer-extraction";
import type { SelenaExecutablePermit } from "./selena-measurement";

/**
 * What an answer is measured against: the brand's own names and domain, and
 * the competitors the customer confirmed.
 *
 * The terms come from the confirmed project profile rather than from anything
 * inferred at run time, so a stored measurement can be re-derived from its raw
 * response and the same profile. Where the configuration lock carries its own
 * profile block that block wins: a cycle is sold against the locked
 * configuration, and a profile edited mid-cycle must not silently change what
 * earlier runs were measured against.
 */

const competitorSchema = z.object({ name: z.string(), domains: z.array(z.string()).default([]) });
const competitorSnapshotSchema = z.array(competitorSchema);
const lockedProfileSchema = z.object({
	brandName: z.string(),
	primaryDomain: z.string(),
	competitorSnapshot: competitorSnapshotSchema.default([]),
});

export type ExtractionProfile = {
	brandName: string;
	primaryDomain: string;
	competitorSnapshot: unknown;
};

/** The registrable host of a domain or URL, without www; "" when unusable. */
export function hostOf(value: string): string {
	const trimmed = value.trim().toLowerCase();
	if (trimmed === "") return "";
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
	try {
		return new URL(withScheme).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function distinct(values: string[]): string[] {
	const seen = new Set<string>();
	return values
		.map((value) => value.trim())
		.filter((value) => {
			const key = value.toLowerCase();
			if (value === "" || seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

/**
 * Reads a profile block off a configuration-lock snapshot. Absence is a legal
 * state and returns null; a present but malformed block is corruption and
 * throws, so a broken lock costs the measurement instead of quietly falling
 * back to a profile the cycle was not sold against.
 */
export function parseLockedProfile(snapshot: unknown): ExtractionProfile | null {
	if (typeof snapshot !== "object" || snapshot === null) return null;
	const block = (snapshot as Record<string, unknown>).profile;
	if (block === undefined || block === null) return null;
	return lockedProfileSchema.parse(block);
}

export function buildExtractionContext(input: {
	profile: ExtractionProfile;
	language: string;
	region?: string;
}): ExtractionContext {
	const { profile, language, region } = input;
	const brandName = profile.brandName.trim();
	if (brandName === "") throw new Error("SELENA_EXTRACTION_BRAND_MISSING");
	const parsedLanguage = language.trim();
	if (parsedLanguage === "") throw new Error("SELENA_EXTRACTION_LANGUAGE_MISSING");
	const brandHost = hostOf(profile.primaryDomain);

	const snapshot = competitorSnapshotSchema.safeParse(profile.competitorSnapshot);
	if (!snapshot.success) throw new Error("SELENA_COMPETITOR_SNAPSHOT_INVALID");

	const trimmedRegion = region?.trim();
	return {
		// The canonical name leads: the contract stores brandTerms[0] as the
		// brand the row was measured for. The domain is a term too, and the
		// competitors get the same treatment below — naming a site is naming the
		// entity, and giving only one side domain matching would bias the share.
		brandTerms: distinct([brandName, brandHost]),
		// Only the brand's own domain is owned. A public profile on a shared
		// platform is not: counting instagram.com as owned would mark a citation
		// of any competitor's page there as the brand's own source.
		ownedDomains: brandHost === "" ? [] : [brandHost],
		competitors: snapshot.data
			.map((competitor) => ({
				name: competitor.name.trim(),
				terms: distinct([competitor.name, ...competitor.domains.map(hostOf)]),
			}))
			.filter((competitor) => competitor.name !== "" && competitor.terms.length > 0),
		language: parsedLanguage,
		...(trimmedRegion === undefined || trimmedRegion === "" ? {} : { region: trimmedRegion }),
	};
}

type Db = NodePgDatabase<typeof schema>;

/**
 * The two per-permit lookups a live adapter needs. They live here rather than
 * in the adapters so those keep no database imports: a permit carries ids, and
 * resolving them is the caller's job.
 */
export function createSelenaMeasurementResolvers(db: Db) {
	const scenarioFor = async (permit: SelenaExecutablePermit) => {
		const [scenario] = await db
			.select({ text: schema.svScenarios.text, language: schema.svScenarios.language })
			.from(schema.svScenarios)
			.where(
				and(eq(schema.svScenarios.id, permit.scenarioId), eq(schema.svScenarios.organizationId, permit.organizationId)),
			)
			.limit(1);
		if (!scenario) throw new Error("SELENA_SCENARIO_NOT_FOUND");
		return scenario;
	};

	const cycleContextFor = async (permit: SelenaExecutablePermit) => {
		const [row] = await db
			.select({
				projectId: schema.svProjects.id,
				region: schema.svProjects.region,
				country: schema.svProjects.country,
				lockSnapshot: schema.svConfigurationLocks.snapshot,
			})
			.from(schema.svCycles)
			.innerJoin(schema.svOrders, eq(schema.svOrders.id, schema.svCycles.orderId))
			.innerJoin(schema.svProjects, eq(schema.svProjects.id, schema.svOrders.projectId))
			.innerJoin(schema.svConfigurationLocks, eq(schema.svConfigurationLocks.id, schema.svCycles.lockId))
			.where(and(eq(schema.svCycles.id, permit.cycleId), eq(schema.svCycles.organizationId, permit.organizationId)))
			.limit(1);
		if (!row) throw new Error("SELENA_CYCLE_NOT_FOUND");
		return row;
	};

	const profileFor = async (permit: SelenaExecutablePermit, projectId: string): Promise<ExtractionProfile> => {
		const [profile] = await db
			.select({
				brandName: schema.svProjectProfiles.brandName,
				primaryDomain: schema.svProjectProfiles.primaryDomain,
				competitorSnapshot: schema.svProjectProfiles.competitorSnapshot,
			})
			.from(schema.svProjectProfiles)
			.where(
				and(
					eq(schema.svProjectProfiles.projectId, projectId),
					eq(schema.svProjectProfiles.organizationId, permit.organizationId),
				),
			)
			.limit(1);
		if (!profile) throw new Error("SELENA_PROJECT_PROFILE_NOT_FOUND");
		return profile;
	};

	return {
		resolveScenarioText: async (permit: SelenaExecutablePermit): Promise<string> => (await scenarioFor(permit)).text,
		resolveExtractionContext: async (permit: SelenaExecutablePermit): Promise<ExtractionContext> => {
			const [scenario, cycle] = await Promise.all([scenarioFor(permit), cycleContextFor(permit)]);
			const profile = parseLockedProfile(cycle.lockSnapshot) ?? (await profileFor(permit, cycle.projectId));
			return buildExtractionContext({
				profile,
				language: scenario.language,
				region: cycle.region ?? cycle.country,
			});
		},
	};
}
