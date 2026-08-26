# Selena OS MVP Implementation Gap Report

**Дата аудита:** 2026-08-26
**Источник требований:** `Selena_OS_MVP_Technical_Spec_v1_2026-08-26.docx`, разделы 14-15 и AC-001..AC-032.
**Baseline:** текущий local working-tree patch относительно `HEAD` (`19c235704344ce67e292a4d782990c1488f34fb4`).
**Контрольная сумма `0021`:** `sha256:88c3030c9c85b000b2ac8c07fe75031d0da5eef24afcccb182cdb4571999e5c2`.
**Ограничения соблюдены:** `0021` не исполнялась в staging или production. Она была исполнена только в трёх новых изолированных disposable контейнерах Supabase PostgreSQL `17.6.1.143`: clean full-chain + pgTAP, pre-`0021` upgrade fixture и clean restore target. Production deploy, Postiz и социальные публикации не выполнялись; `.env` и credentials не читались.

Codex Security diff scan completed with no remaining confirmed findings in its original snapshot. It warned that the working tree changed during the scan; the post-fix source trace, tests and secret scan recorded below are the authoritative evidence for the final local state.

## Как читать статусы

- **PASS**: есть доказательство работающего требования в соответствующей среде и тесте/ручной проверке.
- **PARTIAL**: есть локальный код или статическая защита, но нет требуемого runtime boundary, DB/integration test или полного vertical slice.
- **MISSING**: требуемая capability отсутствует в репозитории.
- **BLOCKED**: проверка или capability требует не предоставленной внешней инфраструктуры, credentials, legal/ADR решения или staging database.

Ни один TypeScript helper, таблица или UI-экран в этом отчёте сам по себе не считается production capability.

## Scope и фактические изменения

Локальная реализация добавляет Control Room route/UI, server functions, Drizzle schema/migration и pure gate helpers. После решений владельца она дополнительно:

- переносит canonical Selena tables в private `selena_registry`, `selena_release`, `selena_audit`, `selena_ingest_raw` и `selena_performance` schemas (`packages/lib/src/db/schema.ts:869-1362`, `packages/lib/src/db/migrations/0021_selena_control_room.sql:58-365`);
- вводит no-login role groups, transaction-scoped verified context, `FORCE RLS`, role grants/revokes, immutable triggers, release intents и transactional outbox contract (`0021:6-56`, `:382-902`);
- выполняет все Control Room database operations inside a transaction that first establishes server-owned context (`apps/web/src/server/selena-control-room.ts:56-73`);
- добавляет 34-case disposable-only pgTAP source with cross-brand, forged-context, approval, release-intent/outbox idempotency, nonce, role, immutability and context-leak negatives (`packages/lib/src/db/tests/0021_selena_control_room.pgtap.sql`).

DB schema/RLS/role controls получили **PASS только в disposable scope**: clean full migration chain, recorded checksum, `34/34` pgTAP, pre-`0021` tenant-preservation fixture и clean-target restore smoke прошли. Они остаются **PARTIAL** для staging/production и не создают deployable Gateway, Postiz, Trigger.dev, Payload, scanner, object storage, network boundary или ingestion adapter.

## Ответы на архитектурные вопросы

| Вопрос | Ответ и evidence | Статус |
|---|---|---|
| Release Gateway отдельный deployable service или библиотека? | Отдельного service нет. В web/lib удалены manifest/dispatch и signer surfaces; остаются pure gate/classification rules (`packages/lib/src/selena-control-room.ts:116-145`) и UI-декларация отсутствующего Gateway (`apps/web/src/routes/_authed/app/$brand/control-room.tsx:577-582`). ADR-004 и service design описывают будущий отдельный deployable. | MISSING |
| Как запрещён direct frontend/agents/Trigger доступ к Postiz? | В source нет Postiz client: проверка `rg -l -i 'postiz' apps/web/src apps/worker/src packages/lib/src` вернула 0 файлов. Это отсутствие интеграции, не network/credential denial. Топология запрета определена только в `docs/control-room/phase-0/ADR-004_POSTIZ_DEPLOYMENT_AND_LICENSE.md`. | MISSING |
| Только Gateway может получить Postiz credential? | Нет реального Postiz credential namespace, vault policy, IAM role или network route. Целевая physical placement определена ADR-004, но не реализована. | MISSING |
| Есть Trigger.dev durable workflow: queues, retries, idempotency, approval wait, cancellation, reconciliation? | Trigger.dev отсутствует. Worker использует только pg-boss queues для иных задач (`apps/worker/src/index.ts:37`, `:42`), без Selena handler. | MISSING |
| Используется Payload; если нет, чем заменён Content Registry? | Payload отсутствует в dependencies/source. ADR-003 фиксирует Payload = DEFER FOR MVP, а не несовместимость с TanStack/Vite: отдельный Next.js/Payload service и REST API технически возможны. До review после первого бренда единственный Registry -- Drizzle/PostgreSQL `selena_registry` tables (`packages/lib/src/db/schema.ts:918-1074`). Он не обладает deployed storage/scanning или production evidence. | PARTIAL |
| Где original assets и derivatives? | `content_assets` now reserves `storage_key`, `object_version_id`, SHA-256 and scanner-event metadata (`schema.ts:1004-1036`), but buckets, immutable object controls, derivative linkage and signed URLs do not exist. | MISSING |
| Реализованы sha256, immutable originals, malware/storage scanning? | SHA-256 format/size/MIME checks and a forced `QUARANTINED` web insert state migrated successfully; pgTAP rejects a quarantined asset and restore preserves asset hashes. Approval predicate rejects non-`PASSED` or expired asset metadata (`0021`; `db/tests/0021_selena_control_room.pgtap.sql`). Нет object-byte hashing, immutable storage, MIME sniffing или scanner provider/result. | PARTIAL |
| Есть PostgreSQL RLS, отдельные service roles и cross-brand negative tests? | Disposable evidence passed: private schemas, no-login web/worker/Gateway/Trigger/ingestion/analytics/scanner/migration/backup roles, grants/revokes, `FORCE RLS`, verified context and `34/34` pgTAP, including forged context and cross-brand DML. Restore smoke reconfirmed all 16 private tables `FORCE RLS`, runtime `NOBYPASSRLS`, `anon/authenticated` denial and no-context web read denial. No staging role identity exists. | PARTIAL |
| Есть outbox consumer или только таблица? | Web atomically creates `selena_release.release_intents` and `selena_release.outbox_events` only after fresh approval, account, evidence, rights/consent, asset-scan and kill-switch checks (`apps/web/src/server/selena-control-room.ts:711-903`; `schema.ts`). The contract has unique idempotency keys, but no consumer, lease worker, Trigger queue, retry, approval wait, cancellation or reconciliation runtime. | PARTIAL |
| Реализован настоящий Postiz adapter? | Нет dependency, client, account mapping, OAuth flow, webhook/reconciler или adapter implementation. | MISSING |
| Есть ambiguous-result flow без blind retry? | Pure classification returns `RECONCILE_REQUIRED` (`packages/lib/src/selena-control-room.ts:138`, test `:130`), but no Gateway/worker uses it and no reconciliation poller exists. | PARTIAL |
| Есть platform ingestion, raw snapshots, normalization, attribution? | `selena_ingest_raw.raw_platform_snapshots` and performance records exist as unexecuted append-only data contracts (`schema.ts:1267-1362`), but нет adapter/dlt/ingestion run, normalization, DQ или attribution processor. | PARTIAL |
| Какие runtime variables и внешние credentials отсутствуют? | Current source has no Postiz, LinkedIn, Trigger, Gateway, Supabase Storage, or scanner integration contract. Required-from-user actions below are sequenced: decisions first, projects only after acceptance, secrets only after integration code. No credential value is requested now. | BLOCKED |

## Проверка архитектурной подмены

| Проверка | Результат |
|---|---|
| Control Room UI не подменяет Payload/Content Registry | **Подтверждено как gap.** UI is a client of custom tables (`apps/web/src/routes/_authed/app/$brand/control-room.tsx:223`); Payload is absent. |
| TypeScript release-check не назван отдельным Release Gateway | **Исправлено локально.** Web/lib manifest signing and dispatch surfaces removed; UI states that the Gateway is not deployed (`apps/web/src/routes/_authed/app/$brand/control-room.tsx:577-582`). No service/network boundary exists. |
| Таблица outbox не названа durable workflow | **Подтверждено как gap.** It is an atomically-written contract only; there is no consumer or Selena durable workflow. |
| Таблица metrics не названа ingestion | **Подтверждено как gap.** There is no connector, raw record or normalization. |
| Postiz type/interface не названы интеграцией | **Подтверждено как gap.** There is no Postiz adapter/interface/client in the reviewed source. |

## Phase 0 integration decisions

| Decision | Status | Evidence | Consequence before first migration |
|---|---|---|---|
| Trigger runtime | APPROVED; implementation deferred | `docs/control-room/phase-0/ADR-001_TRIGGER_RUNTIME.md`; worker remains pg-boss-only at `apps/worker/src/index.ts:37-75` | Trigger.dev Cloud is the selected durable workflow provider. No task, queue, credential, or PostgreSQL access exists yet. |
| Database and storage | APPROVED; project deferred | `ADR-002_DATABASE_AND_STORAGE.md`; local migration `0021` | Supabase Cloud PostgreSQL/private Storage; Better Auth only; five canonical schemas excluded from Data API; browser uses Selena backend only. |
| Content Registry | DEFER FOR MVP | `ADR-003_PAYLOAD_INTEGRATION.md`; prospective registry `packages/lib/src/db/schema.ts:927-1051` | Payload is technically viable as a separate service, but deferred because of a second runtime/auth/migration boundary and duplicate Registry. Re-evaluate after first brand. |
| Postiz and Gateway | BLOCKED_CONTRACT_SPIKE | `ADR-004_POSTIZ_DEPLOYMENT_AND_LICENSE.md`; `RELEASE_GATEWAY_SERVICE_DESIGN.md` | Provisional choice is Postiz Cloud in one isolated Selena Systems organization. Self-hosting is fallback only if Cloud spike fails; Gateway remains a future separate deployable. |
| Primary channel | PILOT APPROVED; external setup blocked | `ADR-005_PRIMARY_CHANNEL.md` | LinkedIn Page pilot is approved. Candidate callback is `/integrations/social/linkedin-page`, to be re-verified against current Postiz docs and actual Cloud/version immediately before registration. |
| OSS ownership | PARTIAL | `OPEN_SOURCE_COMPONENT_MATRIX.md` | Matrix distinguishes service/package/adapt/reject and records license/version observations. No component was installed or copied. |

### Reauthored `0021` table map

All rows below are local, unexecuted source evidence from `packages/lib/src/db/migrations/0021_selena_control_room.sql:82-365,647-902`. RLS is `ENABLE + FORCE` with role-specific policies. Retention is a contract to configure later, not a live provider setting.

| Legacy/current concept -> canonical physical table | Owner / schema | Runtime role and allowed operation | Immutable | RLS / retention | Disposition |
|---|---|---|---|---|---|
| `scr_channel_accounts` -> `channel_accounts` | Registry / `selena_registry` | Web `SELECT`; Gateway `SELECT/INSERT/UPDATE`; scanner read only | No, configuration history is audited | Brand context; retain account configuration/audit per policy | REFACTORED; browser cannot allowlist accounts |
| `scr_content_items` -> `content_items` | Registry / `selena_registry` | Web `SELECT/INSERT/UPDATE` | No, mutable draft container | Brand context; retain lifecycle per policy | REFACTORED |
| `scr_content_versions` -> `content_versions` | Registry / `selena_registry` | Web `SELECT/INSERT` | Yes, DB trigger rejects `UPDATE/DELETE` | Brand context; audit/legal retention | KEPT AS DEFERRED-PAYLOAD REGISTRY |
| `scr_content_assets` -> `content_assets` | Registry / `selena_registry` | Web `SELECT/INSERT QUARANTINED`; scanner scoped `SELECT/UPDATE scan fields` | Database record is mutable only by scanner state; object immutability external | Brand context; storage retention is blocked | REFACTORED |
| `scr_approvals` -> `approvals` | Registry / `selena_registry` | Interactive-owner web `SELECT/INSERT` only | Yes | Brand context plus DB predicate for membership, account, asset scan/expiry; audit retention | REFACTORED |
| `scr_kill_switches` -> `kill_switches` | Registry / `selena_registry` | Web owner path `SELECT/INSERT/UPDATE` | No, state change audited | Brand/global context; retain incident/audit policy | REFACTORED |
| `scr_release_manifests` -> `release_manifests` | Gateway / `selena_release` | Gateway `SELECT` exact `READY` manifest, `INSERT`; web metadata projection | Yes | Gateway exact-manifest or web brand policy; release/audit retention | REPLACED |
| new local dispatch contract -> `release_intents` | Release / `selena_release` | Web `SELECT/INSERT`; registry worker `SELECT/UPDATE` | No, status evolves under worker only | Brand context, unique approved release/account idempotency | ADDED AS CONTRACT, NOT A GATEWAY |
| `scr_outbox_events` -> `outbox_events` | Release / `selena_release` | Web `SELECT/INSERT`; registry worker `SELECT/UPDATE` | No, status/lease is worker-owned | Brand context, event and idempotency unique | ADDED AS TRANSACTIONAL OUTBOX CONTRACT, NOT A DURABLE WORKFLOW |
| `scr_publications` -> `publication_attempts` | Gateway / `selena_release` | Gateway `SELECT/INSERT`; web metadata projection | Yes | Brand + exact manifest; immutable transition history; release/audit retention | REPLACED |
| `scr_incidents` -> `incidents` | Audit / `selena_audit` | Gateway `INSERT/UPDATE`; web `SELECT` | No, resolution state changes | Brand context; incident retention policy | REFACTORED |
| `scr_audit_events` -> `audit_events` | Audit / `selena_audit` | Web/Gateway append, web read | Yes | Brand/global context; audit/legal retention | REFACTORED |
| new raw contract -> `raw_platform_snapshots` | Ingestion / `selena_ingest_raw` | Ingestion `SELECT/INSERT` | Yes | Brand context, request-key dedupe; raw-retention policy | ADDED AS CONTRACT, NOT INGESTION |
| `scr_metric_snapshots` -> `metric_snapshots` | Performance / `selena_performance` | Ingestion `INSERT`; analytics/web read | Yes | Brand context; metrics retention policy | RETAINED AS CONTRACT, NOT NORMALIZATION |
| `scr_tracking_events` -> `tracking_events` | Performance / `selena_performance` | Ingestion `INSERT`; analytics read | Yes | Brand context; privacy/attribution retention policy | RETAINED AS CONTRACT, NOT ATTRIBUTION |

Role split is defined in `0021:6-56,817-902`: `selena_schema_owner`/`selena_migrator`, `selena_web_runtime`, `selena_registry_worker_runtime`, `selena_gateway_runtime`, `selena_trigger_runtime`, `selena_ingestion_runtime`, `selena_analytics_runtime`, `selena_scanner_runtime`, and `selena_backup_restore`. All ordinary runtime groups are `NOLOGIN NOBYPASSRLS`; Trigger has no database grants; only controlled no-login backup/restore has `BYPASSRLS`. The actual login identities, secret mounts, network policy, Supabase exposed-schema setting, storage bucket policies, and retention configuration remain external work.

Migration `0021` is reauthored clean-install SQL, not a compensating migration. Its final checksum was recorded and validated in disposable PostgreSQL only; it has not been authorized or executed in staging/production.

### E0-E8 execution order

| Step | Status | Depends on | Deliverable/gate |
|---|---|---|---|
| E0: freeze external side effects and audit repository/OSS | PASS | None | No migration/deploy/publication; Node 24 validation; ADR and matrix evidence. |
| E1: obtain owner decisions | PASS | E0 | Trigger.dev Cloud, Supabase staging, Postiz Cloud no-publish spike, and LinkedIn Page pilot are approved. No legal/VPC/self-host request is opened. |
| E2: reauthor 0021 and final Drizzle schema/roles | PASS (disposable) | E1, ADR-002/003/004 review | Clean Drizzle `0000…0021`, recorded SHA-256, `34/34` pgTAP, upgrade fixture and restore drill pass on Supabase PostgreSQL 17.6.1.143. Staging still needs separately authorized execution. |
| E3: create approved staging projects and identities | BLOCKED | E2 disposable DB proof and explicit external authorization | Supabase staging project, Trigger project, isolated Selena Systems Postiz Cloud organization, private storage/scanner design, and later role/secret namespaces. |
| E4: implement/deploy Release Gateway | BLOCKED | E2, E3 | Separate Gateway API/worker, KMS signing, nonce/idempotency, allowlist, kill switch, audit, health and contract tests. |
| E5: implement Trigger durable workflow and outbox consumer | BLOCKED | E3, E4 | Queues, retry classifications, approval wait, cancellation, ten-delivery idempotency and reconciliation. |
| E6: connect real LinkedIn staging channel via Postiz Cloud | BLOCKED | E3, E4, ADR-005 owner actions | Re-verify callback path, controlled OAuth, one allowed integration ID, Postiz adapter, timeout/reconciliation, and direct-access denial evidence. |
| E7: implement storage/scanning and platform ingestion/attribution | BLOCKED | E2, E3, E6 | Immutable originals/derivatives, byte hashing/scanning, raw snapshots, normalize/DQ, redirect/lead path. |
| E8: execute staging vertical-slice and resilience/restore drills | BLOCKED | E4-E7 | All negative tests, cross-brand DB tests, recovery, backup restore and one observed staging publication-to-lead cycle. |

## Phase 0-4 requirements

| Phase / requirement | Status | Evidence: exact file:line | Test / command | Remaining work |
|---|---|---|---|---|
| P0: audit Payload/Trigger/Postiz | PASS_WITH_EXTERNAL_SETUP | `docs/control-room/phase-0/ADR-001_TRIGGER_RUNTIME.md`; `ADR-003_PAYLOAD_INTEGRATION.md`; `ADR-004_POSTIZ_DEPLOYMENT_AND_LICENSE.md`; existing pg-boss at `apps/worker/src/index.ts:37-75` | Source/lockfile review; prior official vendor documentation review | Payload rationale, Postiz Cloud/self-host decision, and no-publish acceptance are explicit. The controlled Cloud spike remains external and no runtime integration exists. |
| P0: LinkedIn OAuth/post/metrics spike | BLOCKED | No implementation | None | Owned LinkedIn account, approved scopes and isolated staging account. |
| P0: repository threat model | PARTIAL | Security scan threat model in isolated scan artifacts; repository `SECURITY.md` is generic only | Codex Security diff scan | Persist product threat model/ADR and review it with owner/security. |
| P0: license/hosting/data-retention ADRs | PASS_WITH_EXTERNAL_SETUP | ADR-001..005 and `OPEN_SOURCE_COMPONENT_MATRIX.md` in `docs/control-room/phase-0/` | `rg -n 'Status:|User actions required' docs/control-room/phase-0` | Owner decisions and controlled Cloud spike. AGPL/legal/VPC action is deferred unless the Cloud spike fails. |
| P0: Brand Pack / policy v1 | MISSING | `policyVersion` is an arbitrary client string in `apps/web/src/server/selena-control-room.ts:310` | Typecheck only | Versioned policy bundle, claims/evidence contract and owner approval. |
| P0 architecture gate: no unknown blocker for one channel | PASS_WITH_EXTERNAL_SETUP | ADR-002 through ADR-005, matrix, and this report | ADR consistency review | Remaining Phase 0 external blockers are the approved staging projects and controlled OAuth/Cloud contract spike; this is not a completed publication/metrics vertical slice. |
| P1: Auth/RBAC | PARTIAL | Better Auth context `apps/web/src/lib/selena-auth-context.ts:26-45`; verified transaction wrapper `apps/web/src/server/selena-control-room.ts:56-73`; role/RLS SQL `0021` | Disposable pgTAP `34/34`; restore RLS smoke | Provision distinct staging login identities and add MFA/step-up. |
| P1: Content Registry contracts | PARTIAL | Custom private-schema tables `packages/lib/src/db/schema.ts`; Payload deferred in ADR-003 | Clean migration, pgTAP and restore drill passed | Implement claims/evidence/rights/storage/scanning and re-evaluate Payload after first brand. |
| P1: versioned content, claims and evidence | PARTIAL | Version model `packages/lib/src/db/schema.ts:956`; create functions currently write empty claims/evidence at `apps/web/src/server/selena-control-room.ts:321` | lib hash test `:32` | Claims/evidence editor, validation, lifecycle/status and evidence provenance. |
| P1: assets, rights, consent | PARTIAL | Registry `packages/lib/src/db/schema.ts:983`; quarantine `apps/web/src/server/selena-control-room.ts:519` | lib test `:57`, `:69` | Real upload/object verification/scanner/rights workflow. |
| P1: private storage | MISSING | Contract fields only at `packages/lib/src/db/schema.ts:1004-1036` | Source review | Private bucket, immutable originals, derivatives, signed URLs, EXIF policy. |
| P1: human approval / revocation | PARTIAL | Approval handler `apps/web/src/server/selena-control-room.ts`; DB predicate `0021`; pgTAP denies service approval and expired rights | Disposable pgTAP passed; no server/DB HTTP integration | Step-up/MFA, approval replay control, reject UX and staging integration test. |
| P1: audit | PARTIAL | Lock/hash chain `apps/web/src/server/selena-control-room.ts`; immutable trigger `0021` | Disposable immutable-trigger test and restore of synthetic audit hash passed | Concurrent server transaction test and staging/PITR evidence. |
| P1: basic Control Room UI | PARTIAL | Route `apps/web/src/routes/_authed/app/$brand/control-room.tsx:206` | web build | Role-based E2E, approval diff/evidence and real data sources. |
| P1 gate: immutable approved version and RLS/ACL baseline | PASS (disposable) | `FORCE RLS`, grants and append-only triggers `0021`; pgTAP source `db/tests/0021_selena_control_room.pgtap.sql` | Clean chain + `34/34` pgTAP + restore RLS smoke | Obtain separately authorized staging evidence. |
| P2: transactional outbox | PARTIAL | Server-owned transaction writes `release_intents`, `outbox_events` and audit atomically (`apps/web/src/server/selena-control-room.ts:711-903`); schema/migration provide idempotency and worker lease fields. | Tables migrated and visible in pgTAP; no consumer | Implement a separate consumer/workflow with leases, retries, cancellation, reconciliation and operational monitoring. |
| P2: Trigger durable workflow | MISSING | Existing pg-boss only `apps/worker/src/index.ts:42` | Source review | Trigger.dev tasks/queues/retry/idempotency/wait/cancel/reconciliation. |
| P2: manifest and Gateway | MISSING | No web/lib signer or dispatch surface; UI declares Gateway absent `apps/web/src/routes/_authed/app/$brand/control-room.tsx:577-582`; design in `docs/control-room/phase-0/RELEASE_GATEWAY_SERVICE_DESIGN.md` | Targeted source scan | Deploy separate service with private ingress, asymmetric/KMS signing, verification and reconciliation endpoints. |
| P2: Postiz Cloud adapter | BLOCKED_CONTRACT_SPIKE | No Postiz client/config | `rg -l -i 'postiz' ...` | Approve and complete no-publish Cloud spike, then implement Gateway-only credential/allowlist/network controls. Self-host/legal work only if the spike fails. |
| P2: idempotency / nonce | PARTIAL | Release-intent/outbox unique keys plus legacy reservation nonce uniqueness (`0021`; `packages/lib/src/selena-control-room.ts`); replay/idempotency pgTAP source `db/tests/0021_selena_control_room.pgtap.sql:148-209` | Disposable pgTAP passed replay and ten-reservation uniqueness | Implement Gateway and run 10-delivery/replay/concurrency tests. |
| P2: reconciliation and kill switches | PARTIAL | Pure classification `packages/lib/src/selena-control-room.ts:138`; kill-switch state setter `apps/web/src/server/selena-control-room.ts:717-795` | lib tests `:113`, `:130` | Gateway consumer, provider poller, incident creation and cancellation integration tests. |
| P2 gate: first staging/prod post only through Gateway | BLOCKED | Gateway and Postiz do not exist | None | Complete a staging vertical slice; production is out of scope. |
| P3: redirect/UTM | MISSING | No Selena redirect endpoint | Source review | Controlled redirect domain, token, privacy/consent and visit event. |
| P3: platform adapter + dlt | MISSING | No adapter/dlt dependency/source | Source/dependency review | Implement one LinkedIn adapter and dlt/raw contract after OAuth spike. |
| P3: raw, normalized, DQ | PARTIAL | Raw/metric contracts `packages/lib/src/db/schema.ts:1267-1362` | Source review | Ingestion adapter, checkpoints, normalization, schema drift/type quarantine. |
| P3: lead event / deterministic attribution | PARTIAL | Tracking event schema `packages/lib/src/db/schema.ts:1258` | None | First-party collector, duplicate key, attribution classes and 30-day window. |
| P3: SQL views / Performance UI | PARTIAL | Read-only Performance table `apps/web/src/routes/_authed/app/$brand/control-room.tsx:699` | web build | Defined metrics/current-vs-delta semantics, lineage, quality and views. |
| P3 gate: publication to visit to lead | BLOCKED | No publication, redirect or lead processing | None | One isolated staging vertical cycle. |
| P4: negative tests | PARTIAL | Pure tests plus 34-case disposable pgTAP source `packages/lib/src/db/tests/0021_selena_control_room.pgtap.sql` | Disposable `34/34` pgTAP passed | Gateway, workflow, OAuth, webhook and storage test suites. |
| P4: OAuth/replay/ambiguous drills | MISSING | Only pure ambiguous classifier `packages/lib/src/selena-control-room.ts:138` | lib test `:130` | Real provider drill, nonce store/consume, webhook verification and reconciliation. |
| P4: monitoring / incidents | MISSING | Incident table `packages/lib/src/db/schema.ts:1191`, no producer/alerts | Source review | Runbooks, alert rules, on-call and incident consumer. |
| P4: backups / restore | PARTIAL | Hash fields/trigger plus scoped custom-format backup | Clean disposable restore preserved 1 content hash, 1 asset hash, 2 manifest hashes and 1 audit hash; RLS smoke passed | Supabase PITR/backups, object-storage versioning and staging restore proof. |
| P4 gate: all Go/No-Go checks | MISSING | Many AC statuses below are missing/blocked | This report | Finish all P0-P4 blocked items and run a full vertical staging cycle. |

## Acceptance tests AC-001..AC-032

| AC | Status | Evidence: exact file:line | Test / verification command | Remaining requirement |
|---|---|---|---|---|
| AC-001 no human approval blocks | PARTIAL | Gate `packages/lib/src/selena-control-room.ts:116`; test `packages/lib/src/selena-control-room.test.ts:69` | `pnpm --filter @workspace/lib test` | Gateway must independently reject and prove Postiz was not called. |
| AC-002 one changed character invalidates approval | PARTIAL | Content hash `packages/lib/src/selena-control-room.ts:70`; test `test.ts:32` | lib test | Migrated immutable record and Gateway E2E mismatch test. |
| AC-003 replaced asset bytes block | PARTIAL | Asset bundle hash `packages/lib/src/selena-control-room.ts:88`; test `test.ts:78` | lib test | Server-side byte hash/object-version verification, not supplied metadata. |
| AC-004 wrong/foreign account blocks | PARTIAL | Account binding `packages/lib/src/selena-control-room.ts:96`; test `test.ts:101`; server organization-constrained brand lookup `apps/web/src/server/selena-control-room.ts:44-51` | lib test | RLS/brand membership and Gateway allowlist integration test. |
| AC-005 expired evidence/rights/consent block | PARTIAL | Gate `packages/lib/src/selena-control-room.ts:126`; tests `test.ts:57`, `:82` | lib test | Gateway-side time check and source-of-truth evidence/rights records. |
| AC-006 service cannot approve | PARTIAL | Human session check `packages/lib/src/selena-control-room.ts`; DB predicate `0021`; pgTAP service impersonation/grant cases `db/tests/0021_selena_control_room.pgtap.sql` | lib test; disposable pgTAP PASS | Server/DB integration evidence and Gateway E2E. |
| AC-007 cross-brand reviewer/editor denied | PARTIAL | Verified context/RLS source `0021`; pgTAP `SELECT/INSERT/UPDATE/DELETE` cases `db/tests/0021_selena_control_room.pgtap.sql` | Disposable pgTAP PASS | Full RBAC E2E and staging evidence. |
| AC-008 approval callback/token replay | MISSING | No callback/token table or replay key | None | Canonical approval request ID, unique decision and replay E2E. |
| AC-009 Trigger delivers release 10 times | BLOCKED | Outbox unique intent/event contract and disposable uniqueness assertion exist, but no Trigger task or consumer | `packages/lib/src/db/tests/0021_selena_control_room.pgtap.sql` | Durable workflow plus staging x10 delivery test. |
| AC-010 pre-Postiz failure safe retry | MISSING | No dispatcher/attempt model | None | Attempt state machine, classified retry and test. |
| AC-011 possible Postiz timeout reconciles | PARTIAL | Classifier `packages/lib/src/selena-control-room.ts:138`; test `test.ts:130` | lib test | Real Gateway request state, poll/reconcile and no-blind-retry E2E. |
| AC-012 revoked approval during wait cancels | PARTIAL | Revocation appends an immutable `REVOKED` record `apps/web/src/server/selena-control-room.ts:696-744` | No workflow test | Durable approval wait/cancellation and Gateway dispatcher re-check. |
| AC-013 policy change invalidates pending release | MISSING | Gate compares stored policy only `packages/lib/src/selena-control-room.ts:124` | None | Policy registry/change event and invalidate/grandfather decision. |
| AC-014 direct Postiz access denied | MISSING | No Postiz source files and no network/credential policy. The required future topology is ADR-004. | `rg -l -i 'postiz' apps/web/src apps/worker/src packages/lib/src` | Private network, credential namespace and negative network tests. |
| AC-015 out-of-band publication incident | MISSING | Incident schema only `packages/lib/src/db/schema.ts:1191` | None | Reconciliation poller and incident producer. |
| AC-016 forged/replayed webhook non-authoritative | MISSING | No webhook endpoint | None | Signed webhook verification, replay store and polling confirmation. |
| AC-017 OAuth expiry controlled | MISSING | No OAuth/client/token code | None | Gateway-scoped OAuth store/refresh/redaction tests. |
| AC-018 MIME/oversize/malware rejected/quarantined | PARTIAL | Zod allowlist `apps/web/src/server/selena-control-room.ts`; DB `QUARANTINED` predicate `0021`; pgTAP negative cases `db/tests/0021_selena_control_room.pgtap.sql` | Disposable pgTAP PASS | Byte sniffing, scanner result, private storage and malicious-upload E2E. |
| AC-019 cross-brand DB access denied | PARTIAL | `FORCE RLS` and role policies `0021`; pgTAP cross-brand matrix `db/tests/0021_selena_control_room.pgtap.sql` | Disposable pgTAP PASS; restore no-context smoke PASS | Staging role evidence and full RBAC E2E. |
| AC-020 retried API page preserves one raw observation set | PARTIAL | Raw snapshot request-key uniqueness `schema.ts:1267-1301`; no adapter | Source review | Ingestion adapter/retry test and immutable raw observation proof. |
| AC-021 100 to 130 snapshot math | MISSING | Metrics table only `packages/lib/src/db/schema.ts:1230` | None | Normalized current/delta view and unit test. |
| AC-022 metric revision retained | PARTIAL | `revisionOfId` and append-only metric schema `packages/lib/src/db/schema.ts:1303-1334`; immutable trigger `0021:876-879` | Static check | Ingestion revision handler and tests. |
| AC-023 incomplete pagination holds checkpoint | MISSING | No adapter/checkpoint | None | Pagination contract and mart protection test. |
| AC-024 new API field retained/drift alert | MISSING | No raw schema/DQ | None | Raw payload retention and drift alert. |
| AC-025 type change quarantines batch | MISSING | No normalizer/DQ | None | Schema contract/quarantine test. |
| AC-026 duplicate lead event one first-party event | MISSING | Tracking schema lacks dedupe key `packages/lib/src/db/schema.ts:1258` | None | Collector unique event ID and E2E. |
| AC-027 tracked direct attribution | MISSING | No redirect/session/lead processor | None | Deterministic attribution pipeline and test. |
| AC-028 unattributed lead labeled | MISSING | No attribution processor | None | Explicit UNATTRIBUTED rule and test. |
| AC-029 no modeled attribution | MISSING | No attribution implementation | None | Enforced enum/output contract and test. |
| AC-030 dashboard cutoff/definition/quality/lineage | PARTIAL | Snapshot columns `packages/lib/src/db/schema.ts:1303-1334`; UI display `apps/web/src/routes/_authed/app/$brand/control-room.tsx:699` | web build | Source lineage/definition values from real ingest, DQ and dashboard E2E. |
| AC-031 kill switch fails closed | PARTIAL | Pure gate `packages/lib/src/selena-control-room.ts:117`; server can set kill-switch state `apps/web/src/server/selena-control-room.ts:717-795`; test `test.ts:113` | lib test | Gateway/workflow re-check and staging test before Postiz call. |
| AC-032 restore verifies hashes/manifests/assets/audit | PARTIAL | Append-only audit/manifest triggers `0021`; disposable backup included synthetic hash-bearing fixtures | Clean restore preserved 1 content hash, 1 asset hash, 2 manifest hashes and 1 audit hash; 16 private tables remained `FORCE RLS` | Provider backups, storage versioning and staging/PITR proof. |

## Negative test matrix

| Required negative case | Current result |
|---|---|
| One character after approval | PARTIAL: pure hash/gate test at `packages/lib/src/selena-control-room.test.ts:32`; no DB/Gateway E2E. |
| Wrong brand/account | PARTIAL: pure binding plus disposable pgTAP brand DML cases; no Gateway account allowlist integration. |
| Expired evidence, rights, consent | PARTIAL: pure gate tests and migrated approval predicate; pgTAP rejects expired rights; no authoritative storage/provider. |
| Malware scan not PASSED | PARTIAL: DB predicate and disposable pgTAP reject a quarantined asset; no malware scanner. |
| Kill switch active | PARTIAL: unit branch at `test.ts:113`; no dispatcher/Gateway test. |
| Same release 10 times | PARTIAL/BLOCKED: unique reservation plus release-intent/outbox keys exist and disposable pgTAP asserts reservation idempotency; no Trigger consumer or end-to-end delivery. |
| Replay nonce | PARTIAL: nonce uniqueness and disposable pgTAP replay case; no Gateway atomic consumption test. |
| Timeout after possible Postiz acceptance | PARTIAL: pure classifier at `test.ts:130`; no provider reconciliation. |
| Cross-brand database access | PARTIAL: `34/34` disposable pgTAP verifies cross-brand read/write denial and restore smoke verifies no-context denial; no staging evidence. |
| Service identity human approval | PARTIAL: pure and pgTAP impersonation source exist; no HTTP/server integration run. |
| Direct Postiz bypass Gateway | MISSING: source absence check only; no network/credential denial test. |

## Required from user, in order

No credential value is required, requested, or to be created now. Future Gateway/Postiz material must never appear in Control Room, browser, agent, worker, or Trigger runtime.

### A. Decisions recorded

1. Trigger.dev Cloud: APPROVED.
2. Supabase staging: APPROVED.
3. Postiz Cloud isolated one-brand no-publish contract spike: APPROVED, but execution remains blocked until an implemented Gateway and explicit external authorization.
4. LinkedIn organization Page pilot: APPROVED.

### B. Accounts/projects to create only after disposable DB proof and explicit external authorization

1. A Supabase staging project with an owner, region, retention/PITR decision, private-schema Data API exclusion, and private-storage plan.
2. A Trigger.dev Cloud staging project.
3. A single isolated Selena Systems Postiz Cloud organization.
4. A staging LinkedIn organization Page and Developer application only after the Postiz origin/version and corrected callback path have been re-verified.

### C. Secrets created only after integration code exists

The following are intentionally absent and must not be requested now: Gateway client ID/private key, Gateway audience, Postiz credential, LinkedIn client secret, database role credentials, storage credential, scanner credential, webhook key, or KMS key reference. Once the relevant service and secret-holder configuration have code review, create each value directly in its designated secret namespace, never in chat or git.

Non-secret runtime configuration such as APP_URL/VITE_APP_URL and DEPLOYMENT_MODE remains deployment-specific. A disposable PostgreSQL connection is needed only for the next local DB test; `DATABASE_URL` for staging is needed only after an explicit migration authorization. SENTRY_AUTH_TOKEN remains optional build observability and is not a Phase 0 decision.

## Verification results

All Phase 0 follow-up commands below used the repository `.nvmrc` value through local NVM Node `v24.18.0`, without changing the global Node selection.

| Command | Result |
|---|---|
| `PATH=/Users/msnigmatullaeva/.nvm/versions/node/v24.18.0/bin:$PATH pnpm --filter @workspace/lib check-types` | PASS after final changes. |
| `PATH=/Users/msnigmatullaeva/.nvm/versions/node/v24.18.0/bin:$PATH pnpm --filter @workspace/web check-types` | PASS after final changes. |
| `PATH=/Users/msnigmatullaeva/.nvm/versions/node/v24.18.0/bin:$PATH pnpm --filter @workspace/lib test` | PASS after final changes: 47 files, 555 tests. |
| `PATH=/Users/msnigmatullaeva/.nvm/versions/node/v24.18.0/bin:$PATH pnpm --filter @workspace/web exec biome lint src/server/selena-control-room.ts src/routes/_authed/app/'$brand'/control-room.tsx src/components/app-sidebar.tsx` | PASS after final changes. |
| `PATH=/Users/msnigmatullaeva/.nvm/versions/node/v24.18.0/bin:$PATH pnpm --filter @workspace/web build` | PASS after final changes. Warnings: Sentry auth token absent for release/source-map upload; client chunk exceeds 500 kB. |
| `PATH=/Users/msnigmatullaeva/.nvm/versions/node/v24.18.0/bin:$PATH pnpm --filter @workspace/lib exec drizzle-kit check` | PASS static migration validation. It did not connect to or migrate a database. |
| `git diff --check` | PASS. |
| Current-diff secret scan | PASS: final read-only pattern scan across every tracked/untracked changed file returned no matches and printed no values. |
| `PATH=/Users/msnigmatullaeva/.nvm/versions/node/v24.18.0/bin:$PATH pnpm --filter @workspace/web lint` | FAIL: 33 existing errors, 133 warnings in unrelated `.storybook`, `scripts`, `src/components/base-chart*`, `citations-display.tsx`, SVG assets and config files. Scoped Node 24 lint proves no errors or warnings in changed Control Room files; no implementation-introduced lint error was observed. |
| Disposable clean migration | `drizzle-kit migrate` against a new Supabase PostgreSQL `17.6.1.143` database: PASS; all journal entries `0000…0021` applied, with 22 recorded rows. |
| Migration checksum and rerun | PASS: database record `id=22` equals final `0021` SHA-256 `88c3030c9c85b000b2ac8c07fe75031d0da5eef24afcccb182cdb4571999e5c2`; rerun retained 22 recorded rows. |
| Disposable pgTAP | PASS: `CREATE EXTENSION pgtap` then `packages/lib/src/db/tests/0021_selena_control_room.pgtap.sql` returned `1..34`, `34/34`, `finish` success. |
| Pre-0021 upgrade fixture | PASS: applied `0000…0020`, inserted one synthetic organization/member/brand, then applied `0021`; all three tenant records and `selena_registry.content_items` remained present. |
| Disposable backup/restore drill | PASS: scoped custom-format dump restored into a new clean target with `pg_restore --clean --if-exists`; hashes, 16-table `FORCE RLS`, runtime `NOBYPASSRLS`, `anon/authenticated` denial, no account-allowlist insert and no-context runtime read denial passed. |
| `npx --no-install impeccable detect` | NOT RUNNABLE in the prior frontend audit because of local npm-cache permissions; not required for this backend/schema reauthoring and no install or permission change was attempted. |

All final validation commands listed above ran through local NVM Node `v24.18.0`, matching the repository Node 24 requirement. Earlier audit artifacts that used Node 22 are not relied upon for the final validation results.

## Completion and recommendation

**Phase 0 architecture status: PASS_WITH_EXTERNAL_SETUP.** Payload is correctly deferred rather than declared incompatible; Postiz Cloud versus self-hosted selection is conditional and corrected; the LinkedIn callback candidate is corrected; the Better Auth/RLS identity model and pgTAP plan are specified; and the 0021 reauthoring plan is defined. This status means the architecture decision gate is complete. It does **not** mean the Postiz/LinkedIn spike, RLS, Gateway, or a vertical slice is complete.

**Evidence-complete MVP progress: approximately 28%.** This is a conservative engineering estimate, not a specification metric. Database/RLS/restore controls now have disposable evidence, but no AC is PASS end-to-end and no external vertical slice has run.

**Migration verdict: DISPOSABLE_DB_PASS; STAGING NOT AUTHORIZED.** Final `0021` checksum, clean full-chain migration, migration rerun, `34/34` pgTAP, pre-0021 upgrade fixture and clean restore drill passed on disposable Supabase PostgreSQL `17.6.1.143`. This is evidence for the migration source, not authorization to touch staging.

**Production migration and real publication remain prohibited by:**

- no completed Postiz Cloud contract spike, isolated organization, LinkedIn Page/Developer/OAuth/metrics evidence, or real adapter;
- no deployable Release Gateway/private network/credential isolation or one-integration allowlist enforcement;
- no Trigger durable workflow, outbox consumer, retry/cancel/replay/ambiguous-result implementation;
- no separately provisioned staging database login identities, grants, Data API exposure control or executed staging cross-brand evidence;
- no private storage, immutable originals, server-side hashing or malware scanner;
- no ingestion/raw snapshots/normalization/DQ/attribution path;
- no provider backup/PITR or object-storage restore configuration, operations runbooks, monitoring or on-call evidence;
- no complete staging vertical cycle from approved content through a confirmed platform object, tracked visit and lead.

**One next implementation step without external side effects:** add a dedicated release-intent/outbox DB test that proves one atomic intent/event pair under repeated requests, then implement the approved Trigger.dev workflow only after its project and secret boundary exist. Do not use staging, production, Postiz, LinkedIn, or any external credential for that step.
