# Recommendation Engine Phase 0–1

## Scope

This implementation extends the existing Selena Visibility module inside `packages/selena-visibility-contracts` and `packages/lib`. It consumes saved Evidence Ledger rows only. It does not create Elmo jobs, call providers, schedule measurements, or access secrets.

## Contracts

- `EvidenceItem`: normalized evidence with tenant, snapshot, access class, source reference, timestamp and immutable metadata.
- `SourceSnapshot`: source identity and content hash for reproducibility.
- `InputManifest`: immutable dataset/rulepack lock; all downstream objects reference it.
- `Finding → Recommendation → ActionPlanTask`: every downstream object carries evidence IDs.
- `validateGrounding`: rejects references absent from the same tenant's evidence set.

The current Phase 0 gateway supports the canonical CSV ledger shape used by Usha. It is deliberately dependency-free and preserves unknown/empty values rather than inferring them.

## API contract

`buildManifest(tenantId, datasetId, evidence, rulepackVersion)` creates the immutable input lock.

`buildActionPlan(tenantId, manifest, evidence)` produces findings, recommendations and tasks from the locked evidence. Cross-tenant rows throw `TENANT_ISOLATION_BLOCKED`.

`validateGrounding(plan, evidence)` returns grounding errors; a non-empty result must prevent publication.

The functions are exported as `@workspace/lib/recommendation-engine`. A transport route can call this pure core without granting it provider or scheduler access.

## Rulepack v1

- `AI-API-MENTION-RATE`: produces a finding when API View mention rate is below 50%.
- `AI-OWNED-CITATION-COVERAGE`: produces a finding when owned citations cover less than 70% of mentioned rows.

Recommendations are deterministic, evidence-linked and use `NOW/NEXT/LATER` priority. Forbidden guarantee/revenue/ranking claims are blocked by the validator.

## Persistence / migration note

The existing `sv_findings` and `sv_recommendations` tables are present in migration `0016_selena_scan_findings_payments.sql`. Phase 0–1 keeps the immutable manifest, source snapshots and task payloads in the pure contract boundary until the application persistence adapter is wired. No migration was added that could alter the running Elmo deployment.

## Test coverage

The golden fixture test covers deterministic manifests, evidence → finding → recommendation → task → verification plan, grounding, tenant isolation and no-data/UNKNOWN behavior. Provider calls and new measurement runs are intentionally absent.
