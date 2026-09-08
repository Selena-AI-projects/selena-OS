BEGIN;

SELECT plan(34);

SELECT has_table('selena_registry', 'provider_budgets', 'provider budgets table exists');
SELECT has_table('selena_registry', 'provider_call_ledger', 'provider call ledger table exists');
SELECT ok(to_regtype('selena_registry.budget_window') IS NOT NULL, 'budget window enum exists');
SELECT ok(to_regtype('selena_registry.provider_call_status') IS NOT NULL, 'provider call status enum exists');

SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'selena_registry.provider_budgets'::regclass),
  'provider budgets force RLS'
);
SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'selena_registry.provider_call_ledger'::regclass),
  'provider call ledger forces RLS'
);
SELECT is((SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'selena_registry' AND tablename = 'provider_budgets'), 5, 'provider budget policies are explicit');
SELECT is((SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'selena_registry' AND tablename = 'provider_call_ledger'), 3, 'provider call ledger policies are explicit');
SELECT is((SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = 'selena_registry.provider_budgets'::regclass AND NOT tgisinternal), 1, 'provider budgets are append-only');
SELECT is((SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = 'selena_registry.provider_call_ledger'::regclass AND NOT tgisinternal), 1, 'provider call ledger transitions are guarded');

INSERT INTO public."user" (id, name, email, created_at, updated_at)
VALUES
  ('budget-owner', 'Budget Owner', 'budget-owner@example.test', now(), now()),
  ('budget-member', 'Budget Member', 'budget-member@example.test', now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('budget-org', 'Budget Org', 'budget-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES
  ('budget-owner-membership', 'budget-org', 'budget-owner', 'owner', now()),
  ('budget-member-membership', 'budget-org', 'budget-member', 'member', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES
  ('budget-brand-a', 'Budget Brand A', 'https://a.example.test', 'budget-org'),
  ('budget-brand-b', 'Budget Brand B', 'https://b.example.test', 'budget-org');

SET LOCAL ROLE selena_web_runtime;
SELECT selena_registry.set_request_context(
  'budget-owner', 'budget-org', 'budget-brand-a', 'owner',
  '60000000-0000-4000-8000-000000000010', 'web', 'session'
);

SELECT lives_ok(
  $$INSERT INTO selena_registry.provider_budgets (
    organization_id, brand_id, provider_id, window_kind, ceiling_calls, ceiling_cost_micros, set_by
  ) VALUES ('budget-org', 'budget-brand-a', 'gemini', 'DAY', 100, 2000000, 'budget-owner')$$,
  'an interactive owner can set a provider budget'
);

-- Budgets are append-only from the web runtime's side twice over: no UPDATE or
-- DELETE grant exists at all.
SELECT throws_matching(
  $$UPDATE selena_registry.provider_budgets SET ceiling_calls = 1000000$$,
  'permission denied',
  'the web runtime cannot raise a budget in place'
);
SELECT throws_matching(
  $$DELETE FROM selena_registry.provider_budgets$$,
  'permission denied',
  'the web runtime cannot delete a budget'
);

-- A member session on the same brand may not set a budget: the INSERT policy
-- requires an interactive owner.
SELECT selena_registry.set_request_context(
  'budget-member', 'budget-org', 'budget-brand-a', 'member',
  '60000000-0000-4000-8000-000000000011', 'web', 'session'
);
SELECT throws_ok(
  $$INSERT INTO selena_registry.provider_budgets (
    organization_id, brand_id, provider_id, window_kind, ceiling_calls, ceiling_cost_micros, set_by
  ) VALUES ('budget-org', 'budget-brand-a', 'gemini', 'DAY', 10, 100000, 'budget-member')$$,
  42501,
  'new row violates row-level security policy for table "provider_budgets"',
  'a member cannot set a provider budget'
);

SELECT selena_registry.set_request_context(
  'budget-owner', 'budget-org', 'budget-brand-a', 'owner',
  '60000000-0000-4000-8000-000000000012', 'web', 'session'
);

-- No budget row, no reservation: money may not move on a provider the owner
-- never budgeted.
SELECT throws_matching(
  $$SELECT selena_registry.reserve_provider_call(
    'budget-brand-a', 'video-radar', 'research.run', 'no-budget-key', 5, 25000, NULL)$$,
  'PROVIDER_BUDGET_MISSING',
  'a reservation without a budget is refused'
);

-- Zero or unknown estimates are refused outright rather than counted as free.
SELECT throws_matching(
  $$SELECT selena_registry.reserve_provider_call(
    'budget-brand-a', 'gemini', 'creation.IDEAS', 'zero-calls-key', 0, 200000, NULL)$$,
  'UNKNOWN_COST_BLOCKED',
  'a reservation with zero estimated calls is refused'
);
SELECT throws_matching(
  $$SELECT selena_registry.reserve_provider_call(
    'budget-brand-a', 'gemini', 'creation.IDEAS', 'null-cost-key', 5, NULL, NULL)$$,
  'UNKNOWN_COST_BLOCKED',
  'a reservation with an unknown cost estimate is refused'
);

-- Both calls carry the same idempotency key; the second returns the first's
-- row rather than reserving twice.
SELECT is(
  selena_registry.reserve_provider_call('budget-brand-a', 'gemini', 'creation.IDEAS', 'key-1', 10, 200000, NULL),
  selena_registry.reserve_provider_call('budget-brand-a', 'gemini', 'creation.IDEAS', 'key-1', 10, 200000, NULL),
  'a repeated idempotency key returns the same reservation id'
);

CREATE TEMP TABLE budget_test_ids AS
SELECT id FROM selena_registry.provider_call_ledger WHERE idempotency_key = 'key-1';

SELECT is(
  (SELECT status FROM selena_registry.provider_call_ledger WHERE idempotency_key = 'key-1'),
  'RESERVED'::selena_registry.provider_call_status,
  'a fresh reservation is RESERVED'
);
SELECT is(
  (SELECT reserved_by FROM selena_registry.provider_call_ledger WHERE idempotency_key = 'key-1'),
  'budget-owner',
  'the reservation records the session actor as its reserver'
);

-- 10 of 100 calls are committed. 200 more do not fit, and neither does a call
-- whose estimated cost exhausts the cost ceiling on its own.
SELECT throws_matching(
  $$SELECT selena_registry.reserve_provider_call(
    'budget-brand-a', 'gemini', 'creation.IDEAS', 'over-calls-key', 200, 200000, NULL)$$,
  'PROVIDER_QUOTA_EXCEEDED',
  'a reservation over the call ceiling is refused'
);
SELECT throws_matching(
  $$SELECT selena_registry.reserve_provider_call(
    'budget-brand-a', 'gemini', 'creation.IDEAS', 'over-cost-key', 5, 5000000, NULL)$$,
  'PROVIDER_QUOTA_EXCEEDED',
  'a reservation over the cost ceiling is refused'
);

SELECT lives_ok(
  $$SELECT selena_registry.settle_provider_call(
    (SELECT id FROM budget_test_ids), 'DISPATCHED', NULL, NULL, NULL)$$,
  'a reservation advances to DISPATCHED'
);
SELECT is(
  (SELECT status FROM selena_registry.provider_call_ledger WHERE idempotency_key = 'key-1'),
  'DISPATCHED'::selena_registry.provider_call_status,
  'the dispatch is recorded'
);
SELECT lives_ok(
  $$SELECT selena_registry.settle_provider_call(
    (SELECT id FROM budget_test_ids), 'SETTLED', 10, 200000, NULL)$$,
  'a dispatched call settles'
);
SELECT is(
  (SELECT status FROM selena_registry.provider_call_ledger WHERE idempotency_key = 'key-1'),
  'SETTLED'::selena_registry.provider_call_status,
  'the settlement is recorded'
);
SELECT is(
  (SELECT actual_calls FROM selena_registry.provider_call_ledger WHERE idempotency_key = 'key-1'),
  10,
  'the settlement carries the actual call count'
);

SELECT throws_matching(
  $$SELECT selena_registry.settle_provider_call(
    (SELECT id FROM budget_test_ids), 'RESERVED', NULL, NULL, NULL)$$,
  'illegal provider call transition',
  'a settled call cannot be re-opened as RESERVED'
);

-- Cross-brand isolation: a sibling brand's session sees nothing and settles
-- nothing, even holding the real reservation id.
SELECT selena_registry.set_request_context(
  'budget-owner', 'budget-org', 'budget-brand-b', 'owner',
  '60000000-0000-4000-8000-000000000020', 'web', 'session'
);
SELECT is(
  (SELECT count(*)::integer FROM selena_registry.provider_call_ledger),
  0,
  'a sibling brand sees none of the first brand''s ledger rows'
);
SELECT throws_matching(
  $$SELECT selena_registry.settle_provider_call(
    (SELECT id FROM budget_test_ids), 'FAILED', NULL, NULL, 'FORGED')$$,
  'PROVIDER_CALL_NOT_FOUND',
  'a sibling brand cannot settle another brand''s reservation'
);

RESET ROLE;

-- The append-only and transition guards are triggers, so bypassing row
-- security does not unlock them.
SELECT throws_matching(
  $$UPDATE selena_registry.provider_budgets SET ceiling_calls = 1000000$$,
  'append-only',
  'a budget cannot be rewritten even with row security bypassed'
);
SELECT throws_matching(
  $$DELETE FROM selena_registry.provider_budgets$$,
  'append-only',
  'a budget cannot be deleted even with row security bypassed'
);
SELECT throws_matching(
  $$UPDATE selena_registry.provider_call_ledger SET estimated_calls = 999
    WHERE id = (SELECT id FROM budget_test_ids)$$,
  'immutable',
  'a reservation''s identity cannot be rewritten'
);
SELECT throws_matching(
  $$DELETE FROM selena_registry.provider_call_ledger$$,
  'never deleted',
  'ledger rows are never deleted'
);

SELECT * FROM finish();
ROLLBACK;
