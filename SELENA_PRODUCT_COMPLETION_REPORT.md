# Selena AI Visibility — completion report

Date: 2026-08-15  
Release line: `release/selena-visibility-mvp`  
Release candidate: `selena-visibility-mvp-rc4` at
`9513e7aa53ac408cca8608fa1c4403f60256bae2`
Postflight report commit before this update: `d418f434f967138b76fe15e3a103cf8d5481fd35`

## Result

`RC4 STAGING VERIFIED — PRODUCTION OWNER GATE REMAINS`. Both RC4 application
services reached terminal `SUCCESS` in Railway staging and the browser E2E
completed in fixture-only mode. Production PostgreSQL, backup/PITR, DNS,
payments and real providers remain intentionally inactive. The Selena-scoped
changes lint, typecheck, tests and build successfully.

## Verified

| Area | Result | Evidence |
| --- | --- | --- |
| Selena flow, quote, payment boundary and state handling | PASS | Existing lib/web tests and fixture flow |
| Recommendation grounding and tenant isolation | PASS | Recommendation and persistence tests |
| Provider/credential boundary and Google Places removal | PASS | Provider-gate tests; active source/UI scan |
| Global emergency stop and order stop before transport | PASS (RC4 code) | `assertTransportAllowed` guard and audit-event regression tests |
| Scheduler/direct-dispatch exclusivity | PASS | Controlled-cycle tests and `SCHEDULE_MAINTENANCE_ENABLED=false` worker configuration |
| Expected-runs cardinality | PASS | Boundary tests block the next run above expected cardinality |
| Website Collector and SSRF policy | PASS | Collector/security tests |
| Lib tests | PASS | 46 files, 545 tests |
| Web tests | PASS | 13 files, 237 tests |
| Config tests | PASS | 6 files, 87 tests |
| Lib/web/config type checks | PASS | `check-types` |
| Web production build | PASS | `pnpm --filter @workspace/web build` |
| Changed-scope lint | PASS | Biome on Selena-changed files |
| `git diff --check` | PASS | clean |
| Provider/payment calls in this run | PASS | 0 / $0 |
| Full repository lint | DEFERRED | Existing upstream web diagnostics: 33 errors, 133 warnings; changed-scope lint passes |
| Impeccable detect | DEFERRED | CLI is not installed in this workspace |
| Production PostgreSQL, backup/PITR and rollback | BLOCKED | Production Railway environment has no services |
| RC4 Railway staging deployment | PASS | Web `a7a3bc26-172a-4367-9b6c-40b9cad89a4e`; worker `e0c52d08-5818-404d-be06-366b7545809e`; both `SUCCESS` and `RUNNING` |
| Browser E2E against RC4 staging | PASS | Public page render, no console errors, SSRF rejection and authenticated-route redirect verified |

## Release safety

Real provider, payment and Elmo measurement calls remain disabled. Production
was not mutated. `SCHEDULE_MAINTENANCE_ENABLED=false` remains the required
activation default. Google Places is not part of the MVP.

## Golden data

The Usha package is based on the existing immutable 240-row ledger, 31-row
overflow ledger, PDF and XLSX artifacts. Deterministic parity of the canonical
CSV and regenerated XLSX is PASS: 240 data rows and 29 columns are identical;
the PDF is a 50-row preview by design and is not row-for-row equivalent.
Semantic QC remains `NOT_REVIEWABLE` for all 20 selected rows because raw
answer text is absent; the reproducible queue is
`evidence/usha-semantic-qc-20-20260815.csv`.

## Completion matrix

| Requirement group | Status | Note |
| --- | --- | --- |
| Release hygiene and RC4 | PASS | Immutable tag `selena-visibility-mvp-rc4` remains at `9513e7aa` |
| Safety foundation | PASS | Permits, cardinality, budget, stop and duplicate guards are implemented/tested |
| Pilot methodology | DEFERRED | Semantic QC and Channel B manual evidence are not fully available |
| Canonical reporting | PASS | Canonical report/export parity and provenance are covered by existing tests |
| Client flow and PWA | PASS | Existing Selena routes and fixture flow cover the MVP boundary |
| Provider and secret boundary | PASS | Encrypted credential boundary; no plaintext output |
| Staging readiness | PASS | RC4 web/worker, fixture-only postflight and browser E2E verified |
| Production readiness | BLOCKED | Production DB/backup/PITR is owner-controlled |

## RC4 staging deployment evidence

The staging URL is healthy: `/api/setup-status` returned 200 with
`{"ready":true}`, and `/selena` returned 200. The authenticated dashboard API
returned 401 without a Bearer token, as expected.

The RC4 web deployment
`a7a3bc26-172a-4367-9b6c-40b9cad89a4e` reached `SUCCESS` with image digest
`sha256:d7a39d349aa38477e7017b9775df0328e11c49ffcf6b7c9c16841b43ce3b6aff`.
The initial worker attempt
`5adf69b9-4a37-4b4c-b05b-904c828d3542` failed before build because Railpack
could not infer a root start command. A fresh upload context was generated
directly from immutable tag `9513e7aa`, using the repository's
`docker/Dockerfile` with an explicit `FROM worker AS final` selection. Worker
deployment `e0c52d08-5818-404d-be06-366b7545809e` reached `SUCCESS` with
image digest
`sha256:57c9a497083d05736bf6a54e7af2a4bc416e79d19ad715de6294abb45c9618ba`.

Runtime postflight confirmed `DEPLOYMENT_MODE=local`,
`SCRAPE_TARGETS=stub:stub`, `ONBOARDING_LLM_TARGET=stub:stub`,
`SCHEDULE_MAINTENANCE_ENABLED=false`, and `DISABLE_TELEMETRY=true` without
printing secret values. Worker logs confirm pg-boss readiness and that the
maintenance schedule is disabled.

Browser E2E loaded `/selena` with meaningful content, valid CSS layout, no
framework overlay and no console warnings/errors. Submitting the private-host
fixture `http://127.0.0.1` returned the expected
`Private hosts are not allowed` safety error without an external fetch.
`/app/selena` redirected an unauthenticated browser to
`/auth/login?returnTo=%2Fapp%2Fselena`. No real provider, payment or
measurement call was made; production was not changed.
