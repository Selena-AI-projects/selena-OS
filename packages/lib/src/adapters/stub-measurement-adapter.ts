import { createHash } from "node:crypto";
import type { RunOutcome } from "@workspace/selena-visibility-contracts";
import { type ExtractionContext, extractMeasurement } from "../selena-answer-extraction";
import type { SelenaExecutablePermit, SelenaMeasurementAdapter, SelenaMeasurementChannel } from "../selena-measurement";

/**
 * An adapter that exercises the whole execution path without a provider.
 *
 * Every field it produces is synthesized from the permit, so a rehearsal can
 * prove that runs, mention rows and cost rows land together and that the §12
 * metrics compute over them — while nothing it writes can be mistaken for an
 * observation: the model is literally `stub`, the charge is zero against
 * provider `stub`, and the answer reference names the digest of a text this
 * module wrote itself.
 *
 * It is registered nowhere. Selecting `stub` in a deployment fails with
 * SELENA_ADAPTER_NOT_REGISTERED, so a rehearsal is something an owner runs
 * deliberately against a scratch database, never a state a running system can
 * fall into.
 */

export const STUB_MODEL = "stub";
export const STUB_PROVIDER = "stub";

export type StubAdapterDeps = {
	channel?: SelenaMeasurementChannel;
	resolveExtractionContext: (permit: SelenaExecutablePermit) => Promise<ExtractionContext> | ExtractionContext;
};

/** A stable number in [0, 1) derived from the permit, so a rehearsal repeats exactly. */
function permitFraction(dispatchKey: string, salt: string): number {
	const digest = createHash("sha256").update(`${salt}:${dispatchKey}`).digest();
	return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * A ranked answer naming the tracked entities in a permit-derived order, with
 * the brand present in most runs but not all — a rehearsal where every run
 * mentions the brand at rank one would leave coverage, position and share
 * untested.
 */
export function stubAnswer(permit: SelenaExecutablePermit, context: ExtractionContext): string {
	const brand = context.brandTerms[0] ?? "";
	const names = context.competitors.map((competitor) => competitor.name);
	const mentionsBrand = brand !== "" && permitFraction(permit.dispatchKey, "mention") < 0.75;
	if (mentionsBrand)
		names.splice(Math.floor(permitFraction(permit.dispatchKey, "rank") * (names.length + 1)), 0, brand);
	return names.map((name, index) => `${index + 1}. ${name}`).join("\n");
}

export function createStubMeasurementAdapter(deps: StubAdapterDeps): SelenaMeasurementAdapter {
	const channel = deps.channel ?? "api_view";
	return {
		channel,
		async measure(permit) {
			if (permit.channel !== channel) throw new Error("MEASUREMENT_CHANNEL_MISMATCH");
			return { dispatchKey: permit.dispatchKey, status: "queued" };
		},
		async execute(permit): Promise<RunOutcome> {
			let context: ExtractionContext;
			try {
				context = await deps.resolveExtractionContext(permit);
			} catch {
				return {
					dispatchKey: permit.dispatchKey,
					status: "INVALID",
					validity: "INVALID",
					invalidReason: "STUB_EXTRACTION_CONTEXT_UNAVAILABLE",
				};
			}
			const answerText = stubAnswer(permit, context);
			const ownedDomain = context.ownedDomains[0];
			// One owned source on part of the runs, so owned citation rate is a
			// number the rehearsal can check rather than a constant.
			const sources =
				ownedDomain === undefined || permitFraction(permit.dispatchKey, "citation") >= 0.5
					? []
					: [{ url: `https://${ownedDomain}/`, domain: ownedDomain }];
			return {
				dispatchKey: permit.dispatchKey,
				status: "SUCCEEDED",
				validity: "VALID",
				rawResponseReference: `stub:sha256:${createHash("sha256").update(answerText).digest("hex")}`,
				// A rehearsal still writes a ledger row: the cost path is part of
				// what it is proving. Zero is the truth — nothing was bought.
				costUsd: 0,
				costBasis: "estimated",
				provider: STUB_PROVIDER,
				measurement: extractMeasurement({
					answerText,
					sources,
					// The permit's own system, because evidence attributed to any
					// other one is dropped before it reaches the ledger.
					system: permit.systemId ?? STUB_MODEL,
					model: STUB_MODEL,
					context,
				}),
			};
		},
	};
}
