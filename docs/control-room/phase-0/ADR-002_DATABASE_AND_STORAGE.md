# ADR-002: Database, Identity Boundaries, and Storage

- **Date:** 2026-08-26
- **Status:** ACCEPTED architecture. Migration `0021` is reauthored locally but unexecuted; all external staging setup remains unperformed.
- **Decision owners:** Selena product owner, platform/security owner, data owner.

## Context

The monorepo uses PostgreSQL through Drizzle and `pg` (`packages/lib/src/db/db.ts:1-4`). It has Better Auth server-session handling, not a Supabase client/auth integration. `resolveSessionAuthContext` obtains the Better Auth session, loads a membership, and derives `actorId`, `tenantId`, and normalized role on the server (`apps/web/src/lib/selena-auth-context.ts:26-45`). A requested tenant identifier is rejected when it differs from that resolved context (`:73-76`), and brand lookup is constrained to that tenant (`apps/web/src/server/selena-control-room.ts:44-51`).

There is no Supabase project, object bucket, scanner, signed URL implementation, configured database login, or executed pgTAP suite. The unexecuted `0021` migration now defines five private schemas, no-login role groups, `FORCE ROW LEVEL SECURITY`, grants/revokes, transaction-context functions, append-only triggers, and pgTAP source (`packages/lib/src/db/migrations/0021_selena_control_room.sql`, `packages/lib/src/db/tests/0021_selena_control_room.pgtap.sql`). Those are static, local artifacts only: no database has applied them, and they do not prove a provider, storage, scanner, or network boundary.

## Decision

For staging and later production, the selected provider is **Supabase Cloud PostgreSQL with private Supabase Storage**, while Drizzle and Better Auth remain the Selena application seam. Supabase is a managed PostgreSQL/storage provider; it is not a replacement app backend, Content Registry, authentication system, or direct browser data API.

### Explicit identity and API choices

| Concern | Decision |
|---|---|
| Supabase Auth | **Not used.** Better Auth remains the only application authentication/session authority. |
| Supabase Data API/PostgREST | **Not used for canonical Selena schemas.** No canonical private schema is exposed through the Data API, and no browser code receives a Supabase URL/key for it. |
| Browser data access | Browser calls only Selena/TanStack server functions. It has no PostgreSQL, Supabase service-role, or storage-admin credential. |
| User, organization, role | A Selena backend request resolves Better Auth's server-verified `session.user.id`, loads the membership, and maps it to `actor_id`, `organization_id`, and role. It never accepts those values as client authority. |
| Brand | The backend validates the route/request brand against the resolved organization before opening the privileged application operation. A browser-supplied `brand_id` is a selector, never a permission grant. |
| Storage access | The backend authorizes an upload/download and uses a least-privilege server-side storage broker to issue short-lived, object-specific signed URLs. The signed URL is not a service-role credential and has no listing, bucket-admin, or unrelated-object authority. |

No `@supabase/supabase-js` package is needed for this decision. A future server-only storage broker may use a reviewed provider SDK or an equivalent server-side API, but no package is installed now.

### Transaction-scoped database context

The reauthored, still-unexecuted `0021` migration and Control Room database wrapper implement this contract in local source; it requires a disposable database test before staging consideration:

1. The Selena backend authenticates Better Auth, resolves membership, and begins a transaction in `withControlRoomTransaction` (`apps/web/src/server/selena-control-room.ts`).
2. Inside that same transaction, only the parameterized `selena_registry.set_request_context(...)` function stores actor, organization, brand, role, correlation ID, service identity, authentication type, and optional manifest ID using transaction-local `set_config(..., true)`.
3. The function re-checks Better Auth user membership/brand/role for web sessions and exact service identity for Gateway, ingestion, analytics, and scanner roles. Policies use both this verified context and `session_user` role membership, so arbitrary GUCs alone are insufficient.
4. `SET LOCAL` lifetime ends on commit or rollback; the pgTAP file verifies no `app.selena_brand_id` remains after commit. Browser code has no database connection or helper execute path.
5. Application authorization remains additional: RLS/grants enforce boundaries, and server code plus the approval predicate enforce interactive-human and precondition rules. Neither replaces the other.

This is not evidence of a deployed control until migration application and the disposable pgTAP run succeed.

### Schemas and database roles

Canonical Selena data is defined in non-exposed `selena_registry`, `selena_release`, `selena_audit`, `selena_ingest_raw`, and `selena_performance`; `public` retains Better Auth and brand mapping only. Supabase-managed schemas remain provider-owned and are not application-facing APIs. The Supabase Data API exposed-schema list is an external configuration item: these five schemas must not be exposed when a project is created.

| Identity | Intended rights | `BYPASSRLS` | Prohibited capability |
|---|---|---:|---|
| `selena_web_runtime` | Restricted login role for Selena backend; RLS-constrained read/write only for its verified request context. | No | Cannot access private schemas directly from a browser, set arbitrary context, approve as a service, or administer storage. |
| `selena_gateway_runtime` | Read the exact approved Registry manifest after RLS/context validation; write only Gateway request/attempt/reconciliation records. | No | Cannot create human approvals, read arbitrary brands, or be used by web/Trigger. |
| `selena_ingestion_runtime` | Append raw observations and normalized results for its assigned account/checkpoint. | No | Cannot approve, publish, or read unrelated registry data. |
| `selena_scanner_runtime` | Read one quarantined object and write verified scan evidence for that object. | No | Cannot mark caller-provided metadata as scanned or access unrelated objects. |
| `selena_schema_owner` / `selena_migrator` | Private-schema ownership and DDL only; both are no-login role groups and the latter can assume the owner during migration. | No | No runtime route, deployment secret mount, Gateway/worker use, or browser access. |
| `selena_trigger_runtime` | No PostgreSQL grants. Trigger receives only opaque task metadata and a future Gateway invocation assertion. | No | Cannot read Registry, approve, publish, or receive Postiz credentials. |
| `selena_analytics_runtime` | Read-only performance data under verified context. | No | Cannot write, approve, publish, or read Registry bodies. |
| `selena_backup_restore` | Controlled backup/restore maintenance only; no-login and never mounted by a runtime workload. | Yes | Not a web, Gateway, Trigger, ingestion, scanner, or ordinary application identity. |
| Supabase provider superuser/service role | Provider control-plane only; not a Selena application identity. | Provider-managed | Must not be mounted by ordinary web runtime, browser, Gateway, Trigger, agents, ingestion, or scanner. |
| Browser/frontend | No database login and no grants to any `selena_*` private schema or storage-admin surface. | No | Cannot query private schemas or receive a service-role key. |

`REVOKE` precedes least-privilege `GRANT`; RLS is enabled and forced where table ownership would otherwise bypass it. Database connection/network policy must make the migrator unavailable to normal runtime workloads. Gateway, ingestion, scanner, and migration use different connection identities and secret-manager entries. Trigger receives no PostgreSQL credential and calls only the future Gateway private interface.

### Storage, immutability, and scanning

| Data or capability | Canonical owner | Required rule before release use |
|---|---|---|
| Brands, Registry, approvals, policy references | `selena_registry` PostgreSQL/Drizzle | Server and narrowly scoped service roles only. |
| Original asset | Private `selena-originals` bucket | Object key includes organization, brand, asset ID, object-version ID, and server-computed SHA-256. Originals are versioned/immutable and never overwritten. |
| Derivative | Private `selena-derivatives` bucket | Record points to exact original object version and transform version; it cannot replace an original. |
| Scan result | Canonical scan-evidence record plus provider event | Byte hash, MIME sniff result, provider result, timestamp, and callback verification must agree. Only scanner authority can move `QUARANTINED` to `PASSED`; a release requires `PASSED`. |
| Raw platform snapshot | Private `selena-raw-platform` bucket | Append-only source/account/window/checkpoint record. Deferred to Phase 3. |
| Backups/PITR | Supabase project controls plus owner-approved retention | Clean-environment restore and asset/hash verification are required before production. |

`content_assets` now reserves `object_version_id`, SHA-256, scan state, and scanner-event fields, but the current server still accepts metadata and no storage broker exists. These fields do not prove immutable objects, byte hashing, malware scanning, or secure storage.

### Required pgTAP suite

`packages/lib/src/db/tests/0021_selena_control_room.pgtap.sql` is the project pgTAP source for a disposable database. It must not run against staging or production and must prove:

1. User A cannot `SELECT`, `INSERT`, `UPDATE`, or `DELETE` brand B data.
2. A forged HTTP/request `brand_id` cannot alter the server-established transaction context or access another brand.
3. Worker, Gateway, ingestion, and scanner identities cannot create a human approval.
4. The frontend role has no grants on the five `selena_*` schemas or private-storage administration surfaces.
5. The Gateway role can read only the exact approved manifest/account binding it was asked to dispatch, and cannot read a different brand/account.
6. The migration role cannot connect from normal runtime network paths and is unavailable to web, Gateway, Trigger, and worker deployment manifests.

## Alternatives considered

| Alternative | Result | Reason |
|---|---|---|
| Unspecified PostgreSQL and object storage | REJECT | Leaves backup, private storage, scan and access boundaries unresolved. |
| Supabase Cloud PostgreSQL/private Storage with Drizzle and Better Auth | SELECT | Preserves the existing PostgreSQL/Auth seam and provides a managed staging path. |
| Supabase Auth or Data API as a replacement for Better Auth/server functions | REJECT | Creates a second application identity/data boundary without solving registry controls. |
| Self-host Supabase in Phase 0 | DEFER | Adds operational scope before a vertical slice. |
| Store originals in PostgreSQL byte columns | REJECT | Poor fit for immutable large media and derivatives. |

## Evidence

- `packages/lib/src/db/db.ts:1-4` proves the live Drizzle/`pg` seam.
- `apps/web/src/lib/selena-auth-context.ts:26-45,73-76` proves the current Better Auth session/membership context and tenant mismatch check.
- `apps/web/src/server/selena-control-room.ts:44-51` proves the current organization-constrained brand lookup.
- `packages/lib/src/db/migrations/0021_selena_control_room.sql:6-902` and `packages/lib/src/db/tests/0021_selena_control_room.pgtap.sql` prove the local, unexecuted schema/role/RLS/pgTAP design only.
- [Supabase RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security) confirms that RLS must be combined with grants and that privileged service keys must remain server-side.

## Consequences and migration plan

`0021_selena_control_room.sql` remains **unexecuted**. Its local reauthoring defines the private schema split, roles, context functions, grants, `FORCE RLS`, policies, append-only triggers, and pgTAP source before first run. Do not add a compensating migration to preserve the unsafe provisional version.

The next work cannot claim that RLS, storage isolation, SHA-256 calculation, or malware scanning is live until this migration and its staging tests have actually run. No migration, storage project, secret, or provider API call is authorized by this ADR.

## Next external action after code review

The Supabase staging decision is approved. Project creation, service accounts, network setup, retention settings, and secrets remain outside this task and occur only after the disposable database test and an explicit external-setup authorization.
