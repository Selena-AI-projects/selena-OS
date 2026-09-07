import { createHash } from "node:crypto";
import { z } from "zod";

export const factStateSchema = z.enum(["VERIFIED", "UNKNOWN", "DISPUTED", "PROHIBITED"]);
export type FactState = z.infer<typeof factStateSchema>;

export const sourceRefSchema = z.object({
	uri: z.string().url().max(2048),
	title: z.string().trim().min(1).max(300).optional(),
	retrievedAt: z.string().datetime({ offset: true }).optional(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const factSchema = z.object({
	id: z.string().trim().min(1).max(120),
	statement: z.string().trim().min(1).max(2000),
	state: factStateSchema,
	sourceRefs: z.array(z.string().url().max(2048)).max(20).default([]),
	verifiedAt: z.string().datetime({ offset: true }).optional(),
	expiresAt: z.string().datetime({ offset: true }).optional(),
});
export type ProfileFact = z.infer<typeof factSchema>;

const nonEmptyStringArray = z
	.array(
		z
			.string()
			.trim()
			.regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/)
			.max(80),
	)
	.min(1)
	.max(20);
const boundedStringArray = z.array(z.string().trim().min(1).max(500)).max(20);

export const projectProfileInputSchema = z.object({
	languages: nonEmptyStringArray,
	audience: z.object({
		primary: z.string().trim().min(1).max(300),
		secondary: boundedStringArray.default([]),
		needs: boundedStringArray.default([]),
	}),
	voice: z.object({
		traits: boundedStringArray.min(1),
		examples: boundedStringArray.default([]),
		exclusions: boundedStringArray.default([]),
	}),
	ctaRules: boundedStringArray.default([]),
	visualRules: z.object({
		palette: boundedStringArray.default([]),
		imagery: boundedStringArray.default([]),
		avoid: boundedStringArray.default([]),
	}),
	claimRules: z.object({
		requireSources: z.boolean().default(true),
		allowedStates: z.array(factStateSchema).min(1).default(["VERIFIED"]),
	}),
	facts: z.array(factSchema).max(100).default([]),
	sourceRefs: z.array(sourceRefSchema).max(50).default([]),
});
export type ProjectProfileInput = z.input<typeof projectProfileInputSchema>;
export type NormalizedProjectProfile = z.output<typeof projectProfileInputSchema>;

export type BrandScope = { organizationId: string; brandId: string };
export type ProfileDecision = "CONFIRMED" | "REVOKED";

export type ContentProfileErrorCode =
	| "INVALID_PROFILE"
	| "PROFILE_VERSION_REQUIRED"
	| "PROHIBITED_FACT_HAS_SOURCE"
	| "REVOCATION_REASON_REQUIRED"
	| "VERIFIED_FACT_REQUIRES_SOURCE";

export class ContentProfileError extends Error {
	readonly code: ContentProfileErrorCode;

	constructor(code: ContentProfileErrorCode, message: string) {
		super(message);
		this.name = "ContentProfileError";
		this.code = code;
	}
}

export type ProfileVersion = BrandScope & {
	id: string;
	version: number;
	profileHash: string;
	profile: NormalizedProjectProfile;
	createdBy: string;
	createdAt: string;
	immutable: true;
};

export type ProfileDecisionRecord = BrandScope & {
	id: string;
	profileVersionId: string;
	profileHash: string;
	decision: ProfileDecision;
	decidedBy: string;
	reason: string | null;
	createdAt: string;
};

export type CurrentProfile = {
	version: ProfileVersion;
	decision: ProfileDecisionRecord | null;
};

export type CreateProfileVersionInput = BrandScope & {
	profile: ProjectProfileInput;
};

export type ConfirmProfileVersionInput = BrandScope & {
	profileVersionId: string;
	decision: ProfileDecision;
	reason?: string;
};

export type ProfileVersionRef = Pick<ProfileVersion, "id" | "version" | "profileHash">;
export type ProfileDecisionRef = Pick<ProfileDecisionRecord, "id" | "profileVersionId" | "decision">;

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, child]) => [key, stableValue(child)]),
		);
	}
	return value;
}

export function normalizeProfile(input: ProjectProfileInput): NormalizedProjectProfile {
	const result = projectProfileInputSchema.safeParse(input);
	if (!result.success) {
		throw new ContentProfileError("INVALID_PROFILE", "Project profile fields are invalid");
	}
	const parsed = result.data;
	const normalized = JSON.parse(JSON.stringify(parsed)) as NormalizedProjectProfile;
	for (const fact of normalized.facts) {
		if (fact.state === "VERIFIED" && fact.sourceRefs.length === 0) {
			throw new ContentProfileError(
				"VERIFIED_FACT_REQUIRES_SOURCE",
				"VERIFIED facts require at least one source reference",
			);
		}
		if (fact.state === "PROHIBITED" && fact.sourceRefs.length > 0) {
			throw new ContentProfileError("PROHIBITED_FACT_HAS_SOURCE", "PROHIBITED facts cannot have source references");
		}
	}
	return normalized;
}

export function profileHash(profile: NormalizedProjectProfile): string {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(profile)))
		.digest("hex");
}

/** Only sourced, verified facts may enter a factual-claim generation context. */
export function allowedClaimFacts(profile: NormalizedProjectProfile): ProfileFact[] {
	return profile.facts.filter((fact) => fact.state === "VERIFIED" && fact.sourceRefs.length > 0);
}

export function validateDecision(input: ConfirmProfileVersionInput): void {
	if (!input.profileVersionId.trim()) {
		throw new ContentProfileError("PROFILE_VERSION_REQUIRED", "Profile version is required");
	}
	if (input.decision === "REVOKED" && !input.reason?.trim()) {
		throw new ContentProfileError("REVOCATION_REASON_REQUIRED", "Revocation reason is required");
	}
}

export interface ContentProjectProfileModule {
	getCurrent(input: BrandScope): Promise<CurrentProfile | null>;
	createVersion(input: CreateProfileVersionInput): Promise<ProfileVersionRef>;
	decide(input: ConfirmProfileVersionInput): Promise<ProfileDecisionRef>;
}
