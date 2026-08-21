# §20 Implementation Status Matrix v1.3

State of the branch `claude/selenasystems-security-audit-b9uyst` on 2026-08-21.

**Nothing here is RELEASED.** Migrations 0025–0030 exist in this branch and have
been applied to nothing but a scratch database created and destroyed during a
rehearsal. No live provider adapter is registered: the worker registry holds
`noop` alone, and the execution contract refuses any other name.

## How to read the status column

| Status | Means |
| --- | --- |
| `DESIGNED` | Written down, decided, no code. |
| `CODE_IN_BRANCH` | Implemented in this branch on tables that already exist. |
| `SCHEMA_EXISTS-in-branch` | Implemented, and needs a migration that has **not** been applied. Ceiling for every row that touches 0025–0030. |
| `NOT_BUILT` | Named in the spec, absent from the code. |
| `RELEASED` | Running in production. **No row.** |

The Verified column says how far a row was actually exercised. "Stub rehearsal"
means `pnpm -C packages/lib rehearse:selena-stub-cycle` drove it end to end
against a real Postgres with no provider behind it. It is not evidence that
anything works on a paid order.

What is applied to the production database is not verifiable from this branch.
The claim made here is narrower and checkable: 0025–0030 were written here and
run by nobody.

## Measurement execution

| Feature | Status | Verified |
| --- | --- | --- |
| Execution contract: adapter allowlist, measurement off unless explicitly enabled | `CODE_IN_BRANCH` | contract + unit |
| Permit minting, dispatch-key uniqueness, cardinality boundary | `SCHEMA_EXISTS-in-branch` (0027) | unit + stub rehearsal |
| Sold system fixed on every permit and run at planning time (P0-07) | `SCHEMA_EXISTS-in-branch` (0027) | unit + stub rehearsal |
| Executor guards: expiry, spent permit, emergency stop, system mismatch | `CODE_IN_BRANCH` | unit |
| Noop adapter — the only one registered | `CODE_IN_BRANCH` | unit |
| Stub adapter — registered nowhere, zero provider calls | `CODE_IN_BRANCH` | unit + stub rehearsal |
| OpenRouter API View adapter — registered nowhere | `CODE_IN_BRANCH` | unit only; never called live |
| Bright Data Visitor View adapter — registered nowhere | `CODE_IN_BRANCH` | unit only; never called live |

## Evidence Ledger

| Feature | Status | Verified |
| --- | --- | --- |
| Measurement columns on `sv_runs` | `SCHEMA_EXISTS-in-branch` (0025) | stub rehearsal |
| `sv_response_mentions`, one row per named entity, ordinal ≥ 1 | `SCHEMA_EXISTS-in-branch` (0028) | unit + stub rehearsal |
| `extractorVersion` on every stored extraction | `SCHEMA_EXISTS-in-branch` (0025, 0028) | stub rehearsal |
| `captureMode` on run and mention; adapter is the source of truth | `SCHEMA_EXISTS-in-branch` (0030) | contract + unit + stub rehearsal |
| Deterministic extraction `selena-extract/1` | `CODE_IN_BRANCH` | unit |
| `resolveExtractionContext` — lock snapshot first, confirmed profile as fallback | `CODE_IN_BRANCH` | unit + stub rehearsal (fallback path only; nothing writes a lock profile block yet) |
| Citations stored as the provider showed them; owned by domain suffix | `SCHEMA_EXISTS-in-branch` (0025) | unit + stub rehearsal |
| Ledger metrics read the normalized mentions, not the run's jsonb | `CODE_IN_BRANCH` | unit + stub rehearsal |
| Branded and non-branded coverage kept apart; combined figure labelled `mixed` | `CODE_IN_BRANCH` | unit + stub rehearsal |
| Empty group returns UNKNOWN, never 0% | `CODE_IN_BRANCH` | unit |
| VALID run without extraction counted as unmeasured, not as a non-mention | `CODE_IN_BRANCH` | unit + stub rehearsal |
| No headline composite score anywhere | n/a — nothing computes one | — |
| Cost ledger `sv_cost_events`, every post-dispatch outcome carries a charge | `SCHEMA_EXISTS-in-branch` (0026) | unit + stub rehearsal |
| Incidents `sv_incidents` for order-dispatch overflow and emergency stop | `SCHEMA_EXISTS-in-branch` (0026) | unit + stub rehearsal |
| Incident written when the manual-pilot boundary is reached | `SCHEMA_EXISTS-in-branch` (0026) | stub rehearsal |

## Deliverable

| Feature | Status | Verified |
| --- | --- | --- |
| Cycle completion moves the order to QC_REQUIRED | `CODE_IN_BRANCH` | stub rehearsal |
| Approved QC record publishes order and cycles in one transaction | `CODE_IN_BRANCH` | unit + stub rehearsal |
| Publication refused while a cycle is still producing runs | `CODE_IN_BRANCH` | unit |
| Delivery gated by `assertExpertVerified`, read inside the delivering transaction | `CODE_IN_BRANCH` | unit + stub rehearsal |
| Rejected QC leaves the order in review | `CODE_IN_BRANCH` | stub rehearsal (no state change asserted) |
| Raw evidence readable only by the owning organization | `CODE_IN_BRANCH` | stub rehearsal |
| Signed URL issuance itself (object storage, expiry, audit of the signature) | `NOT_BUILT` | — |
| Response Explorer screen (addendum §7) | `NOT_BUILT` | — |

## Analytics — Этап B

| Feature | Status | Verified |
| --- | --- | --- |
| Citation Gap rule, formula version `selena-citation-gap/1` | `CODE_IN_BRANCH` | unit + stub rehearsal |
| `sv_citation_gap_snapshots`, one row per cited source per cycle | `SCHEMA_EXISTS-in-branch` (0029) | stub rehearsal |
| `priorityBand` from checkable signals only, no hidden score | `CODE_IN_BRANCH` | unit |
| Source Opportunity aggregation by domain, URL, scenario, system, owned vs competitor, evidence run ids | `CODE_IN_BRANCH` | unit + stub rehearsal |
| Topic axis of the aggregation (§8) | `NOT_BUILT` — depends on `sv_topics`, out of scope for this TZ | — |
| Recommendation and task refused without evidence ids | `CODE_IN_BRANCH` | unit |
| `GET /v1/projects/{id}/citation-gaps` | `NOT_BUILT` — repository reader exists, no route | — |
| Source Opportunity Map screen | `NOT_BUILT` | — |

## Manual pilot (RC7 Phase E)

| Feature | Status | Verified |
| --- | --- | --- |
| Capture task planning, observation submit and review | `CODE_IN_BRANCH` | stub rehearsal (submit path) |
| `ordering_state`, `match_status`, `mention_role` column names corrected | `CODE_IN_BRANCH` — code-only fix, migrations were always right | stub rehearsal |
| Observation cardinality boundary leaves an incident | `CODE_IN_BRANCH` | stub rehearsal |

Before this branch, every query touching `sv_local_observations` or
`sv_observation_mentions` failed at runtime: three columns were declared without
names, so Drizzle quoted the camelCase keys. The pilot path had never been run
against a database.

## Tenant isolation (Фаза 5)

| Item | Status |
| --- | --- |
| DS-P0-15 — `organization_id` on `reports` plus scoping | `DESIGNED` |
| DS-P1-28 — scoped prompt read instead of fetch-then-authorize | `DESIGNED` |
| DS-P1-10 — role checked on brand mutations | `DESIGNED` |
| P1-13 — non-owner runtime role, FORCE RLS, per-table policies | `DESIGNED` |

Details and sequencing in `TENANT_ISOLATION_DESIGN.md`. RLS is currently enabled
on 45 tables with zero policies and an owning connection, which blocks nothing;
isolation today rests on the `organizationId` predicates in the repositories.

## Out of scope for this TZ

| Item | Status |
| --- | --- |
| `sv_topics`, `sv_prompt_proposals` (addendum §5.1–5.2) | `NOT_BUILT` — coordinated in a separate session |
| Profile block inside the configuration lock snapshot | `NOT_BUILT` — the reader prefers it, no writer exists |

## What has to happen before any row can say RELEASED

1. The owner applies 0025–0030 to a real database.
2. The owner decides to register a live adapter, supplies credentials, and
   widens the contract allowlist — three separate deliberate acts.
3. A paid cycle runs and its ledger is reconciled against the provider invoice.

Until then every number this system produces comes from a stub.
