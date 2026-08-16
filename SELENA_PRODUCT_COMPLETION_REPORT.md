# Selena AI Visibility — completion report

## Master Correction current-state update — 2026-08-16

This section supersedes the release-status wording below for the current
Master Correction release. The historical RC6 deployment evidence remains
below as an immutable record; it is not evidence for the current deployment.

### Current repository state

- App branch: `release/selena-visibility-mvp`.
- App origin and HEAD before this scoped change: `62267e4573fd5706e7ff8bf5e5598f70d31e4aa2`.
- App scoped commits after this change: `6d0a6d83`, `acfba5ac`, `42a56a55`.
- Documentation follow-up commit: `7a04cac8` (OSS provenance and MIT notice).
- Final report-only commit: `ce16dec0`.
- Site branch: `release/ai-visibility-master-correction`.
- Site origin and HEAD before this scoped change: `baf3e6ebf16ff5d338c09af7f36a23218511a61c`.
- Site scoped commit after this change: `ccd02056ceb4d458e0cf3534b5c8b9acc5d88c8a`.
- The scoped commits are pushed to their release branches and deployed only to
  staging/preview. No production promotion was performed.
- User-owned `elmo-source/tmp/` is intentionally excluded from the scope.
- Existing immutable app tags `selena-visibility-mvp-rc4`, `rc5`, `rc6` and
  `rc6-v1.2` were not moved or deleted.

### Implemented in the current working tree

- Canonical free Public Readiness remains `/check` and `/ru/check`: bounded
  five-page collection, zero paid AI-provider calls, versioned scoring,
  crawler matrix, block citability, evidence, fix preview, copy/export,
  verification comparison and separate readiness/AI-visibility claims.
- Legacy public sample/token report routes are permanently tombstoned; old
  feature flags cannot re-enable illustrative AI-answer data.
- `/free-ai-map` and `/ru/ai-map` are compatibility redirects, not a second
  product. `/ai-systems` and its three detail routes are the canonical custom
  service entry. Four AI Visibility plans remain separate from four AI Systems
  service prices.
- The app's legacy readiness scan/fix/verify/public-scan routes now return the
  canonical 410 boundary and do not read the old `sv_public_scans` contract or
  old readiness scorer. The old contracts module is no longer exported.
- Readiness findings now carry rule/version, page URL, evidence fields, source
  engine/version, captured timestamp, generated-fix ID and verification status.
- The persisted Cloudflare/Selena parity matrix covers content, API, commerce,
  N/A, platform, multilingual and transport/SSRF scenarios. Its PASS label is
  explicitly a controlled-fixture contract, not a live Cloudflare benchmark.
- The OSS registry now pins `geo-seo-claude` to upstream commit
  `ed280a860bca84b22f0199ee2d8776ce0c55bd56`, records that no upstream release
  tag was returned, reproduces the upstream MIT notice and links its Central
  Memory source provenance.

### Current quality evidence

- Site: 140 unit tests, typecheck, ESLint, Next production build,
  `git diff --check` and `npx impeccable detect` passed.
- App web: 242 unit tests, typecheck, production build and changed-scope
  Biome lint passed. Selena contracts: 15 tests and typecheck passed.
- App repo-wide Biome lint remains `PRE-EXISTING`: 34 errors, 133 warnings and
  15 infos across the existing 297-file scope; the changed files are clean.
- The workspace reports a non-blocking Node engine warning (project requests
  Node 24.x; the available runtime is Node 22.23.0).
- Local route smoke: `/`, `/check`, `/pricing`, `/visibility`, `/lab`,
  `/ai-systems`, Russian equivalents and AI Systems detail routes returned
  200; retired report sample returned 404; legacy API report returned 410.
- Railway staging web deployment `e57379ed-fa37-459a-b68b-eeaa75d6a305` and
  worker deployment `3a4b5de6-e359-4526-82f5-e40f78138b3d` reached terminal
  `SUCCESS` on app commit `42a56a5501699f39b30b56ce2dc7b13463c2e1f5`. Both
  used the tracked `railway.json` Dockerfile configuration. Image digests:
  web `sha256:e7d42db40cada8ada28fa0f09320c87cc484786ecb746ac492f59e94b68d6c33`;
  worker `sha256:1eec597308713aff360a464f122f318fa403ec1dd8fb81022786c6019ef17ce5`.
- The final docs/provenance head `7a04cac844ae21b26a298a745e1be1be7f190a1e`
  also reached terminal `SUCCESS`: web deployment
  `0e80f112-21d9-45fc-a9c0-781b087ae5b3` with image digest
  `sha256:e7d42db40cada8ada28fa0f09320c87cc484786ecb746ac492f59e94b68d6c33`;
  worker deployment `b7a032a6-a9e1-4b82-90e9-7594169b1d15` with image digest
  `sha256:44e12860086d59575b67ce21265a77cc93496ad40e5f03c693b131213e3c115c`.
- Staging health: Railway web domain `web-staging-4a8f.up.railway.app` and
  `app.selenasystems.com` returned HTTP 200 for `/api/setup-status`; worker
  logs reported `SCHEDULE_MAINTENANCE_ENABLED=false` and readiness. `/app/selena`
  and the canonical `/app/academy` boundary are protected by login; the old
  `/app/learn` path is a compatibility redirect to `/app/academy`. No
  provider/payment/measurement action was started.
- Public-site preview deployment `dpl_E8W3A8P6fYH8ebYqbucvLZdUNiKu` is
  `Ready` at
  `https://selena-ai-company-ker17hbs7-yulaboober.vercel.app` for the site
  release branch. Browser route smoke passed for English/Russian check,
  pricing, visibility, Lab and AI Systems routes; legacy redirects and the
  retired sample report boundary were verified, with zero application console
  errors observed. The browser surface exposed a fixed desktop viewport, so
  device-emulation/mobile-layout PASS is not claimed; viewport meta and
  responsive CSS remain present and local quality gates passed.

### Release and owner boundary

- The Master Correction commits were pushed to
  `release/selena-visibility-mvp` and
  `release/ai-visibility-master-correction`; staging/preview deployment and
  post-deploy checks completed as recorded above. No production deployment,
  promotion or DNS change was performed.
- Production PostgreSQL, live payments, real provider calls, maintenance and
  measurement jobs remain unchanged and OFF.
- Controlled parity is PASS. A live read-only Cloudflare comparison on the
  same public URL is recorded in the site repository; numeric scores are not
  combined because the scoring denominators differ.
- The safe public-site rollback target remains the owner-locked published
  artifact `07d6fe9`; the app's existing immutable RC6 tags remain available.

## RC6 v1.2 Public Readiness continuation — 2026-08-15

This continuation is post-`selena-visibility-mvp-rc6` and does not move that
immutable tag. Commit `66a1a1b737f789a0450aa1272b1950aebc8a0981` adds the
canonical public `/check` route, a free Public Readiness result, and safe
Generate Fix → Preview behavior. The result
contains a versioned score, weighted component scores, rule-versioned findings
and evidence, and explicitly reports `paidProviderCalls: 0`. Readiness remains
separate from observed AI visibility.

Local contracts tests/typecheck, lib typecheck, web tests, web build and
changed-scope lint passed. Staging web deployment
`356822e9-eddd-484d-8073-843e99be038a` and worker deployment
`1d1cb57f-d467-4013-8cf1-7d5486eba5b3` are `SUCCESS` on commit `f23ee36e`;
`/check`, `/selena` and `/api/setup-status` returned HTTP 200.

Browser acceptance verified pricing, SSRF rejection, a real readiness result
for `example.com`, and the expanded fix preview with the explicit “nothing is
applied automatically” guard. Worker logs confirm maintenance is disabled and
the worker is ready. The readiness result now contains deterministic
block-level citability provenance; the OSS registry is documented in
`SELENA_RC6_OSS_COMPONENTS.md`. The persisted scan, fix and verification
routes are deployed behind the existing API authentication boundary;
unauthenticated probes returned 401. Verification creates a new scan record
and returns a readiness-only comparison with `providerCalls: 0`.

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
