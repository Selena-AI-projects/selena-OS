# RC7 Rollback

Preferred rollback is flags-off plus application rollback. Destructive DB
rollback is forbidden; additive tables and evidence are never deleted.

## Flags-off sequence (first kill switch)

1. Unset/false `LOCAL_AI_DISCOVERY_CLIENT_RESULTS_ENABLED`.
2. Unset/false `ASK_MAPS_MANUAL_PILOT_ENABLED`.
3. Unset/false `LOCAL_AI_DISCOVERY_ENABLED`.

With flags off (the shipped default): pilot API routes answer 404 before
authentication, the site CTA disappears (server-controlled
`localAiCtaEnabled`), and no navigation/export section exists. Previously
saved evidence rows remain stored and inert.

## Application rollback

- App rollback target: `0974b5b`; site rollback target: `574dc0f`.
- Roll back the application artifact/commit only; keep migrations 0021/0022 in
  place. Old-app-on-new-schema compatibility is expected because both
  migrations are purely additive (new enums/tables only, no altered or
  renamed objects); verify with an RC6 smoke on a migrated staging DB before
  relying on it in production (recorded as NOT RUN in RC7_TEST_REPORT.md).

## Post-rollback verification

Run the RC6 smoke: `/check` free readiness, `/visibility`, `/pricing`
(catalog $49/$79/$399/$2,490), CSV export, and confirm:
`ASK_MAPS_OUTBOUND_CALLS=0`, `PROVIDER_CALLS=0`, `NEW_PROVIDER_JOBS=0`,
`RUN_PERMITS=0`, `COST_EVENTS=0` — the pilot code path cannot produce any of
these by construction (see the zero-provider grep test in
`packages/lib/src/selena-manual-pilot.test.ts`).

Record an incident/audit note with trigger, scope and verification result
when a real rollback is executed.
