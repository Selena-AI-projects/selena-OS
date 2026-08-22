# Selena AI Visibility — running one paid order

The path a single paid order takes today, from the first message to the
delivered report. Steps marked **manual** are done by a person because the
automation for them is deliberately still gated; the rest already happen in the
application. Work top to bottom and do not skip a gate: every one of them exists
to stop spend or an unsupported claim.

## 0. Before the first order of the day

- `SCHEDULE_MAINTENANCE_ENABLED=false` and `SELENA_PROVIDER_BUDGET_USD` are set
  on the deployment (see the spend-guard section of the owner guide).
- Provider accounts have their own hard spend limits set.
- A test lead has reached the inbox: submit the public contact form once and
  confirm the Telegram or webhook delivery actually arrives. A lead that never
  lands is the failure mode no gate below can catch.

## 1. Lead arrives — **manual**

The public form delivers to Telegram/webhook. Reply the same day; the offer on
the site promises no timeline, so the first answer sets the expectation.

## 2. Scope call — **manual**

Collect and write down, in the client's own words:

- brand name and every spelling variant customers actually use;
- primary domain, plus any other domains the brand owns;
- category, country, city or district;
- languages to measure;
- competitors to track;
- the questions a customer would really ask an AI assistant.

Turn the questions into scenarios and read them back. The client confirms the
list — that confirmation is what the configuration lock records.

## 3. Quote and payment — **manual**

Online checkout is off, so invoice outside the application. Quote from the
published catalog; do not improvise a price. Record the payment in the
application once the money has actually arrived: the order moves to
`PAID_REVIEW_REQUIRED`, never straight to approved.

## 4. Preflight and approval — in the app

Open the admin order queue and read the preflight panel. Approve is disabled
until every rule is green: order paid and awaiting review, a lock whose scope
matches its expected run count, no active permits or runs, maintenance idle,
worst-case cost inside both the order cap and the provider budget.

A red rule is information, not an obstacle to route around. If the scope does
not match the lock, fix the scope and issue a new lock rather than approving
anything.

Approving mints exactly the run permits the lock implies and moves the order to
`QUEUED`.

## 5. Measurement — **manual today**

The executing worker is built but off: no live provider adapter is registered
and the measurement flag is disabled. Until the owner turns that on, run the
cycle the way the Usha pilot was run, then record the outcomes.

Never run more than the approved cardinality. If a run comes back empty,
truncated, in the wrong language or timed out, mark it invalid with its reason;
a single targeted retry is allowed, a full re-run of the scenario is not.

## 6. Quality control — **manual**

Read a reproducible sample of the answers and check, by hand:

- is a mention really the brand, or a similarly named business;
- does a citation actually point at an owned page;
- are there factual errors about the business in the answer;
- do Visitor View and API View disagree in a way worth reporting.

Record the QC decision in the application. Expert Verified is not deliverable
without it — that record is what the tier's promise rests on.

## 7. Delivery — **manual**

Export the evidence ledger and build the client documents from the same dataset
version. Check the row count matches the approved cardinality before anything
goes out.

In the report, keep the boundaries the site already states: report counts with
their denominator and date, keep Visitor View and API View apart, never present
readiness as observed visibility, and never promise rankings or recommendations.

## 8. After delivery

- For Implementation + 90 days: schedule the implementation hours and put the
  remeasurement date in the calendar with the same locked scope.
- For the subscriptions: the monthly repeat is a manual cycle today. Diary it.
  Do not let a month pass silently — the client bought a repeat.
- Compare the provider invoice against the estimated costs and re-tune
  `SELENA_PROVIDER_BUDGET_USD` if reality disagrees.

## What to say when a client asks "is this automatic?"

It is honest and enough to say: measurement runs against a fixed, dated set of
questions through named AI systems, every answer is kept as evidence, and a
human reviews the sample before the report is approved. Do not describe the
monthly repeat as hands-off while it is still driven by a person.
