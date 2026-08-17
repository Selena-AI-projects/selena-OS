# RC7 Changeset Manifest

Branch: `claude/selena-systems-site-app-38rzll` in both repositories. No merge,
no deploy, no PR was created. Production is unchanged: no DNS, Railway/Vercel,
production DB, queue, storage or secrets were touched; no migration was applied
to any database; all new feature flags default off; zero external calls to
Ask Maps / Google Maps / Google Places were made by the delivered code or
during implementation.

## App repository (`parkourcafe/selena-ai-visibility`)

| Item | Value |
|---|---|
| Base SHA (rollback target) | `0974b5b` |
| Head SHA | `caeba8c` |
| Commits | `06d40b5` mapping/gate 0 · `0b3b958` policy+flags · `1424bae` entities+locations · `5d652bb` pilot contracts · `6108bec` pilot storage/repositories · `caeba8c` pilot API |

Changed/added files:

- `packages/selena-visibility-contracts/src/local-discovery.ts` (+ tests,
  `node-crypto.d.ts`, `index.ts` export) — policy, flags, observer context,
  lock block, cardinality, submission validation, metrics.
- `packages/lib/src/db/schema.ts` — `sv_entities`, `sv_business_locations`,
  `sv_pilot_cycles`, `sv_capture_tasks`, `sv_local_observations`,
  `sv_observation_mentions`, `sv_observation_evidence_assets`,
  `sv_audit_events` (+ enums), all `.enableRLS()`.
- `packages/lib/src/db/migrations/0021_selena_local_discovery_entities.sql`,
  `0022_selena_manual_pilot.sql`, `meta/_journal.json` (idx 21, 22) — strictly
  additive; not applied to any database.
- `packages/lib/src/selena-entities.ts`, `selena-manual-pilot.ts` (+ tests),
  `selena-visibility-repositories.ts`, `package.json` exports.
- `apps/web/src/lib/selena-pilot-gate.ts`,
  `apps/web/src/routes/api/v1/selena/pilot/**` (5 route files),
  `apps/web/src/routeTree.gen.ts` (regenerated, additive).
- `RC7_ARCHITECTURE_MAPPING.md`, `RC7_CHANGESET_MANIFEST.md`,
  `RC7_TEST_REPORT.md`, `RC7_ROLLBACK.md`.

Actual flag names: `LOCAL_AI_DISCOVERY_ENABLED`,
`ASK_MAPS_MANUAL_PILOT_ENABLED`, `LOCAL_AI_DISCOVERY_CLIENT_RESULTS_ENABLED` —
all default off, read via `localDiscoveryConfigFromEnv`.

## Site repository (`parkourcafe/SELENA-AI-COMPANY`)

| Item | Value |
|---|---|
| Base SHA (rollback target) | `574dc0f` |
| Head SHA | `d00f9e4` |
| Commit | `d00f9e4` unscored Local AI Readiness group |

Changed files: `lib/visibility/readiness/ruleRegistry.ts` (LA-01…LA-09,
registry v2, `unknown` status), `readiness/agentReadiness.ts`,
`checks/htmlSignals.ts` (`htmlLang`), `checks/actionReadiness.ts`
(shared Maps-link regexes), `checks/recommendations.ts` (4 locale tables),
`lib/diagnostics/flags.ts` (`LOCAL_AI_DISCOVERY_ENABLED`),
`lib/visibility/liveReport.ts` (`localAiCtaEnabled`), `lib/visibility/types.ts`,
`content.en.ts`, `content.ru.ts`, `components/visibility/LiveReportView.tsx`,
`data/visibility/cloudflare-selena-parity-matrix.v1.json`,
`tests/unit/agentReadinessMatrix.test.ts`, `tests/unit/liveReport.test.ts`.

Pricing (`$49/$79/$399/$2,490`), checkout behavior, existing scores, routes,
redirects, sitemap and old exports are unchanged in both repositories.
