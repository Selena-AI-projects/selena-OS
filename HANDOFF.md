# Handoff — Selena Systems measurement app

Start here when opening a fresh session on this repository. The company-wide
handoff (product, site, funnel, both repositories in one place) lives in
`parkourcafe/SELENA-AI-COMPANY`, file `HANDOFF.md`.

Read `AGENTS.md` first — it is the working contract for this repo. Then
`SELENA_OWNER_OPERATING_GUIDE.md`, which is the owner's own operating manual and
the only place that describes what turns spend on.

## What this repository is

A fork of Elmo, an open-source AI visibility platform, carrying the Selena
measurement product on top of it. Everything Selena-specific is prefixed `sv_`
in the database and `selena-` in file names; the Elmo product underneath is
still present and still builds.

## Where it runs

- **Railway**, built from `docker/Dockerfile`, two services: `web` and `worker`.
- **Postgres on Railway.** No Supabase here.
- The staging environment serves `app.selenasystems.com`.
- The integration branch is `release/selena-visibility-mvp`, **not** `main`.
  Pull requests target it.

## The two measurement channels

They are different observations and are never averaged together.

- **Visitor View** — what a person is shown by ChatGPT, Gemini or Perplexity.
  Runs through Bright Data, one collector per surface. Sold as the $49 plan.
- **API View** — the model answering from its own knowledge, no web search.
  Runs through OpenRouter. Part of the $79 plan.

## State as of 25 August 2026

- API View has produced a real, paid measurement. Measured cost per answer:
  **$0.00171**.
- Visitor View has **never completed a run**. Everything is wired and three
  faults in that path were fixed on 25 August (surface naming, the missing
  extraction resolver, one adapter name for a multi-surface plan) — but no run
  has proven it end to end. That is the next thing to do.
- Free auto-dispatch of promo-code orders is built and **switched off**
  (`SELENA_FREE_AUTO_DISPATCH_ENABLED`). It stays off until one Visitor View
  run succeeds by hand, or the first customer gets an automated failure.

## Owner variables

Names only; values live in Railway. The owner guide explains each one.

| Service | Variable |
|---|---|
| worker | `SELENA_MEASUREMENT_ENABLED`, `SELENA_MEASUREMENT_ADAPTER`, `BRIGHTDATA_API_TOKEN`, `OPENROUTER_API_KEY` |
| web | `SELENA_MEASUREMENT_ENABLED`, `SELENA_PAYMENTS_ENABLED`, `SELENA_PROMO_CODES`, `SELENA_FREE_AUTO_DISPATCH_ENABLED` |

`SELENA_MEASUREMENT_ADAPTER=brightdata` and `=auto` are **families** that route
per permit; a plain name pins one adapter for every permit and mismeasures a
multi-surface order.

## Working notes

- Migrations are never run without the owner asking.
- The owner is not a developer and works by voice. Do the work rather than
  handing back instructions; when something genuinely needs her (a Railway
  variable, a provider account), say exactly what to click and why.
