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
