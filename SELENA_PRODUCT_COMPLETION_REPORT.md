# Selena AI Visibility — completion report

Date: 2026-08-15  
Release line: `release/selena-visibility-mvp`  
Release candidate: `selena-visibility-mvp-rc6` at final HEAD. Immutable RC4 remains at
`9513e7aa53ac408cca8608fa1c4403f60256bae2`; immutable RC5 remains at
`918176c3cbc4b4b7484608d8fa91ebe402afde9a`.

## Result

`RC6 STAGING ACCEPTED — OWNER CATALOG LOCK REQUIRED`. RC6 web and worker reached
terminal `SUCCESS` in Railway staging and browser acceptance completed in
fixture-only mode. Production PostgreSQL, backup/PITR, DNS, payments and real
providers remain intentionally inactive.

## Verified

| Area | Result | Evidence |
| --- | --- | --- |
| Selena flow, quote, payment boundary and state handling | PASS | Existing lib/web tests and fixture flow; RC5 adds provider-neutral test-mode payment contract |
| Recommendation grounding and tenant isolation | PASS | Recommendation and persistence tests |
| Provider/credential boundary and Google Places removal | PASS | Provider-gate tests; active source/UI scan |
| Global emergency stop and order stop before transport | PASS (RC4 code) | `assertTransportAllowed` guard and audit-event regression tests; must remain a release-worker gate |
| Scheduler/direct-dispatch exclusivity | PASS | Controlled-cycle tests and `SCHEDULE_MAINTENANCE_ENABLED=false` worker configuration; no recurring maintenance fan-out |
| Expected-runs cardinality | PASS | Boundary tests block `expected_runs + 1` |
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
| RC5 tracked Railway build targets | PASS (local) | `railway.json` selects `docker/Dockerfile`; web and worker final targets build successfully |
| RC6 catalog contracts | PASS | Four locked plans, exact models, channel separation, cardinality, caps, retry reserve and Growth scope gates |
| RC6 staging deployment | PASS | Final web `d040633d-72c3-4604-b38b-fc4acb4bdfa0`; worker `29665e7c-1803-475e-b34c-226bfdbf73d3`; both SUCCESS |
| RC6 browser acceptance | PASS | Four plan cards/prices/channels, zero console errors, SSRF rejection and auth boundary |

## RC6 continuation

RC6 adds the Selena-specific versioned catalog `selena-catalog-rc6-v1`, four
tariffs, exact Visitor/API channel and model allowlists, immutable quote/order
lock helpers, hard cardinality/provider/order/retry caps and Growth scope gates.
Payment remains provider-neutral and test-only; no checkout session, payment
call or provider call is enabled.

RC4 and RC5 were not moved or deleted.

The earlier Railway GitHub access blocker was resolved by the owner. RC5 was
then deployed from the tracked GitHub branch to staging only.

RC5 deployment evidence:

- web `39a4772f-c990-4e06-a7ca-5769177fd676`, SUCCESS, image
  `sha256:13b1d768e3c77458b8e407448863995b9b32d92dbe5cb1218622d74df4a7c46a`
- worker `02527bc9-0808-476b-9349-d576f284edeb`, SUCCESS, image
  `sha256:1da3e3c9e6171407b73b4d00aa8a34d768dfe6c68934874ee255a12043760e73`
- source commit `f9edcd8ff05483007094416f6d4a7576e191168d`
- Railway config `/railway.json`, builder `DOCKERFILE`, path
  `docker/Dockerfile`
- `/api/setup-status` and `/selena`: HTTP 200
- worker log: `SCHEDULE_MAINTENANCE_ENABLED=false`, worker ready
- provider/payment/measurement calls: 0; production unchanged

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
| Staging readiness | PASS | RC5 web/worker from GitHub-tracked Dockerfile, fixture-only postflight and browser E2E verified |
| Production readiness | BLOCKED | Production DB/backup/PITR is owner-controlled |

## RC6 deployment and browser postflight

Source commit: `c853f75a4f1a1a0601c67ed5b2292719cc0afc39`. Final web image digest:
`sha256:6f7b724fb9c537d8b5847ee6d5093e01ac60f4fa570ca7195c260fec2ea98dc4`.
Final worker image digest:
`sha256:093aba6d01b1fdf81e9a55d899a2ce755999082366f940fbf68f6f854b3a37c8`.
Tracked Railway config used `/railway.json` with `docker/Dockerfile`.
`/api/setup-status` and `/selena` returned 200; worker was ready with
`SCHEDULE_MAINTENANCE_ENABLED=false`. Provider calls, payment charges and
measurement jobs were 0.

Browser verified all four plans, exact prices, Visitor/API labels and Growth
manual approval text with zero console errors. The private-host fixture was
rejected with `Private hosts are not allowed`, and `/app/selena` redirected to
the login boundary. Quote/test-payment behavior is covered by contract/server
tests; no credentials or real payment action were used in staging.

## RC5 browser postflight

The RC5 browser postflight loaded `/selena` with meaningful content and no
console errors. Submitting `http://127.0.0.1` produced the expected
`Private hosts are not allowed` rejection. `/app/selena` redirected to the
login boundary with the expected return path. The health/API checks and worker
postflight remained fixture-only; no provider, payment or measurement call was
made.

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
