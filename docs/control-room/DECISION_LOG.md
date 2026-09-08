# Content OS Stage 1 decisions

## 2026-09-08 — Slice 3.1 durable provider budget ledger

- Decision: migration `0046` (renumbered from `0044` after the release-dispatch
  branch landed `0044`/`0045` on main first — the order is only about which
  reached the tree first) adds `selena_registry.provider_budgets` and
  `selena_registry.provider_call_ledger`. Budgets are owner-only and
  append-only — an interactive owner INSERTs a new row to change a ceiling, and
  nothing may UPDATE or DELETE one. The ledger is written only through the
  `reserve_provider_call` / `settle_provider_call` SECURITY DEFINER functions
  (the web runtime holds no INSERT or UPDATE policy on it), and a reservation
  counts as spent against the window from the moment it is RESERVED until it is
  EXPIRED — an in-flight call is money already committed, not money still
  available. Cost estimates come from fixed per-provider constants
  (`PROVIDER_COST_ESTIMATES`: gemini 20,000 micros/call, video-radar 5,000)
  until real pricing lands; a zero or missing estimate is refused as
  `UNKNOWN_COST_BLOCKED` rather than treated as free. The fixture path in both
  creation and research is untouched — zero reserves, zero ledger reads — so the
  Stage 1 acceptance's externalProviderCalls=0 evidence stays byte-identical.
- Evidence: the process-scoped `ProviderCallLedger` starts at zero on every
  deploy, so its ceiling could never be reached across a restart — Stage 1's own
  comments call it decoration and name a durable shared ledger as the
  prerequisite for any live-call authorization (plan 7.5).
- Alternatives rejected: mutable budget rows (an edit war over one row has no
  history); letting the web runtime write the ledger directly (the advisory-lock
  window arithmetic would then be advisory in the bad sense); estimating unknown
  costs as zero (a free reservation under a cost ceiling is not a gate).
- Authority: owner's autonomous-execution mandate of 2026-09-08.
- Affected requirements: Stage 1 plan 7.5, Stage 3 Slice 3.1.

## 2026-09-08 — Slice 4 editorial review shape

- Decision: the editorial route lives at `/control-room/editorial` (the spec's `/review` name collides with the release-era `#review` hash section); audit actions are `content.editorial_approved`, `content.editorial_changes_requested`, `content.editorial_rejected` — one per decision — instead of the spec's single revoke action, because `editorial_approvals` is append-only and a later decision supersedes rather than revokes; `CHANGES_REQUESTED` returns the item to `SCRIPT_DRAFTED`, `REJECTED` archives it; the thumbnail block inside `structured_body` stays unpopulated in Slice 4 — the asset bundle binds through `content_assets` rows and the approval's `asset_bundle_hash`, so no immutable version needs rewriting.
- Evidence: recon of `0043` policies (only `content_hash` is database-bound; owner-only APPROVED; reason required), existing `#review` section in the monolith, append-only trigger on `editorial_approvals`.
- Alternatives rejected: reusing the release `approvals` table (binds a channel account and grants release authority); writing a new content version per thumbnail change (hash churn without editorial meaning).
- Authority: owner's autonomous-execution mandate of 2026-09-08.
- Affected requirements: spec §14, §15, §16 Slice 4.

## 2026-09-08 — move CI to GitHub-hosted runners while the Hetzner runner is down

- Decision: every workflow's `runs-on` moves from `[self-hosted, Linux, X64, selena-ci]` to `ubuntu-latest`. The Hetzner server `selena-remote-runner` stays untouched and running — it hosts other owner data and is explicitly out of scope; only its GitHub-runner service is dead (offline after a reboot 22h prior, root password unavailable to the owner at the time). GitHub-hosted minutes are included in the organization's new Team plan.
- Evidence: runner Offline in repository settings; E2E run canceled mid-build; five required checks queued indefinitely on PR #44.
- Alternatives rejected: Blacksmith runners (separate billing, owner not ready to decide); repairing the runner service first (requires an interactive root login only the owner can perform — recorded as an open follow-up, not a prerequisite).
- Follow-up: restore `svc.sh`/systemd autostart for the runner on the Hetzner box, then optionally move heavy jobs back to it for speed.
- Authority: owner's autonomous-execution mandate; owner explicitly forbade touching the Hetzner server.

## 2026-09-08 — supersede the stalled Slice 4 handoff branch

- Decision: `feat/content-os-slice4` (built on current main) is the Slice 4 candidate; the stalled `claude/handoff-slice4-continuation-1s7cha` branch (8 ahead / 8 behind, ends with an explicit handoff commit) is kept unmerged as review input, not deleted. Two of its ideas are noted for follow-up: a dedicated thumbnail-attach route outside the public API prefix, and recording an image's origin (generated vs uploaded) on the asset row — Stage 1 only has uploads, so §14's origin distinction is vacuously satisfied and deferred.
- Evidence: branch history on GitHub, 2026-09-07; both implementations target the same editorial_approvals table.
- Alternatives rejected: rebasing the stalled branch (8 behind, unknown conflicts with merged Slice 3 rounds); merging both (duplicate consumers of one table).
- Authority: owner's autonomous-execution mandate §4.


## 2026-09-05 — implement Slice 1 on an isolated branch

- Decision: implement the profile and draft-only YouTube target inside `selena-OS` on `feat/content-os-slice1`.
- Evidence: approved Stage 1 execution plan and existing Slice 0 shell.
- Alternatives rejected: new repository extraction (would split existing RLS and tenant seams).
- Authority: owner request for autonomous Slice 1 implementation.
- Affected requirements: S1-01 through S1-07.

## 2026-09-05 — separate confirmed profile from draft history

- Decision: `getCurrent` returns only the newest confirmed, non-revoked version; `listVersions` supplies draft/history UI data.
- Evidence: research and creation must never consume an unconfirmed draft.
- Alternatives rejected: returning the newest undecided version from `getCurrent`.
- Authority: safe default from the technical specification's confirmed-profile boundary.
- Affected requirements: S1-02, S1-04, S1-06.

## 2026-09-05 — no shared database or provider execution

- Decision: add migration, pgTAP suite and a guarded runner, but do not apply 0032 or call YouTube/provider services in this turn.
- Evidence: repository instructions require an explicitly disposable database and separate external gates.
- Authority: repository safety rules.
- Affected requirements: S1-02, S1-03, S1-07.
- Status: superseded for database execution by the explicit 2026-09-06 staging
  authorization below; the provider prohibition remains active.

## 2026-09-06 — authorize Slice 1 delivery through staging

- Decision: execute disposable PostgreSQL evidence, commit, push, merge, deploy
  to the verified Railway staging target, apply the staging migration and enable
  the Stage 1 canary flag.
- Boundary: YouTube OAuth, live-provider calls and publication remain
  prohibited; production deployment and production database mutation are not
  authorized.
- Authority: owner quote, “Да, разрешаю disposable PostgreSQL, commit, push,
  merge, Railway staging deploy, миграцию staging и включение canary-флага.
  YouTube-публикацию не включать”.
- Affected requirements: S1-02 through S1-08.

## 2026-09-06 — reconcile the deployed staging line before delivery

- Decision: merge the branch currently deployed by the dedicated Railway
  staging project into the Slice 1 candidate before deployment, then reconcile
  the canonical `main` branch and staging to the same reviewed SHA.
- Evidence: Railway deploys `claude/new-session-r64y7u`, which already contains
  migrations `0032` through `0036`; deploying the pre-reconciliation Slice 1
  branch would remove live staging code and collide with migration `0032`.
- Consequence: the project-profile migration is renumbered to `0037`; planned
  research and structured-content migrations move to `0038` and `0039`.
- Alternatives rejected: overwrite staging from stale `main`, or keep two
  different migrations numbered `0032`.
- Authority: safe implementation step within the owner's authorized staging
  migration, deploy and merge boundary.
- Affected requirements: S1-02, S1-07, S1-08.

## 2026-09-06 — make the Railway dependency layer workspace-complete

- Decision: copy every workspace package manifest present in the Docker build
  context before the frozen install, including `apps/www`, `packages/docs` and
  `packages/selena-visibility-contracts`.
- Evidence: the merged staging Dockerfile installed only a partial workspace;
  after source copy, pnpm tried to resolve the newly discovered packages during
  the build step. With the complete manifest set, the Node 24 web build runs
  directly against the frozen dependency layer.
- Boundary: no dependency or lockfile version was changed.
- Authority: required implementation repair inside the authorized Railway
  staging deployment.
- Affected requirements: S1-08.

## 2026-09-06 — resolve the blind review's migration-numbering finding

- Decision: update the master specification's verified baseline and database
  headings to reflect the reconciled migration line: staging owns `0032`
  through `0036`, Slice 1 uses `0037`, and the planned research and creation
  migrations use `0038` and `0039`.
- Evidence: the independent Claude Code Max blind review of `594cc3b6` found
  that sections 2 and 9 still described the pre-reconciliation `0031` baseline
  and the now-colliding `0032` through `0034` plan. The same review confirmed
  the implemented Slice 1 profile/RLS/draft-only architecture; its findings
  about Slices 2 through 4 are expected future work, not Slice 1 regressions.
- Boundary: no research, creation, provider or publication capability is added.
- Authority: required response to the exact-head review within the owner's
  approved Slice 1 delivery loop.
- Affected requirements: S1-08.

## 2026-09-06 — make fact evidence states authorable in the profile UI

- Decision: replace the facts-only textarea with repeatable fact controls for
  the fact key, statement, evidence state and fact-specific source URLs.
- Evidence: the independent Claude Code Max blind review of `9a61082d`
  confirmed the domain and persistence rules but found that the UI forced all
  new facts to `UNKNOWN`, leaving no user path to create a sourced `VERIFIED`
  fact or explicitly record `DISPUTED` and `PROHIBITED` states.
- Invariants: `VERIFIED` requires a source; `PROHIBITED` cannot carry a source;
  only sourced `VERIFIED` facts can enter future factual-claim context.
- Boundary: this changes draft authoring only and adds no provider, OAuth,
  release or publication capability.
- Authority: required response to the exact-head review within the owner's
  approved Slice 1 delivery loop.
- Affected requirements: S1-01, S1-05, S1-08.

## 2026-09-06 — run required PR checks on GitHub-hosted runners

- Decision: move only the four pull-request workflows required by Slice 1
  (`Build`, `E2E Tests`, `License Check` and `Deployment Smoke Tests`) from
  Blacksmith labels to `ubuntu-24.04`.
- Evidence: `parkourcafe` is a GitHub personal account and owns the private
  `parkourcafe/selena-OS` repository; Blacksmith's installation flow states
  that personal GitHub accounts are unsupported. The Blacksmith-labeled PR
  jobs remained queued with zero repository runners.
- Boundary: scheduled provider checks, daily content automation and the manual
  release workflow are unchanged and are not triggered by this delivery.
- Authority: owner approved GitHub-hosted runners and available GitHub Actions
  minutes on 2026-09-06.
- Affected requirements: S1-08.

## 2026-09-07 — precondition for migration 0040 on databases that predate it

- Decision: keep `0040_content_policy_lifecycle` as applied on staging and record
  its precondition instead of rewriting it. The migration marks every existing
  `selena_registry.content_policies` row `active` and then creates the partial
  unique index `content_policies_one_active_per_brand`, so it aborts on any brand
  that already holds two or more policy rows; because drizzle applies pending
  migrations in one transaction, 0038–0040 then all roll back together.
- Check before migrating any database still at 0037 or earlier:
  `SELECT brand_id, count(*) FROM selena_registry.content_policies GROUP BY 1 HAVING count(*) > 1;`
  must return no rows. If it does, withdraw every row but the newest per brand
  first (`status = 'revoked'`, with `revoked_at`, `revoked_by` and a reason), or
  ship a preceding migration that does so.
- Evidence: staging had no brand with more than one row when 0040 ran and the
  index was created; the failure mode was reproduced on a throwaway database
  during the independent review of the integration branch.
- Boundary: applied migration files and the ledger are never edited; the
  precondition is enforced by the check above, not by 0040 itself.
## 2026-09-06 — number the research and structured-content migrations 0040 and 0041

- Decision: Slice 2 adds `0042_content_research_registry` and Slice 3 adds
  `0043_structured_content_and_editorial_review`.
- Evidence: `growth/ge1-4-local-slice` already holds
  `0038_growth_project_bindings` (`when` 1788620400000) and
  `0039_aether_events_content_draft` (`when` 1788620460000); issue #29 records
  that `0037` landed first and that the next migration on either branch is
  `0040`.
- Consequence: keeping the planned `0038`/`0039` names would put two different
  migrations behind each tag in one shared journal, which is the silent-skip
  failure issue #29 exists to prevent.
- Alternatives rejected: renumber the growth entries again (they are already
  raised above `0037` and agreed), or accept duplicate tags.
- Authority: owner decision on 2026-09-06 confirming `0040`/`0041`.
- Affected requirements: Stage 1 plan 7.3B, 8.3B, 10.2 and 10.4.

## 2026-09-06 — authorize the Video Radar source transfer

- Decision: transfer research contracts, scoring, baseline, outlier, relevance,
  velocity and anti-copy enforcement from
  `parkourcafe/video-radar-marketing-tool` at
  `b589a811a4e1f205a784e5128283f9d227143f32` into
  `@workspace/content-workflow`.
- Evidence: the source commit carries no `LICENSE` file and no `license` field
  in its manifest, so the transfer needed an explicit holder decision rather
  than an inferred one.
- Boundary: contracts and pure domain rules only. UI, routes, auth, the
  Supabase adapter, the JSON project registry and environment loading are not
  transferred, and the derived `VideoRadarAdapter` stays fail-closed.
- Authority: owner authorization on 2026-09-06 confirming they hold the source
  and permit the transfer.
- Affected requirements: Stage 1 plan 7.3A.

## 2026-09-06 — keep Slices 2-5 off the shared staging database

- Decision: run every Slice 2-5 migration and pgTAP suite against a disposable
  local PostgreSQL cluster only; record `Staging evidence: NOT RUN` in each PR.
- Evidence: issue #29 records that the `migrate` service autodeploy trigger was
  removed and that, for the duration of GE-5, migrations against the shared
  staging database are run by the owner by hand at a verified commit SHA.
- Consequence: Stage 1 plan section 10 acceptance stays local fixture
  acceptance, which is what it already claims to be.
- Authority: owner decision on 2026-09-06.
- Affected requirements: Stage 1 plan 3.4, 10.2 and 10.4.

## 2026-09-06 — record the migration ordering constraint where it outlives the PR

- Decision: state the `when` high-water-mark rule and the required apply order in
  `STAGE1_EXECUTION_PLAN.md` §3.4 and as an owner gate, not only in a pull
  request body.
- Evidence: Drizzle applies a migration only when its journal `when` exceeds the
  newest recorded `created_at`, so a distinct tag prevents a collision but not a
  skip. Content OS `0040` (`when` 1788620520000) sits above
  `growth/ge1-4-local-slice`'s `0038` (1788620400000) and `0039` (1788620460000),
  and a database that receives `0040` first loses both silently.
- Consequence: the growth entries are applied first or re-stamped above `0040`
  when that branch merges. The runner guard that would refuse instead of
  succeeding lives on the growth branch and reaches `main` with it.
- Alternatives rejected: lowering `0040` below the growth entries, which only
  moves the same hazard onto the other branch; relying on a note in a pull
  request, which does not survive the merge.
- Authority: safe implementation step within the recorded migration-numbering
  decision.
- Affected requirements: Stage 1 plan 3.4 and 7.3B.

## 2026-09-06 — profile revocation falls back to the previous confirmed version

- Open decision for the owner. Recorded rather than silently settled.
- Behavior today: research selects the newest profile version whose own newest
  decision is `CONFIRMED`. Revoking the version a brand is using therefore does
  not stop research; it continues against the last still-confirmed version, and
  the surface presents that older version as the confirmed profile.
- Why it is not simply a bug: an undecided draft must not block research against
  the confirmed version beneath it, so "use only the newest version" is wrong.
  The question is whether a revoked newest version should stop research outright
  or fall through, and that is a product judgement about what revocation means.
- Inherited from Slice 1's `profiles.getCurrent`; Slice 2 is the first consumer
  that acts on it.
- Safe default until the owner decides: leave the fallback, state it plainly in
  the plan's acceptance wording, and keep the integration coverage that pins the
  behavior either way.
- Affected requirements: Stage 1 plan 7.4.

## 2026-09-06 — a release gate reads what a version is, not a column that can be edited

- Decision: `selena_release.reject_unsupported_youtube_release` keys on
  `content_versions.format_version`, and `content_items.content_kind` becomes
  immutable through a trigger.
- Evidence: `content_items_web_update` is a bare `can_write_brand` and 0021
  grants UPDATE on every column, so an ordinary web session could flip
  `content_kind` to `GENERIC_POST`, create a release intent for a
  `content.youtube-video/v1` version, and flip it back. No operator, no gateway
  and no new provider value were involved. `content_versions` admits no UPDATE
  and no DELETE from any runtime role, so its own statement of what it is cannot
  be edited the same way.
- Consequence: the kind stays in the condition — a YouTube draft whose newest
  version is still legacy text is gated too — but it is no longer the only
  thing consulted, and it can no longer be changed at all.
- Alternatives rejected: the trigger alone, which would leave the guard reading
  a column whose immutability is enforced somewhere else; `format_version`
  alone, which would stop gating a YouTube draft before its first structured
  version.
- Affected requirements: Stage 1 plan 9.4.

## 2026-09-06 — an idempotency key is checked against the request it was used for

- Decision: `generation_runs` records the content item a script run was for, and
  a key already spent on a different request is refused with
  `IDEMPOTENCY_KEY_CONFLICT` rather than answered with the earlier request's
  result.
- Evidence: the key is unique per brand. A key reused across drafts returned the
  other draft's script as this one's; a key reused from an idea run reported that
  run's success as this draft's failure.
- Consequence: a failed script run also says which draft it failed on, which it
  previously did not record anywhere.
- Affected requirements: Stage 1 plan 7.5.

## 2026-09-07 — the research and structured-content migrations become 0042 and 0043

- Decision: on merging the growth line (`integration/content-os-growth-ge5`)
  into `main`, rename `0040_content_research_registry` to `0042` and
  `0041_structured_content_and_editorial_review` to `0043`, with journal `when`
  1788620640000 and 1788620700000; their content is unchanged.
- Evidence: the growth line added `0040_content_policy_lifecycle` (`when`
  1788620520000) and `0041_content_policy_web_writes_revoked` (1788620580000)
  after the numbering decision above, and both are applied on the shared staging
  database with those `when` values recorded. The Slice 2 and 3 migrations carried
  the same two `when` values and are applied nowhere shared ("keep Slices 2-5
  off the shared staging database"). Drizzle's high-water mark would have
  skipped them silently on staging, and the migration runner refuses exactly
  that case.
- Alternatives rejected: renumbering the growth migrations, which would require
  editing the staging ledger; keeping duplicate numbers, which the journal order
  can express but every reader of the directory would misread.
- Consequence: a database that already holds the growth line applies `0042` and
  `0043` next; a clean database applies `0000` through `0043` in order. The
  Stage 1 documents now name `0042`/`0043`; earlier decisions in this log keep
  the numbers they were made under.
- Authority: owner instruction on 2026-09-07 to merge the growth line into
  `main`.
