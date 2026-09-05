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
