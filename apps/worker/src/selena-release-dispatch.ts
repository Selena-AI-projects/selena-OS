import { randomUUID } from "node:crypto";
import {
	type PreparedRelease,
	type ReleaseProviderAdapter,
	toNormalizedRelease,
} from "@workspace/lib/selena-release-provider";
import type { ReleaseProviderConfiguration } from "@workspace/lib/selena-release-providers";
import { PublishRefusedError } from "@workspace/lib/selena-release-publish-policy";

const PREPARE_SUBMISSION = "SELECT * FROM selena_release.prepare_postiz_submission($1, $2, $3)";
const AUTHORIZE_DISPATCH = "SELECT * FROM selena_release.authorize_provider_dispatch($1, $2, $3)";
const RECORD_OUTCOME = "SELECT selena_release.record_postiz_submission_outcome($1, $2, $3, $4) AS attempt_id";

/** A query run inside the Gateway's request context for one manifest. */
export type GatewayQuery = <Row>(sql: string, parameters: unknown[]) => Promise<Row[]>;

/** One committed transaction in that context. The Gateway supplies it. */
export type GatewayTransaction = <Result>(task: (query: GatewayQuery) => Promise<Result>) => Promise<Result>;

type SubmissionReservation = {
	integration_id: string;
	manifest_hash: string;
	publication_package: unknown;
	release_intent_id: string;
	reservation_id: string;
	should_submit: boolean;
};

type DispatchAuthorization = {
	audit_event_id: string;
	content_hash: string;
	expires_at: Date | string;
	manifest_hash: string;
	provider: string;
	signature: string;
	signature_algorithm: string;
	signing_key_version: string;
};

export type ReleaseDispatchReport =
	| { missing: string[]; outcome: "NOT_CONFIGURED" }
	| { outcome: "SKIPPED"; reservationId: string }
	| { outcome: "ACCEPTED"; providerReferenceId: string; reservationId: string }
	| { outcome: "DEFINITIVE_FAILURE"; reason: string; reservationId: string }
	| { outcome: "AMBIGUOUS"; reason: string; reservationId: string }
	| { outcome: "NOT_SENT"; reason: string; reservationId: string };

/** The reports that correspond to a recorded publication attempt. */
type RecordedReport = Extract<
	ReleaseDispatchReport,
	{ reservationId: string; outcome: Exclude<ReleaseDispatchReport["outcome"], "NOT_CONFIGURED" | "SKIPPED"> }
>;

function asIsoString(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : value;
}

/**
 * Sends one authorized release to its bound provider.
 *
 * The reservation and its authorization commit before the provider is reached,
 * and the outcome is recorded in a second transaction afterwards. Holding one
 * transaction across the network call would roll the reservation back when the
 * process dies mid-flight — losing the record of an attempt that may already
 * have published. A crash here instead leaves a RESERVED attempt, which is
 * exactly what reconciliation is for.
 *
 * Nothing in this function decides whether publishing is allowed. The database
 * refuses to authorize a dispatch without an active provider binding for this
 * environment, and the provider itself refuses to shape a release outside a
 * production contour with the publish flag set.
 */
export async function dispatchReleaseManifest(input: {
	assetUrls?: Record<string, string>;
	configuration: ReleaseProviderConfiguration;
	idempotencyKey: string;
	inGatewayContext: GatewayTransaction;
	manifestId: string;
	now?: Date;
}): Promise<ReleaseDispatchReport> {
	const { configuration, idempotencyKey, inGatewayContext, manifestId } = input;
	if (configuration.state !== "CONFIGURED") return { missing: configuration.missing, outcome: "NOT_CONFIGURED" };

	const reserved = await inGatewayContext(async (query) => {
		const [reservation] = await query<SubmissionReservation>(PREPARE_SUBMISSION, [
			manifestId,
			idempotencyKey,
			randomUUID(),
		]);
		if (!reservation) throw new Error("Release Gateway could not reserve a dispatch");
		if (!reservation.should_submit) return { authorization: null, reservation };
		const [authorization] = await query<DispatchAuthorization>(AUTHORIZE_DISPATCH, [
			manifestId,
			configuration.environment,
			idempotencyKey,
		]);
		if (!authorization) throw new Error("Release Gateway could not authorize the dispatch");
		return { authorization, reservation };
	});

	const reservationId = reserved.reservation.reservation_id;
	if (!reserved.authorization) return { outcome: "SKIPPED", reservationId };

	const record = async <Report extends RecordedReport>(report: Report): Promise<Report> => {
		await inGatewayContext(async (query) => {
			await query(RECORD_OUTCOME, [
				reservationId,
				report.outcome,
				report.outcome === "ACCEPTED" ? report.providerReferenceId : null,
				report.outcome === "ACCEPTED" ? null : report.reason,
			]);
			return null;
		});
		return report;
	};

	const authorization = reserved.authorization;
	let provider: ReleaseProviderAdapter;
	let prepared: PreparedRelease;
	try {
		provider = configuration.registry.resolve(authorization.provider);
		prepared = provider.prepareManifest({
			authorization: {
				auditEventId: authorization.audit_event_id,
				contentHash: authorization.content_hash,
				environment: configuration.environment,
				expiresAt: asIsoString(authorization.expires_at),
				idempotencyKey,
				// The database refused to authorize this dispatch while any kill switch
				// covering the brand or account was active, so it is not re-asked here.
				killSwitchActive: false,
				manifestHash: authorization.manifest_hash,
				providerId: authorization.provider,
				signature: authorization.signature,
				signatureAlgorithm: authorization.signature_algorithm,
				signingKeyVersion: authorization.signing_key_version,
			},
			now: input.now ?? new Date(),
			release: toNormalizedRelease(reserved.reservation.publication_package, input.assetUrls),
		});
	} catch (error) {
		const reason =
			error instanceof PublishRefusedError
				? `Publishing refused: ${error.refusal}`
				: error instanceof Error
					? error.message
					: "Release could not be shaped for its provider";
		return record({ outcome: "NOT_SENT", reason, reservationId });
	}

	const outcome = await provider.dispatch(prepared);
	if (outcome.outcome === "ACCEPTED") {
		return record({ outcome: "ACCEPTED", providerReferenceId: outcome.providerReferenceId, reservationId });
	}
	return record({ outcome: outcome.outcome, reason: outcome.reason, reservationId });
}
