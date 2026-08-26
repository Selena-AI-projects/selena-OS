# RC7 Test Report

Environment: local container, pnpm 11, Node v22.22.2 (engines want 24.x —
pre-existing warning, CI runs Node 24). No database was provisioned in this
environment, no migration was applied, no network call to Google surfaces was
made. Statuses below are honest: rows that could not be executed here are
marked NOT RUN with the reason, never PASS.

## Commands actually executed (all exit 0)

| Command | Result |
|---|---|
| App `pnpm test` (baseline, SHA `0974b5b`) | 15 turbo tasks OK; `@workspace/web` 242/242 |
| App `pnpm test` (final, SHA `caeba8c`) | 15 turbo tasks OK |
| `pnpm --filter @workspace/selena-visibility-contracts test` | 5 files, 39/39 |
| `pnpm --filter @workspace/lib test` | 48 files, 557/557 |
| `pnpm --filter @workspace/web check-types` | clean |
| Site `npm run typecheck` / `npm test` / `npm run lint` / `npm run build` (final, SHA `d00f9e4`) | clean / 150/150 / clean / build OK |

## Matrix

| ID | Status | Evidence |
|---|---|---|
| B-01 Baseline suites | PASS | Baseline runs above at base SHAs before RC7 changes |
| B-02 RC6 behavior at flags off | PASS (suite-level) | All flags unset in every test run; full suites green; pricing/exports/routes untouched per manifest. Semantic HTML snapshots not diffed — NOT RUN at browser level |
| F-01 Default flags false | PASS | `local-discovery.test.ts` (config defaults) + site flag default-off |
| F-02 Flag-off isolation | PASS (unit/API-level) | Pilot routes return plain 404 before auth with flags off; site CTA renders only from server-set `localAiCtaEnabled`; no jobs/permits/cost paths exist in pilot code. Browser-level check NOT RUN |
| F-03 Double gate | PASS | `assertManualPilotAllowed` requires both flags — tested |
| F-04 Tenant isolation | PASS (repository-level) | `assertXOwned` pattern + org-scoped queries + invariant tests; runtime cross-tenant probe against a live DB NOT RUN (no DB here; `tools/selena_isolated_e2e.sh` covers it when run) |
| P-01 AUTOMATION_BLOCKED | PASS | Any non-manual capture method throws — tested incl. AUTOMATED/SCRAPING/API |
| P-02 Zero Ask Maps outbound | PASS (static) | No code path performs such a request; `selena-manual-pilot.test.ts` greps pilot modules for queue/fetch markers; runtime network capture NOT RUN |
| U-01 Observation validation | PASS | `assertObservationSubmission` tests (missing query/context/timestamp/transcript/screenshot rejected) |
| U-02 Ambiguous entity → unresolved | PASS | `isCountableMention`/`assertMentionMatch` tests |
| U-03 Inclusion-rate denominator | PASS | Metrics tests: only valid accepted observations; SURFACE_UNAVAILABLE excluded |
| U-04 Unordered → no position | PASS | `resolveExplicitPosition` tests |
| U-05 Inferred sources never stored | PASS | `SOURCE_NOT_EXPOSED` modeling + visibleSourceRate tests |
| U-06 Surface unavailable ≠ absence | PASS | Metrics tests |
| U-07 Score isolation | PASS | Site test: differing Local AI observations produce identical weighted scores; all LA rules weight 0 |
| U-08 Grounding | PARTIAL | Evidence-required submission enforced; report publication path not built yet (see NOT DONE) |
| U-09 Versioned correction | PASS (schema-level) | `supersedes_observation_id` + version column; runtime flow NOT RUN |
| U-10 KORA parent/child no double counting | PASS | Contracts tests: KORA Food Hall mention gives inclusion 0 for Two Moons Spa/Healthy Cafe, familyPresenceRate 1 |
| I-01 Manual lifecycle | PASS (repository-level) | configure→tasks→submit→review implemented and unit-tested as pure logic; end-to-end against a DB NOT RUN |
| I-02 Ledger provenance | PARTIAL | Audit events on every mutation; metric rows are pure functions over observations; report/ledger rendering for the pilot NOT BUILT |
| I-03 Zero provider execution | PASS (static + grep test) | Pilot code never touches pg-boss/`sv_run_permits`/`sv_runs`/`usage_events` |
| I-04 Existing exports compatible | PASS | `selena-export` tests unchanged and green |
| I-05 Report separation | NOT RUN | Pilot report section not implemented (owner-gated next slice) |
| I-06 Old payloads validate | PASS | All pre-existing contract/lib/web tests green |
| M-01..M-04 Migration matrix | NOT RUN | No database in this environment; migrations are hand-written, strictly additive, journal-sequenced — apply and verify per RC7_ROLLBACK.md before any production step |
| E-01..E-04 Browser E2E | NOT RUN | No running app/browser stack in this pass; unit-level equivalents cover flag-off behavior and i18n copy parity |
| S-01 IDOR | PASS (pattern-level) | Org-scoped queries + single "foreign" error code; runtime probe NOT RUN |
| S-02 XSS | PASS (pattern-level) | React-escaped rendering only; no dangerouslySetInnerHTML added |
| S-03 Upload enforcement | NOT APPLICABLE YET | No binary upload path exists; only opaque references are stored (owner decision pending on storage) |
| S-04 SSRF | PASS | Pilot/backend never fetches user-provided URLs; site checks reuse the existing SSRF-hardened crawler only |
| S-05 Secret scan | PASS | No secrets/cookies/session artifacts introduced; fixtures contain none |
| R-01 Flags-off rollback | PASS | Flags are off by default everywhere; suites prove RC6 behavior |
| R-02 Base SHA on new schema | NOT RUN | Requires a migrated DB; procedure recorded in RC7_ROLLBACK.md |
| R-03 Final full suites | PASS | Final runs above, exit 0 |

## Deliberately not done (owner gates / next slice)

Pilot dashboard tab and report section (badges, separate metrics rendering,
PDF/XLSX section), binary screenshot storage, analyst role, applying
migrations, browser E2E, draft PR (session rule: no PR without an explicit
owner request), any production or flag activation.
