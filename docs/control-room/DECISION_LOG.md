# Content OS Stage 1 decisions

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

## 2026-09-06 — number the research and structured-content migrations 0040 and 0041

- Decision: Slice 2 adds `0040_content_research_registry` and Slice 3 adds
  `0041_structured_content_and_editorial_review`.
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
