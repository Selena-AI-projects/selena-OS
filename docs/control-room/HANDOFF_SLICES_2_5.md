# Content OS: handoff for Slices 2–5

**Prepared:** 2026-09-06
**Audience:** a new Claude Code implementation chat and a separate blind reviewer
**Repository:** `parkourcafe/selena-OS`
**Current accepted base:** `313daa0c5812d34f8ab7b977f6cc500fde751869` (`origin/main`)
**Production publishing:** prohibited
**YouTube OAuth / upload / scheduling:** prohibited
**Live or paid research/generation calls:** prohibited until a later explicit owner authorization

This file is the operational handoff. It records verified state and routing; it
does not replace the detailed acceptance criteria in
`docs/control-room/STAGE1_EXECUTION_PLAN.md`.

## 1. Ready-to-paste prompt for the new Claude Code chat

```text
Open the private GitHub repository parkourcafe/selena-OS and read, in full and
in this order: AGENTS.md, PRODUCT.md, DESIGN.md,
docs/control-room/HANDOFF_SLICES_2_5.md,
docs/control-room/STAGE1_EXECUTION_PLAN.md,
docs/control-room/CONTENT_OS_YOUTUBE_STAGE1_TECHNICAL_SPEC.md,
docs/control-room/AUTHORIZATION_MATRIX.md,
docs/control-room/OWNER_GATES.md, and docs/control-room/DEPLOYING.md.

Start from origin/main at exact SHA
313daa0c5812d34f8ab7b977f6cc500fde751869. Re-verify live state before any
mutation. Complete Content OS Slices 2, 3, 4 and 5 sequentially, one reviewable
branch and PR per slice. Do not begin a slice until the preceding slice has
green required checks on its exact head SHA, a separate blind read-only review,
and a merge commit on main. Work autonomously through safe source, disposable
PostgreSQL, test, browser, CI, commit, push, PR and merge operations.

Keep every provider adapter disabled. Do not make live or paid provider calls,
connect YouTube OAuth, create a YouTube channel_account, create release intents,
publish, schedule, change production, or expose credentials. Fixture/import
adapters only. Preserve zero provider calls and zero publication side effects.

For each slice run the repository-supported quality gates in order, exercise
the full migration chain and paired pgTAP on an explicitly disposable database,
record exact base/head/merge SHAs, and test the UI in a real browser at desktop
and 390 px where the execution plan requires it. Use the self-hosted runner
label [self-hosted, Linux, X64, selena-ci]. Never print or read secrets.

Do not self-certify a blind review. Send the exact base/head SHA pair to a
separate clean read-only Claude Code chat or to Codex. The reviewer must not
share the implementation context and must not edit the branch. Resolve findings
with new commits, then repeat review on the final SHA.

Railway is a dedicated staging project whose environment is unfortunately
named production. That name does not authorize real production work. Use exact
commit-SHA deployments only. Never deploy or alter the projection service or
unrecognized temporary services because parallel work owns them. Apply a new
migration through the migrate service before deploying affected runtimes.

Stop only for a real safety/owner gate listed in the handoff. When stopping,
state the verified outcome, exact blocker, owner, and one next action. Do not
call source implementation, green CI, a deployment, or a fixture run production
acceptance.
```

## 2. Product and responsibility model

- **Selena Systems / Selena OS:** the owner's command cabinet.
- **Content OS:** the project-scoped content control module inside Selena OS.
- **Aether Studio:** a separate employee workspace, not the owner's cabinet and
  not an autonomous-agent product.
- **Aether Runtime:** orchestration/execution infrastructure; it is not the
  source of truth for Content OS governance.
- **AI Visibility:** a separate client-facing visibility product.
- **Video Radar:** source for the research contracts used in Slice 2.
- **YouTubePro:** source for idea/script/thumbnail contracts used in Slice 3;
  it is not a video renderer and does not publish to YouTube.

Content OS is brand-scoped. KORA, Other Bali, Core Football and every other
project must keep independent profile, evidence, content and approval state.

## 3. Canonical repository and documents

- GitHub: <https://github.com/parkourcafe/selena-OS>
- Local checkout used for the completed work:
  `/Users/msnigmatullaeva/Downloads/selena AI company/selena-OS`
- Product contract: `PRODUCT.md`
- Design contract: `DESIGN.md`
- Detailed slice checklist: `docs/control-room/STAGE1_EXECUTION_PLAN.md`
- Technical master spec:
  `docs/control-room/CONTENT_OS_YOUTUBE_STAGE1_TECHNICAL_SPEC.md`
- Deployment runbook: `docs/control-room/DEPLOYING.md`
- Authorization record: `docs/control-room/AUTHORIZATION_MATRIX.md`
- Owner gates: `docs/control-room/OWNER_GATES.md`

The program-status table and unchecked boxes in the execution plan predate the
verified Slice 1 merge/deploy below. Reconcile them from evidence rather than
assuming `PR_OPEN` is still current.

## 4. Verified completion state

### Slice 0

- Neutral product name: **Content OS**.
- Fail-closed feature flag: `CONTENT_OS_STAGE1_ENABLED`; only exact `true`
  enables the Stage 1 surface.
- Product/design/spec/navigation foundation merged before Slice 1.

### Slice 1

- PR: <https://github.com/parkourcafe/selena-OS/pull/28>
- Final PR head: `45dd3b96c8579eb68b953ff1d353383bada5c2e5`
- Merge commit on `main`:
  `313daa0c5812d34f8ab7b977f6cc500fde751869`
- Required checks on the final head: Build, E2E Integration Tests, Verify CLA
  signature, smoke, Dependency License Audit and Scheduling Policy Verification
  all completed with `SUCCESS`.
- Migration `0037_content_project_profiles.sql` applied to the dedicated
  Railway staging database.
- Independent database check returned true for all three tables and the enum:
  `brand_content_profile_versions`, `brand_content_profile_decisions`,
  `content_channels`, `profile_decision`.
- The migration runtime logged `migrations applied successfully`; the web,
  gateway, worker and ingestion runtime logins were provisioned and verified.
- Staging UI opened as an authenticated owner for Other Bali.
- A single idempotent Other Bali YouTube target was created with
  `platform=youtube`, `publication_mode=DRAFT_ONLY`, and no channel URL.
- The UI displays: `YouTube: Draft-only. No account connected. Publishing is
  unavailable.`
- No YouTube OAuth or provider publication was enabled.

## 5. GitHub and Hetzner CI

- Repository remote: `https://github.com/parkourcafe/selena-OS.git`.
- Self-hosted runner name: `selena-remote-runner`.
- Runner labels: `self-hosted`, `Linux`, `X64`, `selena-ci`.
- Verified runner state at handoff: `online`, not busy.
- Host: Ubuntu 24.04, x86, Docker installed; GitHub Actions runner `2.337.0`.
- Runner systemd unit:
  `actions.runner.parkourcafe-selena-OS.selena-remote-runner.service`.
- Required workflows were changed to the Selena runner, including build, E2E,
  license, mode compatibility, CLA and Claude workflows.
- Playwright system dependencies are preinstalled on the runner; workflows
  install Chromium without `--with-deps`.
- Do not place the VPS public IP, SSH private-key path or any registration token
  in this repository. GitHub runner APIs and workflow logs are the normal
  operational surface.

Safe runner check:

```bash
gh api repos/parkourcafe/selena-OS/actions/runners \
  | jq '{total_count,runners:[.runners[]|{name,status,busy,labels:[.labels[].name]}]}'
```

## 6. Railway staging

The Railway project is dedicated staging even though its sole environment is
named `production`. Treat the environment name as a legacy label, not as
authorization to touch real production.

- Project name: `selena-os-staging`
- Project ID: `f8d94e6a-d0d9-4166-8ad5-828c1e0679fa`
- Environment ID: `a34784b2-44c3-4c58-b950-5a1ddef90b57`
- Web: `cd4b5c37-c924-46d0-83fe-e35bce123590`
- Worker: `74b32a9c-03c6-40b7-8636-9ac0077589b7`
- Gateway: `5703c0b2-736e-49b6-899f-057d6230bf01`
- Receiver: `fbac2f45-649c-4bd5-ae70-f25bc56c3ab2`
- Migrate: `ecdd5667-c423-44d5-b344-84f8bc56bf0b`
- PostgreSQL: `86c716c9-1f4d-4ccc-befa-b977ab57ab9f`
- Projection: `bd3ace57-fed1-419a-948e-2021a74ac3c0` — **do not touch**;
  parallel growth work owns it.

Canonical migration start command:

```text
node scripts/run-migrations.mjs
```

Slice 1 verified deployment IDs:

- migration: `fc03b98c-b7cb-4553-9c47-4f25228d0f00`
- web after custom-domain auth correction:
  `dff49fe9-4b3a-49a4-b25d-bb53a91e94f1`
- worker: `7e3199d3-db3b-423e-88ca-cb6bc8a981d0`
- gateway: `81cc3b52-5fc5-483d-bb8d-e2cc94d6c85d`
- receiver: `0cefeac9-005b-4078-bf92-81b6a4bb4878`

All listed application deployments used merge SHA
`313daa0c5812d34f8ab7b977f6cc500fde751869` and completed with `SUCCESS`.

Infrastructure caveats:

1. Web and receiver source metadata still names an older branch. Use explicit
   exact-SHA deployments and verify deployment metadata until that connection is
   deliberately repaired.
2. `projection` points at `growth/ge1-4-local-slice`; it is unrelated parallel
   work and must not be redeployed by Content OS slices.
3. Unrecognized temporary/restore-inspection services may exist. Do not modify
   or delete them without resolving their owner.
4. Railway CLI may warn that it cannot persist a refreshed OAuth token while
   existing authenticated commands still work. Never read or print Railway
   credential files to diagnose this.

## 7. Staging DNS and authentication

- Canonical staging URL: <https://staging-cabinet.selenasystems.com>
- Content OS Other Bali profile:
  <https://staging-cabinet.selenasystems.com/app/other-bali/control-room/profile>
- Health check:
  <https://staging-cabinet.selenasystems.com/api/setup-status>
- DNS is managed by Vercel nameservers.
- Railway custom-domain ownership is verified and its TLS certificate is valid.
- The web runtime uses the staging custom origin for both `APP_URL` and
  `VITE_APP_URL`; this fixed Better Auth `INVALID_ORIGIN`.
- A non-destructive sign-in canary from the new origin reached credential
  validation rather than origin rejection.
- `cabinet.selenasystems.com` was intentionally not changed. At handoff it still
  resolves to an obsolete Vercel target and is outside the staging scope.

Do not put DNS verification values, session cookies, account passwords or any
other credential in commits, prompts or reports.

## 8. Slice 2 — Research

Start only from the verified Slice 1 merge SHA. Follow section 7 of the
execution plan line by line.

Required outcome:

- confirmed brand profile is required;
- deterministic `FixtureResearchAdapter` works first;
- research runs, sources, snapshots, opportunities and append-only decisions
  are brand-scoped and persisted through migration `0038`;
- fixture/import browser flow can save or reject an evidence-bearing
  opportunity;
- `VideoRadarAdapter` exists but fails closed and never dispatches live.

Source candidate:

- repository: `parkourcafe/video-radar-marketing-tool`
- exact source SHA: `b589a811a4e1f205a784e5128283f9d227143f32`
- its absent license is a hard source-transfer gate. Do not silently copy code
  without resolving the exact authorization required by the execution plan.

Required stop conditions include cross-brand access, overridable tenant
identity, missing provenance, ambiguous transcript rights, raw provider output
in the browser or any live adapter dispatch.

## 9. Slice 3 — Ideas and scripts

Start only from the accepted Slice 2 merge SHA. Follow section 8 of the
execution plan line by line.

Required outcome:

- port only the approved contracts from `parkourcafe/youtube-pro` at exact SHA
  `63cd9b9c2ad19b9941a763be3d5cfcbd9bc13b25`;
- preserve Apache-2.0 license/NOTICE and modification provenance;
- migration `0039` adds structured content, generation lineage and editorial
  review foundations without changing old V1 hashes;
- deterministic fixture generation yields exactly six valid idea packages;
- selecting one creates an immutable YouTube draft and script revisions create
  new immutable versions;
- Gemini adapter code remains independently disabled and performs zero calls;
- no YouTube account, release intent or publication attempt exists.

Do not port YouTubePro's old routes, UI, auth, localStorage state, database
adapter or environment loading. Teleprompter is outside Stage 1 unless the owner
explicitly changes the master specification.

## 10. Slice 4 — Thumbnails and editorial approval

Start only from the accepted Slice 3 merge SHA. Follow section 9 of the
execution plan line by line.

Required outcome:

- thumbnail fixture/upload path reuses private storage, validation, rights,
  consent and scanner controls;
- content/audit/job rows store opaque object references and hashes, never media
  bytes or base64;
- only scanner state `CLEAN` can enter an approval bundle;
- an interactive owner can approve/revoke an exact content/profile/evidence/
  asset hash bundle;
- editorial approval remains distinct from publication approval;
- Releases remains read-only and explicitly unavailable for YouTube;
- database evidence proves zero release, outbox and publication side effects.

Stop on unsafe persistence, missing rights metadata, scanner bypass,
cross-brand asset access, stale-hash approval or any release authority.

## 11. Slice 5 — Vertical acceptance

Start only from the accepted Slice 4 merge SHA. Follow section 10 of the
execution plan line by line.

This is a disposable/local fixture acceptance, not production acceptance.

Required end-to-end proof:

1. Feature flag absent: all new routes/handlers/navigation fail closed.
2. Feature flag exact `true` in the disposable environment only.
3. Create and owner-confirm a profile.
4. Add the draft-only YouTube target.
5. Import deterministic Radar fixture research.
6. Save one evidence-bearing opportunity.
7. Generate exactly six fixture ideas.
8. Select one, create a script and create an immutable revision.
9. Attach a clean thumbnail fixture.
10. Approve the exact bundle editorially as owner.
11. Show publishing unavailable.
12. Prove another organization cannot access any protected state.
13. Repeat changed UI at desktop and 390 px.
14. Prove `externalProviderCalls = 0` and zero release/outbox/publication rows
    before and after.

The evidence bundle must contain exact source SHAs, migration receipt through
`0039`, paired pgTAP results, browser evidence, CI conclusions and the separate
blind review result.

## 12. Branch, review and merge protocol

Use one branch and PR per slice. Suggested branch names:

```text
feat/content-os-slice2-research
feat/content-os-slice3-creation
feat/content-os-slice4-review
test/content-os-slice5-vertical-acceptance
```

For each slice:

1. Fetch and verify the exact accepted predecessor on `origin/main`.
2. Create the slice branch from that SHA.
3. Implement only that slice.
4. Run supported gates in order: lint, typecheck, tests, frontend impeccable
   detect, build; include disposable migration/pgTAP and browser acceptance.
5. Check the staged diff for secret-like strings before commit.
6. Commit and push the reviewable branch.
7. Open a PR with the evidence block from the execution plan.
8. Wait for all required checks on the exact head SHA.
9. Obtain a separate blind read-only delta review for the exact base/head pair.
10. If findings require fixes, commit them and repeat CI and blind review on the
    new final SHA.
11. Merge only the green, reviewed final SHA; record the merge commit.
12. Begin the next slice from that merge commit, never from the old branch.

The owner's request that the implementation chat finish Slices 2–5
autonomously covers normal source, disposable-test, branch, commit, push, PR,
green-gate and merge work within this Stage 1 fixture-only scope. It does **not**
authorize production changes, paid/provider calls, OAuth, secrets, billing,
YouTube publication, weakening tenant boundaries or bypassing a documented
stop condition.

## 13. Independent review rule

The Claude Code chat that writes a slice cannot provide its own independent
blind review. It may run ordinary self-review, static analysis and tests, but
those are implementation gates, not independent evidence.

Acceptable reviewer arrangements:

1. a separate fresh Claude Code chat given only the repository, governing
   documents and exact base/head SHA pair, with explicit read-only instructions;
2. a separate Codex chat performing the same exact-SHA read-only delta review;
3. another reviewer that did not implement the branch and cannot mutate it.

The review report must identify the exact SHA reviewed, findings by severity,
commands actually run, limitations and a binary result. A review of an earlier
SHA does not cover later fixes.

## 14. Non-negotiable safety boundaries

- Never read or print `.env`, token stores, private keys, passwords or provider
  credentials.
- Never commit a secret or a real provider payload.
- Never claim Central Memory registration without a successful tool receipt.
- Never use a shared/staging database as the disposable pgTAP target.
- Never make a live Video Radar, Gemini, YouTube or other paid call in Stage 1.
- Never create a YouTube `channel_account`, release intent, outbox publication
  event or upload.
- Never allow editorial approval to grant publishing authority.
- Never weaken RLS, brand isolation, append-only history or owner-only approval.
- Never touch production or the existing public `cabinet.selenasystems.com`
  without a new explicit owner authorization.
- Never call a build, PR, deployment or fixture run production acceptance.

## 15. Definition of completion

Slices 2–5 are complete only when:

- every slice has a separate merged PR and recorded exact SHAs;
- all required checks are green on each final head;
- the final migration chain applies through `0039` in a disposable database;
- paired pgTAP, server and browser acceptance evidence is present;
- tenant denial and immutable history are proven;
- the full fixture path works end to end;
- provider-call and publication counters remain zero;
- a separate reviewer passes the final exact SHA;
- remaining limitations explicitly say Stage 1 has no YouTube OAuth, rendering,
  upload, scheduling, analytics ingestion or production acceptance.
