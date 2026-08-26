# ADR-003: Payload Integration and the Content Registry

- **Date:** 2026-08-26
- **Status:** **DEFER FOR MVP**
- **Decision owner:** Selena product owner with platform/security review.

## Context

The repository is a TanStack Start/Vite application, not a Next.js application (AGENTS.md:6; apps/web/package.json:9-18). It has no Payload dependency, config, collection, admin route, or generated API. The unexecuted design contains a prospective custom registry: scr_content_items, scr_content_versions, scr_content_assets, and scr_approvals (packages/lib/src/db/schema.ts:942-1051).

This is **not a framework incompatibility**. A separate Next.js/Payload application is technically possible, and the TanStack Control Room can consume the Payload REST API. Payload documents both its Next.js admin integration and operation outside a Next.js application. Sources: [Payload installation](https://payloadcms.com/docs/getting-started/installation), [Admin Panel architecture](https://payloadcms.com/docs/admin/overview), and [using Payload outside Next.js](https://payloadcms.com/docs/local-api/outside-nextjs).

The current Control Room UI/server functions work against the prospective Drizzle tables. A UI and tables do not make a complete Content Registry, but running Payload beside them today would create duplicate draft/version/access/approval and migration ownership.

## Alternatives considered

| Alternative | Result | Reason |
|---|---|---|
| Separate Next.js/Payload service; TanStack Control Room uses Payload REST API | **DEFER FOR MVP** | Technically viable, but adds a second runtime, second authentication/access boundary, separate migration ownership, and duplicates the already-created Registry during the first-brand MVP. |
| Run Payload and synchronize it with Drizzle | REJECT | Dual writes, conflict resolution, and separate approval histories violate the single canonical Registry requirement. |
| Keep the Drizzle/PostgreSQL Registry as the first-brand source of truth and complete its contracts | SELECT FOR MVP | Reuses the existing schema direction and keeps authorization, approval binding, and audit ownership together while scope is still small. |
| Embed Payload directly into the TanStack/Vite application | NOT SELECTED | This ADR does not claim it is impossible. It is not the selected service composition and does not remove the runtime/auth/migration ownership questions. |

## Decision

**Payload = DEFER FOR MVP.** Do not install it or start a second Payload service for the first brand. The temporary canonical Content Registry is the Selena Drizzle/PostgreSQL Registry. Control Room is a client of that Registry; it is not itself the Registry, and its UI does not replace missing storage, scanning, access control, or audit implementation.

The decision is driven by MVP operational cost, not TanStack/Vite compatibility:

- separate Next.js/Payload runtime to build, observe, patch, and deploy;
- a second authentication/access boundary between Better Auth users and Payload;
- distinct database migration ownership and backup/cutover responsibility; and
- duplication of drafts, versions, access decisions, and admin workflows already represented by the Registry work.

payload@3.88.0 was observed with an MIT license on 2026-08-26 through package metadata. It is intentionally not added to package.json or the lockfile while deferred.

### Required re-evaluation after the first brand

After the first-brand staging vertical slice, conduct an explicit **build-vs-Payload** review. Move the Content Registry to a separate Payload service when the cost of maintaining custom drafts, immutable versions, access control, and admin workflows exceeds the total cost of operating a separate Payload service, including its runtime, authentication boundary, migration/cutover, operations, and support.

The review must record workload evidence: custom Registry feature backlog, security/access defects or audit effort, operations cost, Payload migration/cutover cost, and a no-dual-write plan. If it selects Payload, Payload becomes the Registry source of truth after a one-way migration; the Control Room calls its REST API. The old Registry is frozen/read-only and never synchronized bidirectionally.

### Data ownership while Payload is deferred

| Domain data | Canonical owner | Required refinement before release use |
|---|---|---|
| Brand Pack and policy versions | Versioned Drizzle records | Owner, effective time, rules, disclosure, and invalidation semantics. |
| Content draft | scr_content_items | Per-brand lifecycle and author/evidence provenance. |
| Immutable content version | scr_content_versions | Versioned claims/evidence/disclosure contract; no update/delete after creation. |
| Claims and evidence | Version-bound normalized records or validated documents | Durable source, retrieval time, expiry, verifier, and provenance. |
| Rights and consent | Asset-bound normalized records | Object reference, subject, expiry, revocation, and verifier. |
| Human approval/revocation | scr_approvals | Binding to exact content, asset bundle, disclosure, policy, and account; interactive owner only. |
| Release execution | Future Gateway-owned schema | Not web server code and not owned by a CMS. |

### Treatment of migration 0021 before its first run

**Migration 0021_selena_control_room.sql has been reauthored locally and remains unexecuted. Do not run it in this task.** The source now uses private Registry/Release/Audit/raw/performance schemas, roles, context/RLS/grants/append-only contracts, and pgTAP source. This is not proof of a deployed Registry, storage, scanner, Gateway, or durable workflow.

| Current 0021 area | Disposition | Reason |
|---|---|---|
| Registry tables | REFACTORED | `selena_registry` holds accounts, content, versions, assets, approvals, and kill switches; provider integration reference and object-version/scan fields are present. Normalized evidence/rights/consent and real scanner/storage remain missing. |
| Release tables | REPLACED | `selena_release` uses immutable manifests, dispatch reservations and publication-attempt history. This is not a deployable Gateway, consumer, or durable workflow. |
| Audit and incident tables | REFACTORED | `selena_audit` has append-only audit events and Gateway-owned incident writes; operational producer/consumer remains missing. |
| Raw/performance tables | RETAINED AS FUTURE DATA CONTRACT | `selena_ingest_raw` and `selena_performance` reserve append-only raw/metric/tracking records. They do not create ingestion, normalization, DQ, or attribution. |
| RLS/grants/context | REPLACED IN SOURCE | Private schemas, role grants/revokes, FORCE RLS, policies, transaction context, and pgTAP source are present but unexecuted. |

This ADR authorizes only the decision and reauthoring direction. It does not authorize a migration, a Payload install, or a production data change.

## Evidence

- AGENTS.md:6 and apps/web/package.json:9-18 prove the current TanStack/Vite composition, not Payload incompatibility.
- packages/lib/src/db/schema.ts and apps/web/src/server/selena-control-room.ts show the current private-schema Drizzle content/approval path and transaction wrapper.
- apps/web/src/routes/_authed/app/$brand/control-room.tsx:223-720 is a Control Room UI, not a complete registry, Payload service, or storage/scanner service.
- packages/lib/src/db/migrations/0021_selena_control_room.sql defines reservation/attempt history without a deployed Gateway or consumer.

## Consequences and risks

- There is exactly one canonical content/approval/evidence Registry during MVP. Payload is neither a mirror nor a second source of approvals while deferred.
- Existing Control Room code remains partial until private storage/scanning, Registry ACL/audit contracts, database controls, and Gateway checks are implemented and tested.
- The remaining pure gate/classification rules in packages/lib/src/selena-control-room.ts:116-145 are contract logic only; they are not a Release Gateway.
- A later Payload move requires a replacement ADR, measured cost evidence, a one-way migration/cutover plan, frozen approvals, and independently verified Registry/asset/audit hashes.

## Next action

Payload deferral and the post-first-brand build-vs-Payload criterion are recorded. Do not create a Payload project, credential, or integration in this stage.
