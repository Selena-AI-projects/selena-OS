# Jev pilot — isolated mention-classification check

Report generated: **2026-09-21 04:33:57 +05 (Asia/Tashkent)**
Base commit: `b437efc1` on `claude/selena-typesafe-integration-y98vbj` (working tree has the uncommitted diff described below — nothing has been committed or pushed)
Jev model version: **NOT_MEASURED** — no real `systemOne` call was made in this sandbox, so no `result.model` value was ever observed. The SDK's documented default is `jev-latest` (from the installed `@typesafe-ai/sdk@0.6.0` type declarations), which is a name, not a pinned version.
Question template version: v0, single iteration, not yet calibrated or reviewed against real data (see ЭТАП 4 below)
Data composition: 7 hand-written synthetic cases (`apps/worker/src/pilots/jev-mentions/fixtures.ts`), 0 real labeled examples

**INDEPENDENT_REVIEW = NOT_PERFORMED.** Everything below is my own testing and self-review, not a separate reviewer's sign-off.

---

## What this is

An isolated, disabled-by-default check of whether TypeSafe's Jev model (a "System One" model that returns typed yes/no judgments with probabilities, per its own agent skill and SDK docs) could replace or supplement the existing substring-match brand/competitor mention detector. Nothing in the main pipeline was changed; the pilot code lives entirely under `apps/worker/src/pilots/jev-mentions/` and is never imported by `apps/worker/src/jobs/process-prompt.ts` or `apps/worker/src/report-worker.ts`.

## ЭТАП 1 — candidate found in the real code

**Candidate A (chosen): repeating semantic classification.**
- `apps/worker/src/jobs/process-prompt.ts:214-242` and a duplicate `apps/worker/src/report-worker.ts:174-210` (`analyzeMentions`): decides whether the tracked brand and each tracked competitor is mentioned in an AI-engine answer, via `contentLower.includes(alias)` — pure substring matching, no semantic understanding.
- This result is written to `promptRuns` and underlies every visibility/share-of-voice number the product reports.
- No test file covers `analyzeMentions` in either location (confirmed: no matching `.test.ts` exists for either job file).
- Frequency, from the code itself, not estimated: `RUNS_PER_PROMPT_FALLBACK = 5` runs per target every `DEFAULT_DELAY_HOURS_FALLBACK = 24` hours (`packages/lib/src/constants.ts`); report generation runs `CANDIDATE_PROMPTS_COUNT = 84` candidate prompts in batches of 20 (`apps/worker/src/report-worker.ts:23-26,344`).

**Candidate B: model selection by task type — not found.** The closest matches (`packages/lib/src/onboarding/llm.ts:34`'s single static provider-preference list, and `report-worker.ts:33-51`'s per-model *run-count* map) are not a "cheap model for X, expensive model for Y" decision point. Reported as not found rather than stretched to fit.

**Why not plain code:** better regex/fuzzy matching would close some gaps (typos), but the two concrete false positives demonstrated below (character-name collision, negated mention) are semantic, not lexical — that's the actual argument for testing a semantic judgment model here rather than more string logic.

## ЭТАП 2 — connection

- Official skill: not previously installed (checked project `.claude/`, global `~/.claude`, and grepped the repo for "typesafe"/"jev" — nothing). Installed **project-scoped only**: `claude plugin marketplace add typesafe-ai/skills --scope project` then `claude plugin install typesafe@typesafe-ai --scope project`. Declared in `selena-OS/.claude/settings.json` (`extraKnownMarketplaces` + `enabledPlugins`); confirmed `~/.claude.json` and `~/.claude/settings.json` were not touched.
- `https://docs.typesafe.ai/*` is blocked by this sandbox's egress proxy (`EGRESS_BLOCKED` on a direct fetch) — the live docs the skill points to could not be read here. Per the skill's own fallback instruction ("if live access is unavailable, use available local docs or installed SDK types... avoid inventing version-dependent details"), the actual request/response shapes below come from the real, installed `@typesafe-ai/sdk@0.6.0` TypeScript declarations, not from memory or invention.
- Existing usable connection: **none**. There is no `.env` anywhere in this repo (root or `apps/web/`) in this sandbox — no `TYPESAFE_API_KEY`, and none of the vars AGENTS.md lists as required (`DATABASE_URL`, `ANTHROPIC_API_KEY`, etc.) are set either. This blocks both a real Jev call and a real DB-backed dataset (ЭТАП 4).
- One provider used: TypeSafe only, via `@typesafe-ai/sdk`. Env vars it reads directly (from the SDK's own source, `TypeSafeClientConfig`/`ENV`): `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, `TYPESAFE_LOG_LEVEL`. Only presence was checked, never a value; no key material appears anywhere in this report, the code, or shell output.
- Dependency added, exact-pinned (no caret): `@typesafe-ai/sdk: "0.6.0"` in `apps/worker/package.json`. Published 2026-09-15 (5-6 days before this report) — `pnpm install` printed `✓ Lockfile passes supply-chain policies`, i.e. it cleared the workspace's `minimumReleaseAge: 5760` (96h) cooldown on its own; nothing in `pnpm-workspace.yaml` was touched or excluded.
- Runtime versions recorded as found, not changed: Node `v22.22.2` / pnpm `11.18.0` in this sandbox vs. `engines: {"node": "24.x"}` pinned in `package.json` — a pre-existing mismatch in this environment, unrelated to this pilot; no package was mass-updated (verified: reverting to the pristine lockfile and running `pnpm install --frozen-lockfile` succeeds with zero changes, so drift only appears once `pnpm install` is run in write mode after the one-line `package.json` edit — see the diff for the small number of incidental peer-resolution annotation changes this produced on `@tanstack/react-start`, no version bumps).

## ЭТАП 3 — isolated implementation (dry-run only, main pipeline untouched)

All in `apps/worker/src/pilots/jev-mentions/`:
- `classifier.ts` — `classifyMentions(input, options)`. One **Noul** question per entity (brand + each competitor) sent together in a single `systemOne` call (not one call per entity), per the skill's own composition guidance. Noul was chosen over Choice/Score because multiple entities can each independently be "mentioned or not" — exactly the primitive's documented purpose.
- `heuristicMentions()` — an isolated copy of the existing `analyzeMentions`, used as the fallback and as the baseline for comparison. Duplicated on purpose (pilot code doesn't import from or modify the live job files); a comment says so and flags it needs manual re-sync if the original changes.
- Kill switch: `JEV_PILOT_ENABLED` env var, **off by default**. Unset or anything other than `"true"` → always the heuristic, Jev is never even constructed.
- `insufficient_data`: returned before any network code runs, for empty answer text or a brand with no name.
- Fail-closed: any client construction error (missing/invalid key) or API error/timeout falls back to `heuristicMentions()` and reports why, instead of throwing.
- Timeouts/retries: forwarded to the SDK's own `RetryPolicy`/`RequestOptions`, set conservatively (8s timeout, 1 retry vs. the SDK's own defaults of 10s/2).
- Data sent: only `answer_text` plus each entity's `name`/`aliases`/`domains` — never the repo, chat history, or unrelated PII. `describeDryRunPayload()` returns the exact object that would be sent, and the dry-run script prints it before anything is ever sent for real, satisfying "show the fields before real calls."
- A test (`classifier.test.ts`) verifies directly that adversarial text placed in `answer_text` never leaks into a question's `instructions` field — i.e., the injected instruction in the adversarial fixture case cannot alter model behavior through this code path, because state and instructions are structurally separate and we never concatenate the two.

Verified, not claimed: `npx vitest run` → **8/8 passed**; targeted `npx tsc --noEmit` on `apps/worker` → clean.

## ЭТАП 4 — testing

**Synthetic cases (prepared, run for real, no fabricated labels):** 7 cases in `fixtures.ts` — 2 ordinary, 2 ambiguous (negation, name collision), 2 insufficient_data, 1 adversarial/prompt-injection. Run via `run-dry-run.ts`; see `results.csv`.

Two concrete heuristic failures the dry run surfaced (facts, read directly from `results.csv`, not modeled):
- `"Elmo from Sesame Street is a popular children's character."` → heuristic reports `brandMentioned: true`. A same-word collision with no product context.
- `"This isn't about Profound at all — just general AEO advice..."` → heuristic reports competitor `Profound` mentioned, even though the sentence explicitly negates it.

**Interpretation, not fact:** these two cases *illustrate* the semantic gap Candidate A was chosen for. They are not evidence Jev classifies them correctly — no real Jev call was made, so nothing about Jev's actual accuracy is known yet.

**200 real examples (50 tune / 150 held-out), required by this ЭТАП: BLOCKED.** No `DATABASE_URL` is configured in this sandbox (no `.env` exists at all — see ЭТАП 2), so `promptRuns` cannot be queried for real historical answer text, and no human-reviewed ground truth exists anywhere in this repo for `analyzeMentions` output. Per the instruction not to invent missing records or treat unreviewed labels as ground truth, this step was not simulated. Fixing it needs: (a) DB access, (b) a real person to label a sample as "actually mentioned / not" for at least the 150 held-out rows.

**Real API comparison (Jev + fallback vs. current heuristic): not run.** Real calls are disabled by default per the constraints below and were not separately authorized.

## ЭТАП 5 — costs, quality, status

| | |
|---|---|
| Actual Jev spend this session | **$0** — fact: zero `systemOne` calls were made (dry-run only; confirmed by reading `classifyMentions`, which returns before constructing a client whenever `dryRun` is set) |
| Estimated cost per real run | **NOT_MEASURED** — no Jev pricing was found: `docs.typesafe.ai` is blocked from this sandbox, and no price appears in the installed SDK or the skill's bundled text |
| Scaling forecast | **NOT_MEASURED** — depends on the unknown unit cost above |
| One-off integration setup cost (engineering time) | **NOT_MEASURED** in money/hours (not tracked); factually: 1 new project-scoped plugin, 1 new pinned dependency, 5 new files (~230 lines) under `apps/worker/src/pilots/jev-mentions/`, 0 changes to existing job files |
| Classification quality | **not confirmed** — no ground truth (see ЭТАП 4) |
| Confident errors | NOT_MEASURED |
| Fallback share | 100% in this session (kill switch defaults off; the one `enabled: true` test run used `dryRun: true`, so even that never reached a real call) |
| Total pipeline time/cost | NOT_MEASURED (no end-to-end run against the live worker pipeline was performed) |

## Reproduce / disable

```bash
# tests
cd apps/worker && npx vitest run src/pilots/jev-mentions/classifier.test.ts

# type-check the pilot only
cd apps/worker && npx tsc --noEmit -p tsconfig.json

# dry run against the synthetic cases (writes ./results.csv at repo root if run from there)
pnpm --filter @workspace/worker exec tsx src/pilots/jev-mentions/run-dry-run.ts

# disable the pilot (this is also the default — no action needed unless JEV_PILOT_ENABLED was set)
unset JEV_PILOT_ENABLED   # or: export JEV_PILOT_ENABLED=false
```

## Diff for review

Uncommitted working-tree changes on top of `b437efc1`:
- `apps/worker/package.json` — one added line (`@typesafe-ai/sdk: 0.6.0`)
- `pnpm-lock.yaml` — the new dependency, plus incidental peer-annotation churn from running `pnpm install` in write mode (verified via `--frozen-lockfile` that the pre-existing lockfile was in sync before this change; no unrelated package was upgraded)
- `.claude/settings.json` — project-scoped marketplace + plugin registration only
- `apps/worker/src/pilots/jev-mentions/*` — new, isolated, unreferenced by the main pipeline
- `results.csv` (repo root) — dry-run output

## Final status

**SETUP_READY** — code and dry-run are prepared and verified (tests pass, type-checks clean, a real dry run against synthetic cases produced the expected payload shapes with zero network calls).

Not claimed: **API_VERIFIED** (blocked — no `TYPESAFE_API_KEY` and no separate spend authorization), **BENCHMARK_VERIFIED** (blocked — no real labeled dataset reachable in this sandbox, see ЭТАП 4). **NO_BENEFIT** is not asserted either — nothing here disproves benefit, it simply hasn't been measured yet.

**Concrete remaining blockers, to move past SETUP_READY:**
1. A `TYPESAFE_API_KEY` plus an explicit go-ahead on what data may be sent and a request/dollar budget (per the constraints — real calls stayed off by default).
2. Either DB access in an environment with real `promptRuns` data, or a manually assembled, honestly-sourced set of ≥150 held-out examples with human labels, to make BENCHMARK_VERIFIED possible without inventing ground truth.
