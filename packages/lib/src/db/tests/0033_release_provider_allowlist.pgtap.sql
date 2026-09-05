-- Run only against a disposable database after migration 0033 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(11);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('selena-provider-owner', 'Selena provider owner', 'selena-provider-owner@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('selena-provider-org', 'Selena provider org', 'selena-provider-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES ('selena-provider-member', 'selena-provider-org', 'selena-provider-owner', 'owner', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES ('selena-provider-brand', 'Selena provider brand', 'https://provider.example.invalid', 'selena-provider-org');

SET ROLE selena_backup_restore;
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by)
VALUES ('75000000-0000-0000-0000-000000000001', 'selena-provider-org', 'selena-provider-brand', 'Provider material', 'seed');
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url, evidence, disclosure, policy_version, content_hash, created_by
) VALUES (
  '75000000-0000-0000-0000-000000000002', 'selena-provider-org', 'selena-provider-brand', '75000000-0000-0000-0000-000000000001',
  1, 'A reviewed provider material', 'https://provider.example.invalid/material', '[]'::jsonb, '{}', 'provider-v1', repeat('a', 64), 'seed'
);
INSERT INTO selena_registry.channel_accounts (
  id, organization_id, brand_id, platform, provider_account_ref, provider_integration_id, status, allowlisted, created_by
) VALUES (
  '75000000-0000-0000-0000-000000000003', 'selena-provider-org', 'selena-provider-brand', 'linkedin_page',
  'Selena Systems LinkedIn Page', 'linkedin-page-only', 'ACTIVE', true, 'seed'
);
INSERT INTO selena_registry.approvals (
  id, organization_id, brand_id, content_version_id, channel_account_id, decision,
  binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id, expires_at, created_at
) VALUES (
  '75000000-0000-0000-0000-000000000004', 'selena-provider-org', 'selena-provider-brand', '75000000-0000-0000-0000-000000000002',
  '75000000-0000-0000-0000-000000000003', 'APPROVED', repeat('b', 64), repeat('a', 64), repeat('c', 64), 'provider-v1', repeat('d', 64),
  'selena-provider-owner', now() + interval '1 hour', now()
);
INSERT INTO selena_registry.channel_provider_bindings (
  id, organization_id, brand_id, channel_account_id, provider, environment, active, created_by
) VALUES (
  '75000000-0000-0000-0000-000000000005', 'selena-provider-org', 'selena-provider-brand',
  '75000000-0000-0000-0000-000000000003', 'postiz', 'STAGING', true, 'seed'
);
RESET ROLE;

-- A provider name nobody wrote a migration for cannot enter the table.
SET ROLE selena_backup_restore;
SELECT throws_ok(
  $$INSERT INTO selena_registry.channel_provider_bindings (
      organization_id, brand_id, channel_account_id, provider, environment, active, created_by
    ) VALUES ('selena-provider-org', 'selena-provider-brand', '75000000-0000-0000-0000-000000000003',
              'blotatoo', 'STAGING', false, 'seed')$$,
  '23514',
  NULL,
  'an unknown provider name is refused by the allowlist'
);
RESET ROLE;

-- Postiz is not removed when Blotato arrives: the second provider is staged
-- inactive next to the first, so the switch is one flag rather than a delete.
SET ROLE selena_backup_restore;
INSERT INTO selena_registry.channel_provider_bindings (
  id, organization_id, brand_id, channel_account_id, provider, environment, active, created_by
) VALUES (
  '75000000-0000-0000-0000-000000000006', 'selena-provider-org', 'selena-provider-brand',
  '75000000-0000-0000-0000-000000000003', 'blotato', 'STAGING', false, 'seed'
);
RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM selena_registry.channel_provider_bindings
    WHERE channel_account_id = '75000000-0000-0000-0000-000000000003' AND environment = 'STAGING'),
  2,
  'both providers are bound to the same channel and environment'
);
SELECT is(
  (SELECT count(*)::int FROM selena_registry.channel_provider_bindings
    WHERE channel_account_id = '75000000-0000-0000-0000-000000000003' AND environment = 'STAGING' AND active),
  1,
  'exactly one of them is active'
);

SET ROLE selena_backup_restore;
SELECT throws_ok(
  $$UPDATE selena_registry.channel_provider_bindings SET active = true
     WHERE id = '75000000-0000-0000-0000-000000000006'$$,
  '23505',
  NULL,
  'two providers cannot be active on one channel and environment at once'
);
RESET ROLE;

-- Switching is a single flag change in one transaction, not a delete and a
-- re-create that would leave the channel unbound in between.
SET ROLE selena_backup_restore;
UPDATE selena_registry.channel_provider_bindings SET active = false WHERE id = '75000000-0000-0000-0000-000000000005';
UPDATE selena_registry.channel_provider_bindings SET active = true WHERE id = '75000000-0000-0000-0000-000000000006';
RESET ROLE;
SELECT is(
  (SELECT provider FROM selena_registry.channel_provider_bindings
    WHERE channel_account_id = '75000000-0000-0000-0000-000000000003' AND environment = 'STAGING' AND active),
  'blotato',
  'staging now releases through Blotato'
);
SELECT is(
  (SELECT count(*)::int FROM selena_registry.channel_provider_bindings
    WHERE channel_account_id = '75000000-0000-0000-0000-000000000003' AND provider = 'postiz'),
  1,
  'the Postiz binding is still there, only inactive'
);
SELECT is(
  (SELECT count(*)::int FROM selena_registry.channel_provider_bindings
    WHERE channel_account_id = '75000000-0000-0000-0000-000000000003' AND environment = 'PRODUCTION'),
  0,
  'choosing Blotato for staging binds nothing in production'
);

-- The owner acceptance case: queueing the same release ten times must leave one
-- intent and one pending event behind. This repeats what the queue path does —
-- insert the intent, and only append the outbox event when the intent was new.
DO $$
DECLARE
  v_intent uuid;
  i int;
BEGIN
  SET LOCAL ROLE selena_backup_restore;
  FOR i IN 1..10 LOOP
    INSERT INTO selena_release.release_intents (
      organization_id, brand_id, content_version_id, approval_id, channel_account_id,
      platform, idempotency_key, correlation_id, created_by
    ) VALUES (
      'selena-provider-org', 'selena-provider-brand', '75000000-0000-0000-0000-000000000002',
      '75000000-0000-0000-0000-000000000004', '75000000-0000-0000-0000-000000000003',
      'linkedin_page', 'provider-acceptance-key', gen_random_uuid(), 'seed'
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_intent;
    IF v_intent IS NOT NULL THEN
      INSERT INTO selena_release.outbox_events (
        organization_id, brand_id, release_intent_id, event_type, event_version, idempotency_key
      ) VALUES (
        'selena-provider-org', 'selena-provider-brand', v_intent, 'release.intent_queued', 1,
        'provider-acceptance-outbox'
      );
    END IF;
  END LOOP;
END $$;

SELECT is(
  (SELECT count(*)::int FROM selena_release.release_intents WHERE idempotency_key = 'provider-acceptance-key'),
  1,
  'ten identical queue attempts leave exactly one release intent'
);
SELECT is(
  (SELECT count(*)::int FROM selena_release.outbox_events
    WHERE release_intent_id = (SELECT id FROM selena_release.release_intents WHERE idempotency_key = 'provider-acceptance-key')),
  1,
  'and exactly one outbox event'
);
SELECT is(
  (SELECT status::text FROM selena_release.outbox_events
    WHERE release_intent_id = (SELECT id FROM selena_release.release_intents WHERE idempotency_key = 'provider-acceptance-key')),
  'PENDING',
  'the single event is pending, so nothing was dispatched'
);
SELECT is(
  (SELECT count(*)::int FROM selena_release.publication_attempts),
  0,
  'no publication attempt was recorded'
);

SELECT * FROM finish();
ROLLBACK;
