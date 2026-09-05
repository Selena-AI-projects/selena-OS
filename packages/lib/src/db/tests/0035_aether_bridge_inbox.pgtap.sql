-- Run only against a disposable database after migration 0035 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(13);

-- The receiver holds a credential and faces the public internet, so what it can
-- do to the database is asserted rather than assumed.
SELECT ok(
  NOT has_table_privilege('selena_ingestion_runtime', 'selena_ingest_raw.aether_events', 'INSERT')
  AND NOT has_table_privilege('selena_ingestion_runtime', 'selena_ingest_raw.aether_events', 'UPDATE')
  AND NOT has_table_privilege('selena_ingestion_runtime', 'selena_ingest_raw.aether_events', 'DELETE'),
  'the ingestion runtime cannot touch the inbox table directly'
);
SELECT ok(
  has_function_privilege('selena_ingestion_runtime',
    'selena_ingest_raw.record_aether_event(uuid, text, text, uuid, uuid, integer, timestamptz, uuid, jsonb, text)',
    'EXECUTE'),
  'the ingestion runtime records events through the function'
);

-- The Control Room displays these events; a receiver bug must not become a
-- Control Room that can forge one.
SELECT ok(
  has_column_privilege('selena_web_runtime', 'selena_ingest_raw.aether_events', 'payload', 'SELECT'),
  'the web runtime can read the event payload it renders'
);
SELECT ok(
  NOT has_table_privilege('selena_web_runtime', 'selena_ingest_raw.aether_events', 'INSERT')
  AND NOT has_table_privilege('selena_web_runtime', 'selena_ingest_raw.aether_events', 'UPDATE')
  AND NOT has_table_privilege('selena_web_runtime', 'selena_ingest_raw.aether_events', 'DELETE'),
  'the web runtime reads Aether events and never writes them'
);
SELECT ok(
  NOT has_function_privilege('selena_web_runtime',
    'selena_ingest_raw.record_aether_event(uuid, text, text, uuid, uuid, integer, timestamptz, uuid, jsonb, text)',
    'EXECUTE'),
  'the web runtime cannot record an event of its own'
);
SELECT ok(
  NOT has_function_privilege('public',
    'selena_ingest_raw.record_aether_event(uuid, text, text, uuid, uuid, integer, timestamptz, uuid, jsonb, text)',
    'EXECUTE'),
  'no other role inherits the recording function'
);

SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'selena_ingest_raw.aether_events'::regclass),
  'row level security is on for the inbox'
);

-- Behaviour of the recording function itself, exercised as the runtime.
SET LOCAL ROLE selena_ingestion_runtime;
SELECT set_config('app.selena_service_identity', 'ingestion', true);
SELECT set_config('app.selena_auth_type', 'service', true);

SELECT is(
  (SELECT outcome FROM selena_ingest_raw.record_aether_event(
    '11111111-1111-4111-8111-111111111111', 'task.result.ready', '1',
    '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
    1, now(), '44444444-4444-4444-8444-444444444444',
    '{"title":"first","status":"pending_approval","summary":""}'::jsonb,
    repeat('a', 64))),
  'recorded',
  'the first event about an aggregate is recorded'
);

-- A redelivery is normal, not an error: the sender retries until acknowledged.
SELECT is(
  (SELECT outcome FROM selena_ingest_raw.record_aether_event(
    '11111111-1111-4111-8111-111111111111', 'task.result.ready', '1',
    '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
    1, now(), '44444444-4444-4444-8444-444444444444',
    '{"title":"first","status":"pending_approval","summary":""}'::jsonb,
    repeat('a', 64))),
  'duplicate',
  'the same event delivered twice does not become two inbox items'
);

SELECT is(
  (SELECT outcome FROM selena_ingest_raw.record_aether_event(
    '55555555-5555-4555-8555-555555555555', 'task.result.ready', '1',
    '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
    2, now(), '44444444-4444-4444-8444-444444444444',
    '{"title":"second","status":"approved","summary":""}'::jsonb,
    repeat('b', 64))),
  'recorded',
  'a newer version of the same aggregate is recorded'
);

-- Since 0039 a redelivered version that carries different content is a
-- conflict rather than a silently dropped stale event: changed content must
-- never pass as a repeat of what was recorded.
SELECT throws_ok(
  $$SELECT outcome FROM selena_ingest_raw.record_aether_event(
    '66666666-6666-4666-8666-666666666666', 'task.result.ready', '1',
    '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
    1, now(), '44444444-4444-4444-8444-444444444444',
    '{"title":"late","status":"pending_approval","summary":""}'::jsonb,
    repeat('c', 64))$$,
  'SE409', NULL,
  'an older version redelivered with different content is a conflict'
);

-- Delivery order is still not guaranteed: a version that was never recorded
-- but is older than the newest one is dropped, not applied backwards.
SELECT is(
  (SELECT outcome FROM selena_ingest_raw.record_aether_event(
    '77777777-7777-4777-8777-777777777777', 'task.result.ready', '1',
    '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
    4, now(), '44444444-4444-4444-8444-444444444444',
    '{"title":"fourth","status":"done","summary":""}'::jsonb,
    repeat('e', 64))),
  'recorded',
  'a later version is recorded even when a middle one never arrived'
);
SELECT is(
  (SELECT outcome FROM selena_ingest_raw.record_aether_event(
    '88888888-8888-4888-8888-888888888888', 'task.result.ready', '1',
    '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
    3, now(), '44444444-4444-4444-8444-444444444444',
    '{"title":"third","status":"approved","summary":""}'::jsonb,
    repeat('f', 64))),
  'stale',
  'an event older than what was recorded is dropped, not applied'
);

-- The same id carrying different content is not a retry; accepting it quietly
-- would hide whatever produced it.
SELECT throws_ok(
  $$SELECT outcome FROM selena_ingest_raw.record_aether_event(
    '11111111-1111-4111-8111-111111111111', 'task.result.ready', '1',
    '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
    1, now(), '44444444-4444-4444-8444-444444444444',
    '{"title":"different","status":"done","summary":""}'::jsonb,
    repeat('d', 64))$$,
  'Aether event id was reused for different content',
  'a reused event id with different content is refused'
);

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
