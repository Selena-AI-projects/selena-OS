# Local Visibility: integration into Selena-OS

16 September 2026. CONTEXT_MODE: repository_only, explicitly approved by owner.

## Result

Local implementation and local validation are complete for the prepayment candidate. The overall milestone “everything before bank details” is **not closed**: no production release, production database migration, retained customer-data assignment or hosted acceptance has been performed in this task.

Source checkout: `selena-os-local-visibility-integration`, based on production commit `2e60da30f3ea75b65d10563d03ab502ef4d39a5a`. Local Maps validators, spherical grid and report rendering were ported from immutable recovered staging commit `265962769629cb93c5f60f3afe153e8de5ee956e`. Concurrent Local AI Geo-Grid source was not modified or copied.

## Implemented

- Workspace entry and `/selena/local/checkout`, with authenticated workspace selection.
- Restaurant identity confirmation using full Maps place links and coordinates; no network lookup.
- 1–15 queries, language, 3×3 or 5×5 spherical grid within a 3 km radius; $49 USD one-off prepared order.
- Durable immutable order snapshots, idempotent saves, history and reopening.
- A separate prepayment store, outside existing `sv_orders` and worker queues. Server and database require `PREPARED`, `paymentMode=DISABLED`, `executionMode=DISABLED`.
- Session and owner/admin write checks; same-origin POST, bounded request body, strict input schema, tenant RLS and cross-tenant restaurant foreign key.
- Retained-report registry and private HTML, CSV and print/PDF view with evidence validation and content hashes. Runtime cannot publish or edit retained reports. Production registry rejects fixture reports.
- A local-only import-packet preparer that validates an already standardized report against explicitly confirmed organization/project IDs; it does not write a database or remap customers.
- Additive migration `0048_local_prepayment`, appended after Selena-OS migration 0047. Staging migrations 0048–0076 were not replayed into this different schema history.

## Verification performed

| Check | Result | Scope |
| --- | --- | --- |
| Biome | PASS for changed implementation and proof files | Local |
| Web TypeScript | PASS | Local |
| Targeted unit tests | 23 passed, 3 files | Local API, report, existing auth contract, legacy reports without fabricated order IDs |
| Disposable PostgreSQL store proof | PASS | Concurrent replay, conflict rollback, two distinct users, viewer/spoof denial, zero provider calls |
| Retained report proof | PASS | Synthetic local report, JSONB normalization, private CSV, other-tenant 404, tampered hash rejection |
| Complete migration chain | 49 migrations passed | Fresh local PostgreSQL; does not prove existing production ledger compatibility |
| Browser | PASS | Real component/API with explicit in-memory fixture auth/store; restaurant → 50 planned checks → saved order → reload |
| Responsive view | PASS | 390, 768, 1280 px; no horizontal overflow |
| Impeccable detect | `[]` | New customer component and checkout route |
| Final web build | PASS | Local client/server production build, not deployed |
| Diff whitespace / secret-pattern scan | PASS / zero findings | Changed source only |

Build warnings: large existing chunks; local Sentry release/source-map upload skipped because no auth token was provided. No warning was suppressed or dependency/configuration policy weakened.

The direct route generator initially omitted TanStack Start's existing generated registration footer; restoring that footer resolved the TypeScript errors. Final build regenerated routes normally and passed.

## Remaining work before the whole milestone can close

1. Production ledger reconciliation passed read-only: 48 known hashes, no unknown hashes, only 0048 pending. Confirm backup/restore evidence and runtime grants before migration. See `PRODUCTION_READONLY_CHECK_20260916.json`.
2. Prepare and execute the appropriately authorized production release: exact reviewed source, only migration 0048, then web rollout and `SELENA_LOCAL_PREPAYMENT_ENABLED=true`. This flag cannot enable payment, fixtures or provider execution.
3. Confirm the target production workspace for the retained AVLI report. Saved source organization `6e45fdda-4bd3-4995-b69b-3313645e8e7b` is absent from production; an unrestricted read verified only `Default`. The owner explicitly selected a separate AVLI workspace. On 2026-09-16 at 01:39:47 UTC, production organization `03f51317-2dec-4f03-91e9-bf086108ea96` (`AVLI`, slug `avli`) was created with exactly one owner membership for Selena Nigmatullaeva and zero invitations. Default and existing sessions were not changed. Do not infer ownership from restaurant name or import across customers. Legacy conversion is now prepared and schema-validated: 135 valid observations, 15 queries, 9 points, 99 retained competitor identities. Source project `3f6532a1-e1c2-4ccb-8506-96e0965d8cc8` and location `a9551f64-8a61-48a2-a33d-de61de878a71` were verified in a tenant-scoped read-only staging transaction. A separate target-bound packet has now been validated for the new AVLI organization, retaining all 135 observations and original source provenance. It has NOT been imported into production. The original source-bound packet is preserved.
4. Verify real sign-in, restaurant/order persistence, two real client sessions, report opening and CSV on the deployed site. Local browser fixture proof does not establish these hosted results.
5. Verify production support/notification behavior separately. The historical delivered staging notification is not production proof; no production notification adapter was added by this prepayment diff.

Bank details, live payments, simulated production payments, paid/recurring measurements and the separate Local AI Geo-Grid work are excluded.

## Release identity and rollback

See `INTEGRATION_MANIFEST.json` for exact changed-file hashes. No commit, push or merge was made. Rollback should first disable `SELENA_LOCAL_PREPAYMENT_ENABLED`, then restore the previous web deployment if needed, while retaining new tables and saved records. Do not drop customer data as a rollback shortcut. No unrelated flags, worker services, environment variables or configurations were changed.

Production identity previously verified in this task: project `399ba28b-19e0-4a67-98f8-7e2a2ea6e7ee`, environment `4685358e-28cb-4bfd-80c9-8e829fbe6c00`, web `8dbcab7c-7b6b-4f5b-8e4e-e489ec2448e2`, observed deployment `6ee17b4b-8782-47c8-8fe8-e7f16be88717`. Recheck before release.

## Artifacts

- `INTEGRATION_MANIFEST.json`: source identity, file hashes and source manifest digest.
- `prepayment-fixture-390.png`, `prepayment-fixture-768.png`, `prepayment-fixture-1280.png`: local fixture screenshots.
- `tools/local_prepayment_proof.sh`: self-contained loopback PostgreSQL proof; temporary database only.
- `apps/web/scripts/local-prepayment-browser-proof.ts`: local browser proof; temporary profile, external network requests blocked.
- Final local build log: `/tmp/selena-local-prepayment-final-build.log`.
- Private source-bound AVLI packet, conversion provenance, preview HTML/CSV and conversion script: `/Users/msnigmatullaeva/Downloads/selena AI company/LOCAL_VISIBILITY_PRODUCTION_PREPARATION_20260916/`. Customer report data is outside the code repository. The legacy report has `orderId=null`; it is not a newly paid/prepared order. Original analytical HTML/PDF remain preserved separately; new structured analysis is explicitly PENDING.
