# ADR-001: Trigger Runtime

- **Date:** 2026-08-26
- **Status:** ACCEPTED for the MVP architecture. No account, package, or secret has been created.
- **Decision owners:** Selena product owner and platform/security owner.

## Context

The repository has one background runtime today: `apps/worker`, a pg-boss process. It creates unrelated queues in `apps/worker/src/index.ts:42-75`; there is no Trigger.dev dependency, task, deployment configuration, approval wait, cancellation, or reconciliation worker. `pnpm-lock.yaml` contains no Trigger.dev package.

The existing Control Room helper can classify an ambiguous result as `RECONCILE_REQUIRED` (`packages/lib/src/selena-control-room.ts:138-145`), but it is a pure function and is not a durable workflow. A table or a retry helper must not be treated as workflow completion.

Trigger.dev Cloud is managed and offers checkpointed waits; its current public pricing lists a free tier and separately bills task execution time and invocations. Self-hosting runs additional webapp, Postgres/Redis, supervisor and runner infrastructure; the vendor explicitly places the reliability and security responsibility on the operator. Sources: [Trigger self-hosting overview](https://trigger.dev/docs/self-hosting/overview), [self-hosted Docker warning](https://trigger.dev/docs/self-hosting/docker), and [Cloud pricing](https://trigger.dev/pricing).

## Alternatives considered

| Alternative | Result | Reason |
|---|---|---|
| Keep pg-boss for Selena release orchestration | REJECT | It is an existing general job runner, but has no Selena approval wait, replay model, cancellation contract, or reconciliation state machine. Extending it would not satisfy the specified Trigger.dev capability. |
| Trigger.dev Cloud | SELECT | Smallest operational surface for the first isolated channel. Cloud receives only opaque identifiers and controlled task metadata. |
| Self-host Trigger.dev v4 | DEFER | Viable if data residency or contractual requirements prohibit Cloud, but adds a production platform that this repository cannot safely operate in Phase 0. |
| Poll from the web application | REJECT | A request/response server function is not durable and must not own background execution. |

## Decision

Use **Trigger.dev Cloud** for Selena release orchestration after provisioning, with the application package pinned to `@trigger.dev/sdk@4.5.12`. Do not install it in this task. The observed package metadata on 2026-08-26 is MIT; pinning must be repeated in `pnpm-lock.yaml` during the approved dependency review. Trigger.dev itself describes its OSS project as Apache-2.0 licensed, so the selected SDK package license must be checked again rather than inferred from the service repository. [Official Trigger repository](https://github.com/triggerdotdev/trigger.dev).

Self-hosting is the replacement path, not a parallel deployment. Re-open this ADR before provisioning if the owner requires a specific data region, private connectivity, an enterprise agreement, or a data-processing review that Cloud cannot meet.

### Workflow interface and state ownership

The future `apps/trigger` module has one external interface: it receives a `releaseRequestId` and a signed, short-lived gateway invocation assertion. It does not receive content, assets, OAuth tokens, a Postiz key, human identity data, or raw platform responses.

| Workflow | Queue/concurrency key | Durable state | Required behavior |
|---|---|---|---|
| `await-approval` | `approval:<releaseRequestId>` | Trigger run plus canonical Control Room request state | Waits on an opaque approval-change signal. Revocation, expiry, policy change, or kill switch ends the run as cancelled. |
| `dispatch-release` | `release:<approvalId>:<channelAccountId>` | Trigger run plus Gateway publication-attempt state | Calls only the Gateway private interface. The Gateway re-reads and validates the canonical registry immediately before Postiz. |
| `reconcile-publication` | `publication:<attemptId>` | Gateway attempt state and immutable audit event | Polls the Gateway reconciliation interface after a timeout or uncertain provider response. It never creates a second post while state is ambiguous. |
| `ingest-platform-metrics` | `platform:<accountId>:<window>` | Ingestion checkpoint and raw-record registry | Deferred to Phase 3. It supplies account/window identifiers only and is not evidence of ingestion until adapters, raw records and normalization exist. |

`releaseRequestId` is the idempotency root. Trigger duplicate delivery may start the same task up to ten times, but Gateway acceptance is serialized by a unique request/idempotency record. A retry is allowed only after Gateway records `NOT_SENT`. `AMBIGUOUS` produces `RECONCILE_REQUIRED`; it is not retried blind. Cancellation is a canonical Control Room/Gateway state transition, not merely cancellation of the Trigger run.

### Data prohibited from Trigger payloads and logs

Do not put any of the following in Trigger input, output, metadata, tags, traces, or logs:

- post body, claim/evidence text, disclosure, asset URL, asset bytes, raw snapshot, visitor data, or customer personal data;
- Postiz, LinkedIn, database, storage, KMS, scanner, or signing credentials;
- a bearer token that can call Postiz or retrieve an original object;
- approval signature, signing key material, or a reusable gateway assertion.

The only permitted values are opaque UUIDs, non-secret version identifiers, fixed enum status, bounded timestamps, and a one-time gateway audience/nonce assertion. Trigger run data is operational metadata, not the Content Registry or audit source of truth.

### Future runtime configuration contract

No variables are added now. These names are a future implementation contract, not a request to create values. Gateway client ID/private key and Gateway audience must not exist until the task package, Gateway service, and secret-holder configuration have passed code review. The approved implementation may then define them only in the runtime that executes Trigger tasks, never in browser-exposed `VITE_*` variables and never in the Postiz instance:

| Variable | Holder | Purpose |
|---|---|---|
| `TRIGGER_SECRET_KEY` | Trigger task runtime only | Trigger.dev Cloud project authentication. |
| `SELENA_GATEWAY_BASE_URL` | Trigger task runtime only | Private Release Gateway origin; HTTPS and allowlisted route only. |
| `SELENA_GATEWAY_AUDIENCE` | Trigger task runtime only | Expected Gateway audience for a short-lived invocation assertion. |
| `SELENA_TRIGGER_GATEWAY_CLIENT_ID` | Trigger task runtime only | Non-secret workload identity identifier. |
| `SELENA_TRIGGER_GATEWAY_PRIVATE_KEY` | Trigger task runtime secret store only | Private signing material for the short-lived invocation assertion. The matching public key is held by Gateway. |
| `SENTRY_DSN` | Optional task runtime | Existing observability pattern; must contain no business payload in telemetry. |

For a later self-hosted replacement only, `TRIGGER_API_URL` is an additional runtime variable and the self-hosted release tag must be pinned with the matching CLI/runtime release as required by Trigger's self-hosting guidance. It is not a Cloud MVP variable.

## Evidence

- `apps/worker/package.json:20` and `apps/worker/src/index.ts:37-75` prove the repository currently uses pg-boss rather than Trigger.dev.
- `packages/lib/src/selena-control-room.ts:138-145` and `packages/lib/src/selena-control-room.test.ts:130-133` prove only local ambiguous-result classification.
- `packages/lib/src/db/migrations/0021_selena_control_room.sql` defines only an unexecuted dispatch-reservation and publication-attempt data contract. It is not a queue, retry policy, wait, cancellation, or reconciliation runtime.
- `pnpm view @trigger.dev/sdk version license` observed `4.5.12` and `MIT` without installation on 2026-08-26.

## Consequences and risks

- Owner approval for Trigger.dev Cloud is recorded. Project creation and all task-runtime values remain deferred until the implementation and secret-holder configuration are reviewed. No production secret belongs in this repository or in Control Room.
- Cloud processing remains a data-processing and retention decision. The opaque-payload contract minimizes but does not erase that concern.
- Trigger run history is not legal/audit evidence. Canonical state and append-only audit records stay in PostgreSQL under the ownership defined by ADR-002 and ADR-003.
- A self-hosted move is a replacement migration of workflow execution only; it must preserve `releaseRequestId`, attempt state, idempotency rules, cancellation semantics, and audit records.

## Rollback/replacement

Disable Trigger schedules and stop accepting new release requests at Gateway. Existing ambiguous attempts stay in `RECONCILE_REQUIRED` and are reconciled manually or by the replacement runtime; they are never replayed as new publishes. Replacing Cloud with self-hosted Trigger.dev requires a tested export/re-drive plan using only opaque request IDs and the same Gateway interface.

## Next external action after code review

The owner decision is complete. A Trigger.dev staging project belongs to the later approved external-setup step; no Gateway client ID/private key, audience, Trigger secret, or other value is to be created in the current task.
