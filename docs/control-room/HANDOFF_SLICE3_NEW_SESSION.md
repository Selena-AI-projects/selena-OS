# Handoff — Content OS Slice 3, continued in a new session

Written 2026-09-07 ~02:15 UTC by the session that carried Slices 2 and 3.
That session lost all repository access mid-work because the repository was
transferred to a new owner, and a session cannot be re-pointed across owners.
Everything below was verified before access was lost; nothing here is from
memory alone.

## 1. What moved, and where things are now

| | Before | Now |
|---|---|---|
| Repository | `parkourcafe/selena-OS` | `Selena-AI-projects/selena-ai-visibility` (organization) |
| Working branch | `feat/content-os-slice3-creation` | same name — branches move with a transfer |
| Pull request | #32 | same number — PR numbers are preserved on transfer; **verify** |
| Head of the branch | `3a6c9cdac82dd5c2be9984fe316a2c1f080b875b` | same — every commit was pushed before the transfer; working tree was clean |

Local checkouts from the old session are gone with it. Clone fresh from the new
address.

**First thing to do in the new session:** confirm all four rows above with the
GitHub tools. If PR #32 is not at the new address, search PRs by branch name.

## 2. Programme state

| Slice | State | Head | Merge commit on `main` |
|---|---|---|---|
| 1 — profile and draft YouTube target | MERGED | `45dd3b96` | `313daa0c5812d34f8ab7b977f6cc500fde751869` |
| 2 — research (migration `0040`) | MERGED, PR #31 | `52741aee` | `86a0a6334df734849d21b887d5e0511e5180c872` |
| 3 — ideas and scripts (migration `0041`) | **IN REVIEW, code complete**, PR #32 | `3a6c9cdac82dd5c2be9984fe316a2c1f080b875b` | — |
| 4 — thumbnails and editorial approval | NOT STARTED | — | — |
| 5 — local vertical acceptance (`0000..0041`) | NOT STARTED | — | — |

The governing document is `HANDOFF_SLICES_2_5.md` §1 (in the owner's uploads,
and its rules are restated in `docs/control-room/STAGE1_EXECUTION_PLAN.md` and
`OWNER_GATES.md`). Its stop-conditions still apply: no slice begins until the
previous one has green required checks **on its exact head SHA**, a separate
blind read-only review, and a merge commit on `main`.

## 3. Slice 3 — exactly where it stands

Commits on top of Slice 2's merge, oldest first (the last three are this session's
round-2 work):

```
1438f71b40d1f16f058a7a1a65f71ebf09d85626  record Slice 2 as merged and Slice 3 as in review
204fddf8da7934caf7aca5cd089619211f3b10da  stop reformatting the migration journal, and fix three lint findings
0a3140deaa76378ff8f95e460fd00144c364d322  close both release-gate holes and the unprotected version lineage
d066f22b0ff0ddf4ccc8f3de2f5fd86c6dded85a  gate a release on what the version is, not on an editable column
dc176cf18d2f72ac31b16632779dc204c8edf16e  record the round-two decisions and the two gaps this slice does not close
3a6c9cdac82dd5c2be9984fe316a2c1f080b875b  say what the version-number uniqueness actually is
```

**Reviews so far:** two blind reviews by separate read-only Claude Code Remote
sessions, both posted as PR comments. Round 1 (on `54b2163`→fixed in `0a3140d`)
and round 2 (on `0a3140d`, verdict CHANGES_REQUESTED, 1 BLOCKER + 2 MAJOR +
5 MINOR). All eight round-2 findings are fixed in `d066f22`..`3a6c9cd` and
answered in PR comment id `5561257162`. **A third blind review on
`3a6c9cd` has not been requested yet** — it was waiting on green CI.

**Verification on `3a6c9cd`, all run locally before access was lost:**

| | |
|---|---|
| pgTAP, all 17 suites | `assertions=353 failures=0`; `0041` suite at 70 (was 58) |
| Integration harness as `selena_web_login` (real RLS) | 3 files, 3 tests, passed |
| `packages/lib` unit | 691 passed, 3 skipped |
| `packages/content-workflow` unit | 64 passed |
| Typecheck | `lib`, `content-workflow`, `web` clean |
| Browser, `CONTENT_OS_STAGE1_ENABLED=true` | 27 assertions + 2 recorded observations, 1440px and 390px |
| Browser, flag unset | 4/4 — no nav entries, both routes refuse (500 from the loader) |

Adversarial checks: every new pgTAP assertion was run against a deliberately
un-fixed migration (reverting only the two tenant predicates → exactly one
failure; reverting only the idempotency checks → integration test fails on a
resolved-instead-of-rejected promise).

**CI on `3a6c9cd`:** 5 of 6 green (CLA, License Audit, E2E, Scheduling Policy,
smoke). `Build` **red, exit 137** — `Killed` during nitro "rendering chunks".
Diagnosed and documented in PR comment id `5562834219`:

- SIGKILL from memory pressure on the self-hosted runner, not a code failure;
- `Build` was green on the parent `0a3140d`; the only `apps/web` change since is
  `ideas.tsx` (a Set, a function signature, a React key);
- measured: `apps/web` build peaks at **4710 MB** with the change, **4695 MB**
  without it (same `node_modules`) — 0.3%, noise;
- one re-run was spent (the whole allowance); it queued and never started
  because the runner had stopped taking jobs.

## 4. Infrastructure facts learned tonight

**Self-hosted runner** (labels `self-hosted, Linux, X64, selena-ci`) runs on the
owner's Hetzner Cloud server:

- Hetzner project `selena-ai-visibility`, server **`selena-remote-runner`**,
  type **CX33 — 4 vCPU, 8 GB RAM, 80 GB disk**, Nuremberg, ~$9.99/mo;
- agent installed at `/opt/actions-runner`, runs as user `ghrunner`;
- it OOM-killed the build at 18:44 UTC on 2026-09-06 and then took no jobs for
  7+ hours; the owner was asked to **Power cycle** it from the Hetzner console
  (Power tab) — whether that was done was not confirmed before handoff;
- `CX43` (16 GB) is **unavailable** in Nuremberg; `CPX42` (16 GB) costs $81.99/mo
  — the owner was advised **not** to pay that, and not to buy a second 8 GB box
  (it does not fix the in-job parallelism and doubles the ops burden).
  `CX53` (32 GB, $34.99) is the only sensible hardware upgrade if wanted.

**Every PR check runs on that one runner** (`build`, `cla-check`, `e2e` ×2,
`license-check`, `mode-compat`, `claude`). Blacksmith (`blacksmith-*` labels,
`useblacksmith/*` actions) is used only by `daily-blog-draft`, `test-providers`
and `publish`. Blacksmith refused to serve a personal account — that is the
reason the owner created the organization. Now that the repo is under an org,
Blacksmith may work again once connected to the org; **check before migrating
those three workflows.**

**Runner registration after the transfer is unverified.** A repository-level
runner may not follow a transfer to a new owner. Check
`https://github.com/Selena-AI-projects/selena-ai-visibility/settings/actions/runners`.
If `selena-ci` is absent, it must be re-registered on the Hetzner box
(`/opt/actions-runner/config.sh` with a fresh token from that settings page,
as user `ghrunner`, then `sudo ./svc.sh install && sudo ./svc.sh start`). The
owner is not technical; give one command at a time and use the Hetzner web
console (the `>_` button) rather than assuming SSH.

**Node 24 is declared, 22.22.2 was what ran locally** — recorded deviation,
unchanged.

## 4a. Owner decisions taken on 2026-09-07 (~02:30 UTC)

- **Keep the Hetzner self-hosted runner. Do NOT move CI to GitHub-hosted
  runners** — the owner explicitly rejected GitHub minutes ("they run out fast").
  Path A below, not path B.
- **Use Blacksmith** for what it already serves (`daily-blog-draft`,
  `test-providers`, `publish`); reconnect it to the organization at
  https://app.blacksmith.sh. If it now serves the org, moving more workflows to
  it is an owner decision, not a default.
- The Claude GitHub App was installed on the organization by the owner. After
  that, `git` through the old URL began following the transfer redirect
  (`git ls-remote` returned `main` at `86a0a633…`), while the App-authenticated
  REST API still refused the old name and `add_repo` still refused the new
  owner. So a new session is still required for PR/check-run tooling.
- The owner has **no SSH key** for the Hetzner box (`Permission denied
  (publickey)` from her Mac) and is not comfortable in a terminal. Runner
  re-registration therefore goes through the **Hetzner web console** (`>_`
  button, root password via Rescue → Reset root password), typing by hand:

  ```
  cd /opt/actions-runner
  ./svc.sh stop; ./svc.sh uninstall
  rm -f .runner .credentials .credentials_rsaparams
  sudo -u ghrunner ./config.sh --url https://github.com/Selena-AI-projects --token <TOKEN> --name hetzner --labels selena-ci --unattended --replace
  ./svc.sh install ghrunner; ./svc.sh start
  ```

  Register at the **organization** level
  (https://github.com/organizations/Selena-AI-projects/settings/actions/runners
  → New runner → Linux x64) so it survives future repo moves. The `selena-ci`
  label is mandatory — every workflow selects on it. Confirmed at 02:20 UTC:
  the new repo's runner page said "There are no runners configured".
- A password was typed into the owner's shell as a command during this
  exchange and is in her terminal history; she was told to change it. Do not
  ask her to type passwords anywhere a prompt is not hiding them.

## 5. What to do next, in order

1. **Access.** Confirm the GitHub App is installed on `Selena-AI-projects` with
   the repo granted; confirm PR #32 and branch head `3a6c9cd` at the new address.
2. **Runner.** Confirm `selena-ci` is registered under the new owner and shows
   Idle. If not, walk the owner through re-registration (§4).
3. **Build green.** Re-run `Build` on `3a6c9cd` once the runner is live. The one
   re-run allowance was spent in the old session on a run that never started;
   treat one more as the legitimate first attempt on a live runner. If it fails
   again with 137, do **not** re-run — go to step 5 first.
4. **Round-3 blind review** on the exact head, by a separate read-only session
   (`create_session` with a read-only prompt; it posts its report to the PR).
   Do not self-certify. Then merge via the PR, record the merge SHA in
   `docs/control-room/ORCHESTRATION_STATE.md`, and mark Slice 3 MERGED.
5. **CI robustness PR (separate, small).** The runner stays at 8 GB, so this
   is what stops the next OOM. Confirm once with the owner, then open a PR that:
   - runs `pnpm build` with turbo concurrency limited (e.g. `--concurrency=2`)
     in `.github/workflows/build.yaml`;
   - adds a shared `concurrency` group across `build.yaml` and `e2e.yaml` so
     heavy self-hosted jobs do not overlap;
   - sets `NODE_OPTIONS: --max-old-space-size=4096` on the Build step so V8
     reports instead of the kernel killing.
   Optionally advise the owner to add an 8 GB swap file on the box.
6. **Blacksmith.** The owner wants to keep using it. Confirm it is connected to
   the organization (app.blacksmith.sh); its three workflows should then start
   picking up. Do not migrate them to GitHub-hosted runners.
7. **Slice 4**, then **Slice 5**, per `HANDOFF_SLICES_2_5.md` §1.

## 6. Carried items and open decisions (unchanged)

- **Open owner decision:** revoking a confirmed profile does not stop
  research/creation — it falls back to the previous still-confirmed version.
  Recorded in `DECISION_LOG.md`; pinned by tests either way.
- **Carried into Slice 4:** empty/whitespace `sourceUrl` still reports
  `MISSING_PROVENANCE`; nothing pins the `[:space:]` ⊂ `\s` ctype asymmetry;
  the shared `SidebarTrigger` (`packages/ui/src/components/sidebar.tsx:269`,
  `size-7`) is 28 px, under the 44 px mobile target — a `packages/ui` component,
  not a content-slice fix.
- **No CI lint gate.** `biome check .` reports 326 errors / 358 warnings
  repo-wide, so a required lint job needs a cleanup first. Recorded in
  `ORCHESTRATION_STATE.md`.

## 7. Working practices that held

- Reviews are separate Claude Code Remote sessions, read-only, posting to the
  PR. Two rounds was the norm; stop when non-blocking findings have no
  cross-merge cost asymmetry.
- pgTAP: `packages/lib/scripts/run-pgtap.sh <dbname>`; integration:
  `packages/lib/scripts/run-integration.sh <dbname>` (provisions
  `selena_web_login`, runs under RLS). Postgres may need
  `pg_ctlcluster 16 main start` after a container restart.
- Browser evidence: build web, migrate a disposable DB, start
  `node .output/server/index.mjs` via `setsid nohup … & disown` (a plain
  `nohup &` gets killed; and never `pkill -f` a pattern that matches your own
  shell), sign up via `/api/auth/sign-up/email`, seed org/member/brand, set
  `session.active_organization_id`, drive with `@playwright/test` from a file
  **inside `e2e/`** (module resolution), Chromium at `/opt/pw-browsers/chromium`.
  Run the app's Control Room connection as `selena_web_login` via
  `SELENA_WEB_DATABASE_URL` so the browser run exercises RLS.
- The migration journal `_journal.json` must be appended as text, never
  round-tripped through a JSON writer.
- Never state a number from memory in a PR comment; re-measure first. Two
  public corrections were needed for exactly that.

## 8. Non-negotiable boundaries (verbatim from HANDOFF_SLICES_2_5.md §14)

- Never read or print `.env`, token stores, private keys, passwords or provider credentials.
- Never commit a secret or a real provider payload.
- Never claim Central Memory registration without a successful tool receipt.
- Never use a shared/staging database as the disposable pgTAP target.
- Never make a live Video Radar, Gemini, YouTube or other paid call in Stage 1.
- Never create a YouTube `channel_account`, release intent, outbox publication event or upload.
- Never allow editorial approval to grant publishing authority.
- Never weaken RLS, brand isolation, append-only history or owner-only approval.
- Never touch production or the existing public `cabinet.selenasystems.com` without a new explicit owner authorization.
- Never call a build, PR, deployment or fixture run production acceptance.

## 9. Owner-facing conventions

The owner (Selena) communicates in Russian and is not an engineer. Explain in
plain words, give one click or one command at a time, name the exact button.
When she brings a substantive text or plan, apply her standing rule: state
agreement/disagreement with arguments both ways, rate 1–5, name the three most
critical flaws, and execute only after approval. That rule does not apply to
short questions, continuation commands, or steps already approved in-session.
