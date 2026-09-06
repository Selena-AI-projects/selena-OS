# Content OS: YouTube Stage 1 technical specification
**Status:** implementation-ready draft
**Date:** 2026-09-01
**Repository:** `parkourcafe/selena-OS`
**Baseline:** `main` at `ab50d742695ff8d8bc728efe217502e121869189`
**Video Radar source:** `parkourcafe/video-radar-marketing-tool` at `b589a811a4e1f205a784e5128283f9d227143f32`
**YouTubePro source:** `parkourcafe/youtube-pro` at `63cd9b9c2ad19b9941a763be3d5cfcbd9bc13b25`
**Execution boundary:** local and disposable infrastructure only; no external publication
## 1. Decision
Stage 1 is implemented **inside this repository**. The existing Control Room remains the governance core and continues to use the canonical tenancy path:
```text
Better Auth organization -> public.brands -> private Control Room schemas
```
The Content OS user surface uses a neutral product name. Existing internal names such as `selena_registry`, migration history, database roles and server modules are compatibility details and are not renamed in Stage 1.
This specification supersedes the earlier recommendation to extract Control Room into a separate repository.
## 2. Verified baseline
The following are source-level facts on the stated baseline:
- Control Room is an authenticated brand-scoped route at `/app/$brand/control-room`.
- `public.brands.organization_id` is the Control Room tenancy key.
- AI Visibility has a separate `sv_projects` model. Stage 1 does not merge it with `brands`.
- Content versions are immutable and hash-bound.
- Existing release approvals are bound to a `channel_account_id` and are publication approvals, not general editorial approvals.
- Web-created channel accounts are restricted to the non-allowlisted `linkedin_page_dry_run` fixture.
- The release path has no active provider submission.
- The current strict gap report records `0/12` requirements complete because no full deployed/provider vertical cycle has passed.
- At the initial audit baseline the database chain ended at migration `0031`.
  The reconciled staging line now owns migrations `0032` through `0036`, and
  Slice 1 adds project profiles and draft channels as migration `0037`.
## 3. Product outcome
For each brand, an authenticated user can:
1. create and owner-confirm a versioned project content profile;
2. register YouTube as a draft-only content target without OAuth;
3. import or run brand-scoped Video Radar research;
4. review evidence-bearing opportunities;
5. generate six ideas and select one;
6. generate and revise a YouTube script;
7. generate or attach a thumbnail;
8. save every accepted change as an immutable content version;
9. give a human editorial approval;
10. see clearly that publication is unavailable in Stage 1.
The completion path is:
```text
Profile -> Research -> Opportunity -> Ideas -> Script -> Thumbnail
        -> Editorial review -> Ready for publishing setup
```
No Stage 1 action may create a YouTube publication attempt, release outbox event or external post.
## 4. Non-goals
Stage 1 does not include:
- YouTube OAuth;
- YouTube upload, scheduling or Analytics ingestion;
- Postiz or Blotato selection for YouTube;
- changes to `sv_projects` or AI Visibility measurement contracts;
- production or shared staging migrations;
- automatic provider calls triggered by page load, profile save or scheduled background activity;
- a second authentication system;
- copying the Video Radar or YouTubePro frontend;
- renaming historical migrations, schemas, roles or internal audit actions;
- claiming that source, disposable database or local-browser evidence is hosted acceptance.
## 5. Product naming and documentation
`Content OS` is a working label, not a final brand decision.
Before user-interface implementation, update `PRODUCT.md` and `DESIGN.md` so they describe the repository as a shared authenticated product shell with two distinct surfaces:
- AI Visibility, which retains its existing product commitments;
- Content OS, a neutral portfolio content workflow.
Content OS routes must not render `Selena`, `Selena Systems` or `Content Control Room` as the product name. Selena may remain visible only as company/account attribution in the shared shell or on the separate AI Visibility surface. Internal code identifiers and `/api/v1/selena/*` compatibility routes may remain during Stage 1.
Define the visible name once, for example in `apps/web/src/lib/content-product.ts`, so a final rename changes one interface rather than scattered strings.
## 6. Tenancy decision
### Canonical identity
`brandId` is the canonical Content OS project identifier.
Every new row contains both:
- `organization_id`, controlled by the authenticated context;
- `brand_id`, validated as a member of that organization.
All operations execute through `selena_registry.set_request_context(...)` and existing RLS helpers. A caller never supplies a trusted organization ID.
### AI Visibility mapping
Stage 1 does not add a foreign key from `brands` to `sv_projects` and does not infer a match by name or URL.
If a future workflow needs AI Visibility evidence, introduce an explicit owner-confirmed mapping table in a later migration:
```text
brand_id <-> sv_project_id
```
No such mapping is needed for the Stage 1 acceptance path.
## 7. Module design
Stage 1 introduces three deep modules. Their interfaces are the caller and test surfaces.
### 7.1 Project profile module
Responsibilities hidden behind the module:
- version allocation;
- normalization and hash calculation;
- fact-state validation;
- owner confirmation and revocation;
- RLS context and append-only audit;
- resolving the latest confirmed profile.
Suggested interface:
```ts
export interface ContentProjectProfileModule {
  getCurrent(input: BrandScope): Promise<CurrentProfile | null>;
  createVersion(input: CreateProfileVersionInput): Promise<ProfileVersionRef>;
  decide(input: ConfirmProfileVersionInput): Promise<ProfileDecisionRef>;
}
```
The interface does not expose SQL, Drizzle rows or audit-chain implementation details.
### 7.2 Research module
Responsibilities hidden behind the module:
- resolving the confirmed project profile;
- invoking an injected research adapter;
- validating provenance and source identifiers;
- deduplicating sources and runs;
- persisting scores, failures and opportunities;
- appending audit events;
- returning a brand-scoped result.
Suggested external interface:
```ts
export interface ContentResearchModule {
  run(input: ResearchRunInput): Promise<ResearchRunResult>;
  decideOpportunity(input: OpportunityDecisionInput): Promise<OpportunityDecision>;
}
```
The adapter seam is internal to the module:
```ts
export interface ResearchAdapter {
  discover(input: ResearchAdapterInput): Promise<ResearchBundle>;
}
```
Required adapters:
- `VideoRadarAdapter` for the ported implementation;
- `FixtureResearchAdapter` for deterministic tests and zero-network local acceptance.
The existing Video Radar `runRadar(options)` function already accepts its store and providers. Preserve that depth. Replace its global JSON project registry with `projects` supplied in `RunOptions`; construct exactly one `RadarProject` from the current brand and confirmed profile.
Instantiate its store as brand-scoped:
```ts
createPostgresRadarStore({ context, brandId })
```
The resulting adapter must add `organization_id` and `brand_id` internally. `RadarStore` callers do not receive a way to override them.
### 7.3 Creation module
Responsibilities hidden behind the module:
- explicit provider-call authorization;
- profile/research snapshot resolution;
- input and output validation;
- provider error normalization;
- generation-run persistence;
- conversion of a selected result into an immutable content version;
- audit events and cost/call accounting.
Suggested external interface:
```ts
export interface ContentCreationModule {
  generate(input: CreationRequest): Promise<CreationResult>;
}
```
`CreationRequest` is a discriminated union for `IDEAS`, `SCRIPT`, `SCRIPT_REVISION`, `THUMBNAIL_SUGGESTIONS` and `THUMBNAIL`.
The provider seam is internal:
```ts
export interface CreationAdapter {
  generate(input: CreationAdapterInput): Promise<ValidatedCreationOutput>;
}
```
Required adapters:
- `YouTubeProGeminiAdapter`, ported from YouTubePro domain/server code;
- `FixtureCreationAdapter`, used by unit, integration and default local acceptance tests.
Do not port YouTubePro's global `configureGeminiApiKey` state. Inject a server-only provider client into the adapter. Credentials never enter an input snapshot, job payload, audit event or browser response.
## 8. Portable source boundaries
### Video Radar
Port domain logic and tests from:
- `lib/video-radar/contracts.ts`;
- scoring, baseline, outlier, relevance and velocity modules;
- `run.ts`;
- analysis schemas and anti-copy opportunity enforcement;
- provider interfaces.
Do not port:
- Next routes or page UI;
- operator-token authentication;
- the Supabase adapter;
- the in-memory store as a production adapter;
- JSON project registries;
- environment-loading code.
The Video Radar repository currently has no license file. Preserve repository/commit provenance and confirm code-transfer authorization in the implementation PR description before copying source.
### YouTubePro
Port domain and provider-facing logic from:
- `shared/evidence-contracts.ts`;
- the Research schemas in `shared/schema.ts`;
- script and regeneration contracts;
- thumbnail contracts and validation;
- provider error normalization;
- the tested Gemini parsing/generation implementation needed by the adapter.
Do not port:
- Express routes;
- Wouter pages;
- local Settings or API-key persistence;
- localStorage workflow state;
- the retired login/database/session compatibility code;
- React 18 UI components.
Preserve the Apache-2.0 attribution required by the source repository.
### Target location
Use neutral domain packages rather than adding more behavior to the 1,000-line route or the existing `selena-control-room.ts` server file:
```text
packages/content-workflow/
  src/profile/
  src/research/
  src/creation/
  src/content-document/
packages/lib/src/
  db/schema.ts
  content-workflow-repositories.ts
  content-workflow-projection.ts
apps/web/src/server/
  content-profile.ts
  content-research.ts
  content-creation.ts
  content-review.ts
```
`@workspace/content-workflow` contains pure contracts and behavior. Database and authenticated request adapters stay in `@workspace/lib` and `apps/web`.
## 9. Database plan
Historical migrations are immutable. On the reconciled staging line, add new
migrations after `0037` and pair every security-sensitive migration with a
pgTAP suite.

### 9.1 Migration 0037: project profiles and draft channels
Add `selena_registry.brand_content_profile_versions`:
| Column | Rule |
|---|---|
| `id` | UUID primary key |
| `organization_id`, `brand_id` | required tenant scope |
| `version` | monotonically increasing per brand |
| `languages` | non-empty BCP-47 strings |
| `audience` | validated JSON object |
| `voice` | validated JSON object; traits, examples and exclusions |
| `cta_rules` | validated JSON array |
| `visual_rules` | validated JSON object |
| `claim_rules` | validated JSON object |
| `facts` | validated fact records |
| `source_refs` | validated source references |
| `profile_hash` | lowercase SHA-256 |
| `immutable` | always true |
| `created_by`, `created_at` | audit identity and timestamp |
Fact records use explicit states:
```ts
type ProfileFact = {
  id: string;
  statement: string;
  state: "VERIFIED" | "UNKNOWN" | "DISPUTED" | "PROHIBITED";
  sourceRefs: string[];
  verifiedAt?: string;
  expiresAt?: string;
};
```
Only `VERIFIED` facts may be offered to generation as factual claims. `UNKNOWN`, `DISPUTED` and `PROHIBITED` remain visible constraints and may not be silently upgraded by an AI result.
Add `selena_registry.brand_content_profile_decisions`:
- append-only;
- `CONFIRMED` or `REVOKED`;
- bound to `profile_hash`;
- interactive-owner session only;
- reason required for revocation.
Add `selena_registry.content_channels`:
| Column | Stage 1 value |
|---|---|
| `platform` | `youtube` |
| `display_name` | owner-readable label |
| `channel_url` | optional validated YouTube URL |
| `languages` | project-selected languages |
| `publication_mode` | always `DRAFT_ONLY` |
| `provider_account_id` | absent in Stage 1 |
This table is not `channel_accounts`. Creating it grants no release authority and stores no OAuth credential.
### 9.2 Migration 0038: research registry
Add the following brand-scoped RLS tables:
- `selena_registry.research_runs`;
- `selena_registry.research_sources`;
- `selena_registry.research_metric_snapshots`;
- `selena_registry.research_opportunities`;
- `selena_registry.research_opportunity_decisions`.
Required invariants:
- a run references an immutable confirmed profile version;
- the idempotency key is unique within organization and brand;
- a YouTube source is unique on `(brand_id, platform, external_video_id)`;
- metric snapshots are append-only and retain captured time and scoring version;
- opportunities reference source evidence and keep fact requirements;
- decisions are append-only and use `NEW`, `SAVED`, `REJECTED` or `SENT_TO_CREATION`;
- a source from another brand cannot be linked, selected or read;
- raw provider responses are not returned directly to the browser.
Transcripts are private research data. Persist transcript text only when the source/provider permits it and attach provider, language, retrieval time and failure state. Otherwise persist `UNAVAILABLE` or a source reference, not invented text.
### 9.3 Migration 0039: structured content, generation lineage and editorial review
Alter `selena_registry.content_items` with nullable/backward-compatible fields:
- `content_kind`, default `GENERIC_POST` for existing rows;
- `content_channel_id`;
- `workflow_stage`, default `DRAFT`.
Stage 1 adds `YOUTUBE_VIDEO` as a content kind. The target channel must have `publication_mode = DRAFT_ONLY`.
Alter `selena_registry.content_versions` with nullable/backward-compatible fields:
- `format_version`, default `legacy.text/v1` for existing rows;
- `structured_body` JSONB;
- `project_profile_version_id`;
- `research_run_id`;
- `generation_run_id`;
- `hash_version`, default `selena.content/v1` for existing rows.
Do not recalculate or invalidate existing hashes. Introduce `content.workflow/v2` hashing for new structured versions. The V2 hash includes:
- content kind and channel;
- structured document;
- CTA;
- claims and evidence snapshot;
- disclosure;
- policy version;
- project profile version ID and hash;
- research run ID;
- generation run ID when present.
Add `selena_registry.generation_runs`:
- kind, status, provider and model;
- prompt and schema versions;
- input snapshot hash;
- validated output and output hash;
- profile and research lineage;
- requested/actual call counts;
- estimated/actual cost when known;
- normalized error code;
- timestamps and actor.
Provider output is untrusted data until it passes the ported Zod contract. Invalid output is stored only as a sanitized failure record, never as a content version.
Add `selena_registry.editorial_approvals`:
- append-only human decisions;
- interactive-owner session only for `APPROVED`;
- binds content hash, profile hash, evidence hash and asset bundle hash;
- does not contain `channel_account_id`;
- grants no release authority.
Do not alter the meaning of the existing `selena_registry.approvals` table. It remains a publishing approval bound to an actual channel account.
### 9.4 Release fail-closed rule
The release queue and manifest boundary must reject a content version when:
- its content kind is `YOUTUBE_VIDEO`; and
- no allowlisted YouTube `channel_account` and publication adapter exist.
Stage 1 creates neither. Editorial approval must never satisfy the existing release-approval foreign key or release-manifest function.
## 10. Structured YouTube document
Each accepted idea/script revision is stored in `structured_body` using a versioned contract:
```ts
type YouTubeVideoDocumentV1 = {
  schema: "content.youtube-video/v1";
  concept: {
    angle: string;
    hook: string;
    honestPromise: string;
    format: "SHORT" | "LONG_FORM" | "TUTORIAL" | "REVIEW" | "VLOG";
    audience: string;
    discoverySurface: "search" | "browse" | "suggested" | "shorts_feed" | "mixed";
  };
  titles: string[];
  script?: {
    hook: string;
    sections: Array<{
      heading: string;
      purpose: string;
      narration: string;
      evidenceClaimIds: string[];
    }>;
    payoff: string;
    primaryCta: string;
    studioValidation: string;
  };
  thumbnail?: {
    concept: string;
    text: string;
    assetIds: string[];
  };
  evidenceClaimIds: string[];
};
```
The existing `body` column remains populated with a deterministic readable rendering for compatibility and search. `structured_body` is canonical for V2 edits and hashing.
Generation produces exactly six validated idea packages, matching the existing YouTubePro contract. Selecting an idea creates the `content_item` and its first `content_version`; the five unselected ideas remain in the immutable generation-run output.
## 11. Provider-call safety
All external research and generation adapters are disabled by default.
Every live provider call requires:
- an explicit authenticated user action;
- a current confirmed project profile;
- a feature flag for the exact provider;
- a server-side credential resolved outside request/audit payloads;
- a declared maximum call count;
- a cost ceiling or `UNKNOWN_COST_BLOCKED`;
- an idempotency key;
- a durable call ledger entry before dispatch.
No page loader, profile save, navigation event or default scheduler may trigger a provider call.
The default local acceptance suite uses fixture adapters and proves `externalProviderCalls = 0`.
## 12. Web routes and navigation
Keep `/app/$brand/control-room` as the compatibility entry point. Refactor it into a layout and focused child routes rather than extending the current monolithic page.
Proposed routes:
```text
/app/$brand/control-room                 Inbox / workflow summary
/app/$brand/control-room/profile         Project content profile
/app/$brand/control-room/research        Radar runs and sources
/app/$brand/control-room/ideas           Opportunities and six-idea runs
/app/$brand/control-room/scripts         Script editor and immutable history
/app/$brand/control-room/thumbnails      Thumbnail workflow and assets
/app/$brand/control-room/review           Editorial review
/app/$brand/control-room/releases         Existing release state, read-only for YouTube
/app/$brand/control-room/publications     Existing publication state
/app/$brand/control-room/performance      Existing performance state
/app/$brand/control-room/incidents        Existing incidents
/app/$brand/control-room/audit            Existing audit log
```
Navigation groups:
- **Set up:** Project profile;
- **Create:** Research, Ideas, Scripts, Thumbnails;
- **Govern:** Review, Releases, Publications;
- **Observe:** Performance, Incidents, Audit.
The YouTube channel card must state: `Draft-only. No account connected. Publishing is unavailable.`
## 13. Server operations
Suggested authenticated operations:
### Profile
- `getContentProjectProfileFn`;
- `createContentProjectProfileVersionFn`;
- `confirmContentProjectProfileVersionFn`;
- `revokeContentProjectProfileVersionFn`;
- `upsertDraftYouTubeChannelFn`.
### Research
- `startContentResearchRunFn`;
- `importContentResearchBundleFn`;
- `getContentResearchRunFn`;
- `decideContentOpportunityFn`.
### Creation
- `generateContentIdeasFn`;
- `createYouTubeDraftFromIdeaFn`;
- `generateYouTubeScriptFn`;
- `createYouTubeScriptRevisionFn`;
- `generateYouTubeThumbnailFn`.
### Review
- `submitContentVersionForEditorialReviewFn`;
- `approveContentVersionEditoriallyFn`;
- `revokeEditorialApprovalFn`.
Each handler resolves the session context, validates brand access, delegates to a deep module and returns a user-readable result. It does not implement domain rules inline.
Long research and generation runs use the existing worker/pg-boss infrastructure. Job payloads contain opaque IDs only:
```ts
{ runId: string; correlationId: string }
```
Workers re-read canonical state under a brand-scoped database context.
## 14. Asset handling
Generated thumbnails and uploaded reference images use the existing private-storage and scanner path.
Rules:
- never persist base64 image data in `structured_body`, audit metadata or a job payload;
- persist opaque storage references and SHA-256 only;
- keep existing MIME, size, rights, consent and scanner checks;
- an asset must be `CLEAN` before editorial approval binds it;
- if local private storage/scanner is unavailable, the generation run ends as `BLOCKED_STORAGE`; it does not claim that the thumbnail was saved;
- the product must distinguish generated imagery from uploaded source imagery.
## 15. Audit events
Append the following neutral action names to the existing hash-chained audit log:
- `content.profile_version_created`;
- `content.profile_confirmed`;
- `content.profile_revoked`;
- `content.channel_draft_created`;
- `content.research_started`;
- `content.research_completed`;
- `content.research_failed`;
- `content.opportunity_saved`;
- `content.opportunity_rejected`;
- `content.generation_started`;
- `content.generation_completed`;
- `content.generation_failed`;
- `content.version_created`;
- `content.editorial_approved`;
- `content.editorial_approval_revoked`.
Audit metadata contains IDs, hashes, versions, status and normalized error codes. It excludes secrets, full transcripts, prompts, generated image bytes and credentials.
## 16. Delivery slices
### Slice 0: product contract
- update `PRODUCT.md` and `DESIGN.md`;
- add the centralized visible product name;
- add feature flag `CONTENT_OS_STAGE1_ENABLED`, default false outside explicit local/test configuration;
- add neutral navigation shell without provider functionality.
### Slice 1: profile and draft YouTube target
- migration `0037` and pgTAP;
- profile domain module and server adapter;
- profile UI and owner confirmation;
- draft-only YouTube channel card;
- no provider calls.
### Slice 2: research
- migration `0038` and pgTAP;
- port Video Radar core with provenance;
- brand-scoped Postgres store adapter;
- fixture/import mode first;
- research and opportunity UI;
- optional live adapter remains disabled until an explicit provider budget gate exists.
### Slice 3: ideas and scripts
- migration `0039` and pgTAP;
- V2 content hash with V1 compatibility tests;
- port YouTubePro evidence, idea and script contracts;
- fixture creation path;
- optional Gemini adapter behind explicit call authorization;
- immutable idea/script versions and history.
### Slice 4: thumbnails and editorial approval
- port thumbnail contracts;
- integrate private storage/scanner;
- bind clean asset bundle to editorial approval;
- prove that editorial approval cannot create a release intent.
### Slice 5: local vertical acceptance
- run the complete fixture path for one test brand;
- run cross-brand negative tests;
- verify neutral Content OS UI at desktop and 390 px;
- record source, disposable-database and local-browser evidence separately.
## 17. Test plan
### Pure module tests
- project profile normalization and hash stability;
- `UNKNOWN`, `DISPUTED` and `PROHIBITED` facts never enter allowed claim context;
- Video Radar baseline/outlier/velocity/scoring behavior remains compatible;
- anti-copy rejection remains enforced;
- exactly six ideas are required;
- evidence source IDs must belong to the active research snapshot;
- script sections reference only allowed evidence claim IDs;
- V1 content hashes remain unchanged;
- V2 hashes change when profile, research, content, evidence or asset identity changes;
- invalid provider output cannot become a content version.
### Disposable PostgreSQL and pgTAP
- migrations `0000..0039` apply on a clean disposable database;
- new tables have `ENABLE` and `FORCE ROW LEVEL SECURITY`;
- cross-brand SELECT/INSERT/UPDATE/DELETE is denied;
- profile and editorial decisions require an interactive owner;
- profile versions, decisions, research snapshots, content versions and editorial approvals are append-only;
- duplicate run/idempotency keys do not duplicate state;
- foreign-brand profile/source/asset IDs cannot be linked;
- no Stage 1 operation inserts a YouTube `channel_account`;
- no editorial approval can satisfy a release manifest or intent.
### Server integration tests
- member may create drafts but cannot confirm a profile or editorially approve;
- owner can confirm and revoke with an append-only record;
- unconfirmed profile blocks generation;
- missing evidence blocks editorial approval when policy requires evidence;
- fixture research and creation are deterministic;
- live adapters fail closed when flags, cost ceiling or credentials are absent;
- duplicate worker delivery resumes the same run;
- sanitized errors expose correlation IDs without provider payloads.
### Browser acceptance
For a disposable brand:
1. open Content OS without seeing Selena as the content product name;
2. create and confirm a project profile;
3. add a draft-only YouTube target;
4. import fixture Radar research;
5. save one opportunity;
6. generate six fixture ideas;
7. select an idea and create a script;
8. create a new immutable revision;
9. attach a clean thumbnail fixture;
10. owner editorially approves the exact version;
11. Releases shows publishing unavailable;
12. database evidence shows zero YouTube release intents, outbox events and publication attempts.
Repeat route access with a user from another organization and prove denial.
## 18. Definition of done
Stage 1 is complete only when all of the following are true:
- current `PRODUCT.md` and `DESIGN.md` permit the neutral Content OS surface;
- the complete migration chain passes on a clean disposable database;
- all new pgTAP, module, server and browser tests pass;
- a confirmed brand profile is bound to generated content provenance;
- a Research result can become an immutable evidence-bearing YouTube script;
- a clean thumbnail asset can be bound to the exact version;
- an interactive owner can grant editorial approval;
- the UI and database both show that YouTube publishing is unavailable;
- fixture acceptance records `externalProviderCalls = 0`;
- no secret-like values are present in the diff;
- source, disposable database and local browser evidence are reported as separate evidence classes;
- there are no unresolved error-level lint, typecheck, test or build failures on the changed surface.
This does not constitute staging or production acceptance.
## 19. Rollback and containment
- The feature flag hides the new user surface without deleting data.
- New migrations are additive; rollback does not edit historical migrations or drop governance data.
- Live provider adapters remain disabled independently of the UI flag.
- Existing AI Visibility and LinkedIn dry-run paths retain their V1 hashes and schemas.
- Existing release kill switches remain available and unchanged.
- Any failed or ambiguous generation/research run records a terminal or resumable state; it does not silently retry paid work.
## 20. Deferred owner decisions
These decisions do not block fixture-based implementation:
- final product name;
- first real brands after the disposable test brand;
- exact provider budgets and approved live adapters;
- whether production thumbnails use the current storage provider or another private object store;
- Postiz versus Blotato versus a direct YouTube adapter in Stage 3;
- whether AI Visibility evidence will later map to Content OS through an explicit `brand <-> sv_project` link.
Until those decisions are confirmed, the safe defaults are:
- visible name: `Content OS`;
- one disposable test brand;
- no live provider calls;
- no OAuth;
- no publication;
- no inferred `sv_project` relationship.
