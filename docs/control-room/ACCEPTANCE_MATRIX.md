# Stage 1 acceptance matrix

Correction note (2026-09-08): research and structured-content migrations are
`0042` and `0043` on disk — older rows below that say `0040`/`0041` predate the
renumbering recorded in DECISION_LOG (2026-09-07).

| ID | Requirement | Source | Code/evidence | Status | Gate |
|---|---|---|---|---|---|
| S1-01 | Pure profile contracts, fact states, normalization and stable hash | Stage 1 plan 6.3A | `packages/content-workflow/src/profile/index.ts`; 4 Vitest tests | VERIFIED | none |
| S1-02 | Immutable profile versions and append-only owner decisions | Stage 1 plan 6.3B | clean combined migration chain through 0037; 44/44 Slice 1 pgTAP; PostgreSQL adapter integration test | VERIFIED (disposable) | staging migration |
| S1-03 | YouTube target is structurally `DRAFT_ONLY` with no account/credential | Stage 1 plan 6.1 | database constraint plus idempotent `ensureDraftYouTube` integration test | VERIFIED (disposable) | staging canary |
| S1-04 | Authenticated member can draft; interactive owner confirms/revokes | Stage 1 plan 6.3C | server handlers, repository role checks and real PostgreSQL adapter test | VERIFIED (adapter) | authenticated browser evidence |
| S1-05 | Child route and profile navigation are fail-closed behind exact `true` flag | Stage 1 plan 6.3D | profile route, sidebar gate, handlers, per-fact evidence-state/source authoring, UI build and Impeccable detect | VERIFIED (local) | staging flag canary and authenticated browser flow |
| S1-06 | No provider calls or publication on profile flow | Technical spec §5/§12 | no provider imports/calls; database test proves zero channel accounts, release intents, outbox events and publication attempts | VERIFIED (disposable) | staging canary |
| S1-07 | Disposable migration and pgTAP suite execute independently | Stage 1 plan 6.4 | fresh PostgreSQL 16 database; 38 migrations; all 15 suites pass 215/215, including Slice 1 at 44/44 | VERIFIED | none |
| S1-08 | Exact head SHA passes CI, blind review and owner merge | Stage 1 plan 6.4 | PR #28 merged into main as `313daa0` with 6 checks passed | VERIFIED | none |
| S2-01 | Research registry, Video Radar port, fixture adapter, brand scoping | Stage 1 plan §7 | PR #31 merged `86a0a633`; migration `0042` + pgTAP plan(68); 28 module tests; research adapter integration test | VERIFIED (disposable) | staging canary |
| S3-01 | Structured content, generation lineage, six-idea/script vertical | Stage 1 plan §8 | PR #32 merged `58daa20f`; migration `0043` + pgTAP plan(70); 24 module tests; creation adapter integration test; V2 hash with V1 untouched | VERIFIED (disposable) | staging canary |
| S4-01 | Editorial decisions on the latest version bind content/profile/evidence/asset hashes, owner-only APPROVED, reasoned refusals, CLEAN-gated bundle, zero release authority | Technical spec §14–§16 | PR #44 merged `07fdc84`; review module + 5 unit tests; editorial integration test in Data Integrity; append-only DB policies from `0043` | VERIFIED (disposable) | authenticated browser evidence |
| S5-01 | Full fixture vertical for one disposable brand with `externalProviderCalls = 0` proven three ways | Stage 1 plan §11 | workflow "Stage 1 Acceptance" run #1 (2026-09-07, Success, 90-day artifact); vertical extended with editorial decisions after Slice 4 | VERIFIED (disposable) | browser-evidence class still open |
