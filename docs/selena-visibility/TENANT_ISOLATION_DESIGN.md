# Tenant isolation — design (Фаза 5, TZ v1.3-impl)

Design only. Every item below needs either a migration or a change across many
handlers, and both are owner gates: nothing here has been applied, and no
migration in this branch has been run. The order matters — 4 depends on 1.

Verified against the branch on 2026-08-21; each "current state" line is a
statement about code that was read, not an assumption.

---

## 1. DS-P0-15 — `reports` has no owning organization

**Current state.** `reports` carries `brand_name` / `brand_website` and no
organization column. `requireReportAccess` in `apps/web/src/server/reports.ts`
therefore refuses every non-admin outright — a stop-gap that keeps the list,
detail and raw queries from returning other tenants' rows by making the whole
generator an operator capability. It is a patch, not scoping: an admin still
reads across tenants, and a legitimate report-enabled customer reads nothing.

**Target.**

```sql
ALTER TABLE "reports" ADD COLUMN "organization_id" text REFERENCES "organization"("id");
CREATE INDEX "reports_organization_idx" ON "reports" ("organization_id");
```

Nullable on purpose. Existing rows have no recoverable owner — the brand name
on them is free text, not a foreign key, so inferring an organization from it
would attribute one tenant's report to another on a name collision. Instead:

- `NULL` means *legacy, unattributed*, and stays admin-only forever.
- Every write path sets the column from the session's organization; a new row
  with `NULL` is a bug, and the follow-up migration that adds `NOT NULL` is
  only safe once the legacy rows are either attributed by hand or deleted.

**Scoping change.** `requireReportAccess` drops the `isAdmin` line and returns
the organization; the three queries gain
`eq(reports.organizationId, organizationId)`, and an admin reading legacy rows
uses a separate, explicit path rather than the customer one.

**Order.** Column and backfill decision first, then the write paths, then the
read scoping, then `NOT NULL`. Removing the admin gate before the reads are
scoped re-opens the cross-tenant read it exists to prevent.

---

## 2. DS-P1-28 — prompts fetched by id before the caller is authorized

**Current state.** Three handlers in `apps/web/src/server/prompts.ts` read a
prompt with `eq(prompts.id, data.promptId)` and no tenant predicate. All three
do authorize afterwards — two call `requireBrandAccess` on the prompt's own
`brandId`, and `getPromptChartDataFn` checks both `requireBrandAccess` on the
supplied `brandId` and that the prompt belongs to it — so none of them was
observed to return foreign data.

The defect is the shape, not a live leak: authorization sits after the read, in
handler code, and a fourth handler written the same way that returns before
reaching its check would leak silently. Nothing in the type system or the query
prevents it.

**Target.** One scoped read, and no unscoped one:

```ts
promptForUser(userId, promptId) // joins prompts → brands → organization → member
```

returning `undefined` for both "no such prompt" and "not yours" — the caller
has no business distinguishing them, the same rule
`requireBrandOrganization` already follows. Handlers take the prompt or throw;
`eq(prompts.id, ...)` without a tenant join becomes something a review can
grep for.

---

## 3. DS-P1-10 — a viewer can mutate

**Current state.** `requireBrandAccess(userId, brandId)` answers *is this user
in the brand's organization*, with no role in the verdict, and the mutating
brand and prompt server functions call exactly that. A member whose role is
`viewer` passes it. The Selena repositories are not affected: every mutation
there goes through `writable(ctx)` (24 call sites), which refuses `viewer` and
an API key without `client:write`.

**Target.** `requireBrandRole(userId, brandId, allowed)` built on the existing
`requireBrandOrganization`, which already resolves `member.role` in the same
query the access check would have spent anyway. Reads keep
`requireBrandAccess`; every mutation states the roles it accepts. The fix costs
no extra query.

---

## 4. P1-13 — RLS is enabled and inert

**Current state.** 45 tables declare `enableRLS()` and the migrations issue
`ALTER TABLE … ENABLE ROW LEVEL SECURITY` for all 45. There is not one
`CREATE POLICY` in any migration, and the application connects with the role
that owns the tables. A table owner bypasses RLS unless the table is set to
`FORCE ROW LEVEL SECURITY`; with no policies and an owning connection, RLS
currently blocks nothing. Isolation today rests entirely on the
`organizationId` predicates in `packages/lib/src/selena-visibility-repositories.ts`.

That is not worthless — those predicates are real and tested — but it means one
forgotten `.where` is a cross-tenant read with nothing behind it.

**Target.**

1. A runtime role that does **not** own the tables and is not `BYPASSRLS`;
   migrations keep running as the owner.
2. `ALTER TABLE … FORCE ROW LEVEL SECURITY` on the tenant tables, so the owner
   is subject to its own policies too.
3. One policy shape per tenant table:

   ```sql
   CREATE POLICY "tenant_isolation" ON "sv_runs"
     USING ("organization_id" = current_setting('app.organization_id', true));
   ```

4. `SET LOCAL app.organization_id = $1` at the start of every request
   transaction, from the resolved auth context.

**Risks, in the order they will bite.**

- `SET LOCAL` is transaction-scoped, and the app runs plenty of queries outside
  an explicit transaction. Either every tenant query moves inside one, or the
  setting is applied per pooled connection — which is unsafe with a shared pool
  unless it is reset on release.
- A missing GUC makes `current_setting(..., true)` return NULL and the policy
  match nothing: the failure mode is an empty result set, not an error. That is
  the safe direction, and it is also how a silent outage looks. Any rollout
  needs a check that a request without the setting fails loudly in
  non-production.
- Background jobs and the worker have no session; they need an explicit
  organization on every job payload, which the Selena jobs already carry.
- Tables with no `organization_id` (`reports`, until item 1 lands) cannot get a
  policy at all. Item 1 is a prerequisite, not a parallel track.

**Sequencing.** Policies and `FORCE` are useless without the runtime role, and
dangerous without the GUC plumbing; the plumbing is harmless on its own. Ship
the GUC first and observe it, then the role, then `FORCE` plus policies table by
table, starting with `sv_*`.
