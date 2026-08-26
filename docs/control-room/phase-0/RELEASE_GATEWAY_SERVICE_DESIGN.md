# Release Gateway Service Design

- **Date:** 2026-08-26
- **Status:** DESIGN ONLY. Not implemented, deployed, credentialed or connected to Postiz.
- **Depends on:** ADR-001, ADR-002, ADR-003 and ADR-004.

## Purpose and deployment shape

Release Gateway is a future **separate deployable service**, proposed as `apps/release-gateway` with its own Node 24 container/image, workload identity, secret namespace, private ingress and database role. It is not a function in `apps/web`, a `packages/lib` helper, a Trigger task, an outbox table, or a Postiz adapter interface.

The service has two independently deployable processes built from one codebase:

| Process | Private interface | Responsibility |
|---|---|---|
| Gateway API | `POST /v1/release-requests/{id}/dispatch`, `POST /v1/release-requests/{id}/cancel`, `POST /v1/publication-attempts/{id}/reconcile`, `GET /healthz`, `GET /readyz` | Authenticates Trigger/operator workload identities, validates signed requests, creates idempotent attempts, records cancellations and exposes status. |
| Gateway worker | Gateway-owned outbox/attempt store only | Leases a dispatch/reconciliation item, calls Postiz, classifies result, writes audit/attempt state and emits an incident when required. |

The worker is a service implementation detail. Trigger.dev remains the durable cross-service workflow coordinator; an outbox table without this consumer is not durable workflow evidence.

## Authority and cryptographic flow

1. Control Room creates a non-dispatching `release_request` only after a human approval. It signs a bounded request envelope with the Control Plane private key in a KMS namespace separate from Gateway.
2. Trigger receives only `releaseRequestId` and a short-lived workload assertion. It invokes the private Gateway dispatch interface.
3. Gateway verifies Trigger workload identity, request envelope signature, audience, expiry and single-use nonce. It then re-reads the canonical Drizzle Content Registry under its dedicated database role.
4. Gateway recomputes content, asset-bundle, disclosure and approval binding hashes. It checks current Brand Pack policy, approval/revocation/expiry, evidence/rights/consent expiry, scanner `PASSED`, platform/account allowlist and global/brand/account kill switches.
5. Gateway atomically reserves the idempotency key and nonce. A duplicate returns the existing attempt, not a second dispatch.
6. Only after all checks does Gateway create and sign an immutable release manifest with its own KMS-held private key. Postiz receives the manifest-derived post request through the Gateway-only credential.
7. Gateway records the provider response. `NOT_SENT` may be retried according to bounded policy. Any timeout/transport failure after possible provider acceptance becomes `RECONCILE_REQUIRED`; no automatic second publish occurs.

No HMAC key in Control Room can sign a release manifest. The repository now has no signing helper; the pure gate/classification rules at `packages/lib/src/selena-control-room.ts:116-145` are contract logic only and must not receive credentials or I/O authority.

## Identities, data access and network controls

| Identity | Database rights | Secret access | Network rights |
|---|---|---|---|
| Browser/agent | None | None | Control Room HTTPS only; explicit deny to Gateway/Postiz admin/API. |
| Control Room web | Content Registry write/read, no Gateway attempt write | Control Plane request-signing key only | PostgreSQL and private request submission; explicit deny to Postiz. |
| Trigger task | No database credential | Trigger key and short-lived Gateway assertion only | Gateway private interface; explicit deny to Postiz. |
| Gateway API/worker | Content Registry read plus Gateway-schema write | Gateway signing key and Postiz API credential | PostgreSQL, secret manager, Postiz private API, provider reconciliation endpoints. |
| Postiz runtime | Its own persistence only | Provider OAuth credentials only | LinkedIn/provider endpoints and Gateway webhook return path. |
| Scanner | Asset scan records only | Scanner provider credentials | Private object fetch/scan callback path. |

Gateway readiness is false if its database role, KMS/key reference, configured allowlist source or required Postiz endpoint configuration is unavailable. It must not report ready merely because an HTTP process is listening. Health checks contain no secret, content or provider token.

## State model and reconciliation

| State | Transition rule |
|---|---|
| `PENDING_VALIDATION` | Immutable release request awaits Gateway validation. |
| `BLOCKED` | Any hash, approval, policy, rights, consent, scanner, account or kill-switch check fails. |
| `DISPATCH_RESERVED` | Nonce/idempotency reservation is committed before provider call. |
| `PUBLISHING` | Gateway worker owns the leased attempt. |
| `CONFIRMED` | Provider identifier is independently observed/confirmed. |
| `RECONCILE_REQUIRED` | Provider may have accepted request; only status lookup/webhook reconciliation can resolve it. |
| `FAILED_SAFE_TO_RETRY` | Gateway proved no provider request was sent. Retry is bounded and revalidates every gate. |
| `CANCELLED` | Approval revoked, policy invalidated or kill switch enabled before irreversible hand-off. |

Inbound webhook events are advisory until signature, timestamp and replay nonce are verified and the result agrees with a provider query or known request correlation. A forged/replayed webhook is recorded as a security event and cannot create a confirmation.

## Required acceptance tests before staging publication

| Test | Required proof |
|---|---|
| Change one approved character or asset byte | Gateway recomputes hash and blocks; no Postiz call occurs. |
| Wrong brand/account or cross-brand database read | Database policy and Gateway authorization deny it. |
| Expired approval/evidence/rights/consent or scanner not `PASSED` | Gateway blocks before reservation/provider call. |
| Kill switch enabled | Gateway cancels/blocks before Postiz call. |
| Ten duplicate Trigger deliveries | One idempotency reservation and at most one provider request. |
| Replayed nonce | Gateway rejects and writes audit event. |
| Timeout after possible Postiz acceptance | One attempt enters `RECONCILE_REQUIRED`; no blind retry. |
| Service identity attempts approval | Control Room and database policy reject it. |
| Direct Postiz access | Network policy and missing credentials deny web, agent and Trigger callers. |

## Implementation constraints

- No source, container, secret, endpoint or test is created by this design document.
- Gateway code may reuse value-only hash/validation contracts after review, but must not import web server authority or use its database identity.
- The Gateway schema and revisions to unexecuted migration 0021 are a later review item; this design alone does not authorize migration execution.
- A real Postiz adapter is complete only when it makes an authenticated staging request through Gateway and the reconciliation tests above pass.
