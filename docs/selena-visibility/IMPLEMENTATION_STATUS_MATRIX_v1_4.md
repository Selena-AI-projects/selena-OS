# §20 Implementation Status Matrix v1.4

State of the branch `codex/tz-v1-4` on 2026-08-23. Supersedes
`IMPLEMENTATION_STATUS_MATRIX_v1_3.md`; rows unchanged since v1.3 are not
repeated — that file remains the record for them.

**Nothing here is RELEASED.** Migrations 0025–0034 exist in branches and have
been applied to nothing but scratch databases created and destroyed during
rehearsals. The worker registry holds `noop` alone; the execution contract
refuses any other adapter name. No live provider call was made by this work.

Statuses read as in v1.3: `DESIGNED` / `CODE_IN_BRANCH` /
`SCHEMA_EXISTS-in-branch` (needs an unapplied migration) / `NOT_BUILT`;
`RELEASED` has no row. "Stub rehearsal" means
`pnpm -C packages/lib rehearse:selena-stub-cycle` drove the row end to end
against a real scratch Postgres with no provider behind it.

## Фаза 0 — разблокировки живого прогона

| Feature | Status | Verified |
| --- | --- | --- |
| Tenant `sv_api_keys` keys reach `/api/v1/selena/*` (deployment gate no longer demands `ADMIN_API_KEYS` there; all other `/api/v1/*` keep it) | `CODE_IN_BRANCH` | unit (policies suite, 91 tests) |
| Profile block written into the Configuration Lock at order creation; resolver's preferred path live | `CODE_IN_BRANCH` | unit + stub rehearsal: profile renamed after approval, mentions still follow the locked brand |
| Answer text stored in `canonical_payload.answer` by both live adapters and the stub; error bodies never stored | `CODE_IN_BRANCH` | adapter units + stub rehearsal |
| Credential scrubbed from any answer text or source destined for storage (both adapters) | `CODE_IN_BRANCH` | adapter units incl. echoed-token cases |
| 13-month expiry job deletes only the text, leaves findings/citations/reference, audits per run; off until `SELENA_ANSWER_RETENTION_ENABLED=true` | `CODE_IN_BRANCH` | stub rehearsal with a fixed future clock |
| Cabinet step 4 «Замер»: cycle status, run counts, branded/non-branded apart, UNKNOWN never 0%, Visitor/API split | `CODE_IN_BRANCH` | typecheck + unit on the pure view helpers; rendered against rehearsal-shaped data structures, not a browser session |

## Фаза 1 — утверждение вопросов (шаг 2)

| Feature | Status | Verified |
| --- | --- | --- |
| Single repository path for scenario decisions (`scenarios.review`): PROPOSED only, text edit as part of the decision, audit row per decision | `CODE_IN_BRANCH` | stub rehearsal: approve with edit, re-review refused, audit row checked |
| Client screen «Утвердите вопросы», EN/RU | `CODE_IN_BRANCH` | typecheck; not driven in a browser |
| PROPOSED scenario cannot enter an order | held since v1.3 by the order desk (`SELENA_SCENARIOS_NOT_APPROVED`) | unchanged |

## Фаза 2 — доказательства (шаг 5)

| Feature | Status | Verified |
| --- | --- | --- |
| Response Explorer: per-run question, system, channel, captureMode, mentions with positions, citations, displayed sources, verbatim text or deletion marker, reference | `CODE_IN_BRANCH` | typecheck; reads tenant-scoped at SQL level |
| Signed URL layer: SigV4 presign on node:crypto, env-configured S3-compatible store, 10-minute expiry, unconfigured answers "unavailable" | `CODE_IN_BRANCH` | unit: disabled-until-configured, HTTPS-only, determinism, expiry, secret never in URL |
| Issuance only through `rawEvidenceFor` (tenant check + audit in one read) | `CODE_IN_BRANCH` | rawEvidenceFor path rehearsed in v1.3; the signing wrapper typechecks |
| Objects actually uploaded to the store by the write path | `NOT_BUILT` — the layer signs references; nothing uploads payloads yet | — |

## Фаза 3 — метр расходов Suggest

| Feature | Status | Verified |
| --- | --- | --- |
| Every Selena suggestion books an estimated ledger row (`kind='suggest'`, outside any cycle) | `SCHEMA_EXISTS-in-branch` (0032) | stub rehearsal |
| Monthly ceiling `SELENA_SUGGEST_BUDGET_USD`, asserted at enqueue and again in the worker; unset = today's behavior | `SCHEMA_EXISTS-in-branch` (0032) | unit (pure rule) + stub rehearsal (ceiling refuses the crossing call) |

## Фаза 4 — сравнение циклов (шаг 7)

| Feature | Status | Verified |
| --- | --- | --- |
| `selena-cycle-diff/1`: appearance, disappearance, position shift, source gained/lost; evidence run ids on every line; incompatible or unmeasured groups UNKNOWN, never averaged | `CODE_IN_BRANCH` | 6 units |
| Comparison screen, closed until the second cycle; no causal wording | `CODE_IN_BRANCH` | typecheck |

## Фаза 5 — tenant-изоляция

| Feature | Status | Verified |
| --- | --- | --- |
| DS-P0-15: `reports.organization_id` (nullable; legacy NULL admin-only via a separate path), write paths set it, customer reads scoped | `SCHEMA_EXISTS-in-branch` (0033) | typecheck; scoping is SQL-level predicates |
| DS-P1-28: `promptForUser` scoped read; the three unscoped `eq(prompts.id, …)` reads are gone | `CODE_IN_BRANCH` | typecheck; grep for the old shape finds nothing |
| DS-P1-10: `requireBrandRole` on all six brand/prompt mutations; viewer reads only | `CODE_IN_BRANCH` | typecheck |
| P1-13: `tenant_isolation` policies on all 34 org-carrying `sv_*` tables + `reports` (0034); no FORCE, so inert under the owning connection; runtime-role script in `packages/lib/scripts/selena-rls-runtime-role.sql` | `SCHEMA_EXISTS-in-branch` (0034) | applied to scratch: non-owner role with the GUC sees only its tenant, without the GUC sees nothing, owner sees everything |
| P1-13 GUC plumbing (`SET LOCAL app.organization_id` per request transaction) | `NOT_BUILT` — requires moving tenant queries into transactions app-wide; switching `DATABASE_URL` to the runtime role before this exists yields empty result sets (safe direction, still an outage). Owner sequence: plumbing → role → switch. | — |

## Фаза 6 — экраны в кабинете

| Feature | Status | Verified |
| --- | --- | --- |
| Client navigation does not lead into `/app/$brand/*`: `/app` redirects to the cabinet; the only outward link is `/app/selena-sources` | `CODE_IN_BRANCH` | route inspection |
| Шаг 1 Settings ≙ profile form; Шаг 2 Prompts ≙ question approval; Шаг 4 Visibility/SoV ≙ measurement panel + mention-share leaderboard; Шаг 5 Citations ≙ Response Explorer + source map; Шаг 6 Opportunities ≙ results panel | `CODE_IN_BRANCH` — native Selena-data equivalents, not ports of the Elmo charts | typecheck |
| Hard closure of the `/app/$brand/*` route family | `NOT_BUILT` — the same deployment serves the open-source Elmo dashboard in the same `local` mode; blanket closure breaks non-Selena self-hosters. Owner decision needed on deployment-level gating. | — |
| Elmo time-series charts (visibility trend, SoV trend) inside the cabinet | `NOT_BUILT` — they visualize `prompt_runs`, which a Selena client does not have; a ledger-based trend needs ≥2 cycles and is covered by the cycle diff until a chart earns its place | — |

## Migrations in this branch, applied by nobody

| Migration | Adds |
| --- | --- |
| 0032 | `sv_cost_events.cycle_id` nullable + `kind` discriminator + index |
| 0033 | `reports.organization_id` (nullable) + index |
| 0034 | `tenant_isolation` policies (no FORCE — inert until the runtime role exists) |

Earlier unapplied migrations 0025–0031 are recorded in v1.3 and in the release
branch history.

## New environment variables (registry, all safe-off)

| Variable | Off state |
| --- | --- |
| `SELENA_ANSWER_RETENTION_ENABLED` | unset = the expiry job deletes nothing |
| `SELENA_SUGGEST_BUDGET_USD` | unset = no ceiling, class gate alone |
| `SELENA_EVIDENCE_S3_*` (5) | any unset = signed links answer "unavailable" |
