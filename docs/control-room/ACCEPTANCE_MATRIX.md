# Slice 1 acceptance matrix

| ID | Requirement | Source | Code/evidence | Status | Gate |
|---|---|---|---|---|---|
| S1-01 | Pure profile contracts, fact states, normalization and stable hash | Stage 1 plan 6.3A | `packages/content-workflow/src/profile/index.ts`; 4 Vitest tests | VERIFIED | none |
| S1-02 | Immutable profile versions and append-only owner decisions | Stage 1 plan 6.3B | clean migration chain through 0032; 44/44 pgTAP; PostgreSQL adapter integration test | VERIFIED (disposable) | staging migration |
| S1-03 | YouTube target is structurally `DRAFT_ONLY` with no account/credential | Stage 1 plan 6.1 | database constraint plus idempotent `ensureDraftYouTube` integration test | VERIFIED (disposable) | staging canary |
| S1-04 | Authenticated member can draft; interactive owner confirms/revokes | Stage 1 plan 6.3C | server handlers, repository role checks and real PostgreSQL adapter test | VERIFIED (adapter) | authenticated browser evidence |
| S1-05 | Child route and profile navigation are fail-closed behind exact `true` flag | Stage 1 plan 6.3D | profile route, sidebar gate, handlers, UI build and Impeccable detect | VERIFIED (local) | staging flag canary |
| S1-06 | No provider calls or publication on profile flow | Technical spec §5/§12 | no provider imports/calls; database test proves zero channel accounts, release intents, outbox events and publication attempts | VERIFIED (disposable) | staging canary |
| S1-07 | Disposable migration and pgTAP suite execute independently | Stage 1 plan 6.4 | fresh PostgreSQL 16 database; 33 migrations; 44/44 pgTAP; independent runner | VERIFIED | none |
| S1-08 | Exact head SHA passes CI, blind review and owner merge | Stage 1 plan 6.4 | local checks and Node 24 Railway-compatible Docker build pass | IN_PROGRESS | GitHub CI, exact-SHA review and merge |
