# Orchestration state

## Where the programme is

| Slice | State | Head | Merge |
|---|---|---|---|
| 1 — profile and draft YouTube target | MERGED | `45dd3b96` | `313daa0c` |
| 2 — research | MERGED | `52741ae` | `86a0a633` |
| 3 — ideas and scripts | IN REVIEW | `feat/content-os-slice3-creation` | — |
| 4 — thumbnails and editorial approval | NOT STARTED | — | — |
| 5 — local vertical acceptance | NOT STARTED | — | — |

## Gates still open

- **Shared-database migration order.** `growth/ge1-4-local-slice` holds `0038` and
  `0039` at a lower journal `when` than Content OS `0040`/`0041`. Drizzle applies
  by `when` as a strict high-water mark, so a database that receives `0040` first
  skips both **silently and permanently**. Held by `OWNER_GATES.md` and a person,
  not by code: the refusal guard lives on the growth branch.
- **No required CI check runs pgTAP or the integration harness.** The RLS these
  slices depend on is defended by suites somebody has to run by hand.
- **No required CI check runs the formatter or the linter.** Adding one is not a
  wiring change: `biome check .` reports 326 errors and 358 warnings across the
  repository as it stands, so a lint gate would have to be preceded by a
  repository-wide cleanup that is not this programme's to make. Recorded here
  rather than fixed, because a reformatting of the migration journal already
  reached a pushed commit once and nothing in CI saw it.

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
