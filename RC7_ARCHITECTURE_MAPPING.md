# RC7 Architecture Mapping — Local AI Discovery / Google Ask Maps

Status: Phase A record (Gate 0). This document maps the logical requirements of
`SELENA_AI_VISIBILITY_RC7_CODEX_SPEC` onto the actual implementation of both
repositories and records the baseline before any RC7 change.

## Gate 0 — baseline

| Item | Value |
|---|---|
| App repository | `parkourcafe/selena-ai-visibility` |
| App branch | `claude/selena-systems-site-app-38rzll` |
| App base SHA (rollback target) | `0974b5b` |
| Site repository | `parkourcafe/SELENA-AI-COMPANY` |
| Site branch | `claude/selena-systems-site-app-38rzll` |
| Site base SHA (rollback target) | `574dc0f` |
| App baseline suite | `pnpm test` → 15 turbo tasks successful; `@workspace/web` 242/242 tests pass; exit 0 |
| App typecheck | `pnpm --filter @workspace/web check-types` → exit 0 |
| Site baseline suite | `npm run typecheck` exit 0; `npm test` 148/148 pass; `npm run lint` clean; `npm run build` exit 0 |
| Package manager / runtime | pnpm 11 / Node 22 locally (engines want Node 24 — pre-existing warning, CI uses 24) |
| Pre-existing failures unrelated to RC7 | none observed |

Production, DNS, Railway/Vercel, live payments, live providers and secrets are
not touched by RC7 work. All new feature flags default off.

## Where each RC7 requirement lands

### Phase B — policy and flags (app)

| Logical requirement | Actual implementation |
|---|---|
| Policy entry `GOOGLE_ASK_MAPS` manual-only | New `packages/selena-visibility-contracts/src/local-discovery.ts`, frozen `LOCAL_AI_DISCOVERY_POLICY`, `policyVersion: local-ai-discovery-v1` |
| Three default-off flags | `localDiscoveryConfigFromEnv(env)` reading `LOCAL_AI_DISCOVERY_ENABLED`, `ASK_MAPS_MANUAL_PILOT_ENABLED`, `LOCAL_AI_DISCOVERY_CLIENT_RESULTS_ENABLED` — same pattern as the existing payment kill-switch (`src/payment.ts`) |
| `AUTOMATION_BLOCKED` invariant | `assertCaptureMethodAllowed` — every non-`MANUAL_OBSERVATION` method throws deterministically; no adapter method capable of an external Ask Maps request exists |

Selena env flags intentionally live outside `ENV_REGISTRY` (precedent:
`SELENA_PAYMENTS_ENABLED`, `SCHEDULE_MAINTENANCE_ENABLED`).

### Phase C — entities and locations (app)

| Logical requirement | Actual implementation |
|---|---|
| Entity hierarchy (`entity_kind`, `parent_relation`, `confirmation_status`) | New `sv_entities` table in `packages/lib/src/db/schema.ts`; no prior entity table existed (`sv_project_profiles` is a rigid 1:1 profile and is left untouched) |
| Business locations with opaque Maps references | New `sv_business_locations`; `google_maps_url_reference` / `google_place_id_reference` are opaque strings the backend never resolves against Google |
| Additive migration | Hand-written `0021_selena_local_discovery_entities.sql` + `_journal.json` entry, following the 0015–0020 Selena convention; no existing table/column/enum altered |
| RLS | Both new tables `ENABLE ROW LEVEL SECURITY` — required by the CI invariant in `tools/selena_isolated_e2e.sh` (counts `sv_%` tables with `relrowsecurity`) |
| Tenant isolation | Repositories follow the existing `assertXOwned` + `organizationId: ctx.tenantId` pattern in `packages/lib/src/selena-visibility-repositories.ts` |
| Invariants (same-org parent, no self-parent, no cycles, PROPOSED excluded from Lock) | Pure functions in `packages/lib/src/selena-entities.ts`, unit-tested with the mandated KORA Food Hall → Two Moons Spa / Healthy Cafe fixture (fixture only in tests, no product hardcodes) |

### Phase D — Local AI Readiness in /check (site)

| Logical requirement | Actual implementation |
|---|---|
| Reuse the check registry | New category `local_ai_readiness` with rules `LA-01…LA-09` in `lib/visibility/readiness/ruleRegistry.ts`, registry version bumped to `selena-agent-readiness-2026-08-18-v2` |
| Unscored until versioned methodology | All LA rules `weight: 0` — the existing weight-0 contract (`diagnosticOnly`, score filters in `agentReadiness.ts`, "· weight 0" badge in `LiveReportView`) guarantees the weighted score cannot change |
| UNKNOWN instead of fake FAIL | New `"unknown"` status in `AgentReadinessStatus`, excluded from scoring like `not_applicable`; observations fall back to `unknown` with an evidence note when crawl data is insufficient |
| No external calls | Observations use only the existing crawl output; the Maps-link rule reuses the URL regexes from `checks/actionReadiness.ts` against already-fetched HTML |
| Mandatory disclaimer + CTA behind flag | `localAi` copy block in both locales; CTA rendered only when `LOCAL_AI_DISCOVERY_ENABLED` (new entry in `lib/diagnostics/flags.ts`, default off) is set server-side into the report |

### Phase E — manual pilot workflow (app)

| Logical requirement | Actual implementation |
|---|---|
| Lock extension `localAiDiscovery` block (§7.4) + observer context (§7.3) | `localAiDiscoveryLockBlockSchema` / `observerContextSchema` (strict — Google account/email/device identifier fields are unrepresentable) and `contextHash` (sha256 over sorted condition keys, `capturedAt` excluded) in `packages/selena-visibility-contracts/src/local-discovery.ts`; old locks never rewritten |
| Manual capture tasks outside the provider queue | `sv_pilot_cycles` + `sv_capture_tasks` (matrix unique index `pilotCycleId, scenarioId, contextHash, repeatIndex`); pure planner `planCaptureTasks` in `packages/lib/src/selena-manual-pilot.ts`; pg-boss queues untouched |
| Observations/evidence/mentions | `sv_local_observations` (1:1 per task, versioned corrections via `supersedes_observation_id`), `sv_observation_mentions`, `sv_observation_evidence_assets` (opaque `private_object_reference`, never fetched), `sv_audit_events`; migration `0022_selena_manual_pilot.sql` (additive) |
| Cardinality | `expectedObservations` = scenarios × contexts × repeats (entities never multiply); `assertObservationCardinality` blocks observation expected+1 both at planning and transactionally on submit |
| §10 metrics | Pure functions in contracts (`entityInclusionRate`, `familyPresenceRate`, `explicitAveragePosition`, `repeatStability`, `visibleSourceRate`, `factualErrorRate`); UNKNOWN/`SURFACE_UNAVAILABLE`/`SOURCE_NOT_EXPOSED` excluded from denominators, parent mention ≠ child mention, `UNRESOLVED` never counts |
| Zero provider execution proof | Repository writers in `selena-visibility-repositories.ts` only touch `sv_pilot_*`/observation tables; invariant test in `packages/lib/src/selena-manual-pilot.test.ts` greps the pilot modules for queue/scheduler/usage/fetch markers |
| API | `/api/v1/selena/pilot/*` routes behind `assertManualPilotAllowed` (flags off ⇒ plain 404 before auth, feature hidden); api-key auth + idempotency key in every mutating body + audit event per mutation |
| Roles | No `analyst` role exists; pilot admin surface will gate on the existing admin checks until an analyst role is introduced (owner gate) |

### Known repo facts RC7 relies on

- Upload/object-storage infrastructure does not exist; evidence starts as
  text/reference records per the existing contract. Binary asset storage is an
  owner decision (`BLOB_READ_WRITE_TOKEN` is declared in turbo.json but unused).
- `sv_audit_events` (added in Phase E) is the persisted audit trail for
  manual-pilot mutations; earlier domains still have no audit table.
- `apps/web` has no i18n framework; the Selena workspace localizes via the
  local `tr(locale, en, ru)` helper in `routes/_authed/app/selena.tsx`.
- PDF/XLSX rendering is the offline, provider-blind `tools/selena_export.py`;
  CSV is `packages/lib/src/selena-export.ts`.

## Deliberately out of scope (owner gates per RC7 §17)

Automated Ask Maps access of any kind, Google Places, production flag
activation, production migration/deploy, pricing/entitlement changes,
recurring monitoring, Google Ads/Analytics, Later/influencer integrations.
