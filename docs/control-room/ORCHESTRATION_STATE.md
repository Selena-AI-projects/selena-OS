# Orchestration state

## Where the programme is

| Slice | State | Head | Merge |
|---|---|---|---|
| 1 — profile and draft YouTube target | MERGED | `45dd3b96` | `313daa0c` |
| 2 — research | MERGED | `52741ae` | `86a0a633` |
| 3 — ideas and scripts | MERGED | `3a6c9cd` | `58daa20f` |
| 4 — thumbnails and editorial approval | MERGED | PR #44, merge `07fdc84`, all 7 required checks green | editorial decisions on the latest version; CLEAN-gated asset bundle; no release authority |
| 5 — local vertical acceptance | PARTIAL — disposable-database class recorded | workflow "Stage 1 Acceptance" run #1 (2026-09-07, Success, artifact `stage1-acceptance-evidence`) | fixture vertical with `externalProviderCalls = 0` three ways; browser-evidence class still open |

## Gates still open

- **Shared-database migration order — resolved on merge.** The growth line
  (`0038` through `0041`, applied on staging) comes first in the journal; the
  research and structured-content migrations are `0042` and `0043` with later
  `when` values. Drizzle applies by `when` as a strict high-water mark; the
  migration runner on `main` now refuses a pending migration that would be
  skipped, and the read-only inspector reports it before anything runs.
- **No required CI check runs pgTAP or the integration harness.** The RLS these
  slices depend on is defended by suites somebody has to run by hand.
- **No required CI check runs the formatter or the linter.** Adding one is not a
  wiring change: `biome check .` reports 323 errors and 358 warnings across the
  repository as it stands, so a lint gate would have to be preceded by a
  repository-wide cleanup that is not this programme's to make. Recorded here
  rather than fixed, because a reformatting of the migration journal already
  reached a pushed commit once and nothing in CI saw it.

## Carried from Slice 3's round-three review

- ~~**`run-pgtap.sh` cannot see a plan mismatch.**~~ Fixed. The diagnostic is
  ` # Looks like you planned N tests but ran M`, observed by deliberately
  mis-declaring a plan, and the harness now counts it. The same run established
  that the harness did not provision `anon`, `authenticated` or `service_role`,
  so suites `0021` and `0023` aborted on a bare cluster with errors that read
  like schema breakage; it provisions them now. Full chain `0000..0041` on a
  disposable cluster: `assertions=353 failures=0`.
- **The vendored-licence digest is self-referential.** `vendored/sources.ts`
  compares `LICENSE` against a digest declared in the same manifest. That catches
  drift and replacement, both demonstrated by falsification, but it cannot
  establish that the digest is the one at the upstream commit. Establishing that
  needs a check against `parkourcafe/youtube-pro`, which is outside the
  repository scope the reviewing sessions run under.

## Owner decisions waiting

- **Revoking a confirmed profile does not stop work.** Research and creation fall
  back to the previous still-confirmed version, and the surface presents that
  older version as confirmed. Inherited from Slice 1's `profiles.getCurrent`.
  Recorded in `DECISION_LOG.md`; the behaviour is pinned by tests either way, so
  it can be changed without guesswork once decided.

## Carried into Slice 4

The shared app shell's sidebar trigger is 28 px square, below the 44 px the
mobile matrix asks of a tap target. It is a `packages/ui` component every route
inherits, so fixing it in a content slice would change every surface in the
product on a content branch. The Slice 3 browser run records it at 390 px on
both new surfaces rather than excluding it.

Two findings from Slice 2's round-six review, both symmetric in cost across the
merge that closed it:

- an empty or whitespace-only `sourceUrl` is still reported as
  `MISSING_PROVENANCE` rather than as an unrenderable url;
- the `[:space:]` character class the drop-early property relies on is resolved
  through the database's ctype, and no test pins the direction of that asymmetry.
