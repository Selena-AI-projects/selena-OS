-- Run only against a disposable database after migration 0036 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(14);

-- The whole point of moving the key into the database is that the boundary is
-- enforced by grants rather than by everyone remembering the rule, so the
-- grants are what gets asserted.
SELECT ok(
  NOT has_table_privilege('selena_gateway_runtime', 'selena_release.gateway_signing_keys', 'SELECT')
  AND NOT has_table_privilege('selena_gateway_runtime', 'selena_release.gateway_signing_keys', 'INSERT')
  AND NOT has_table_privilege('selena_gateway_runtime', 'selena_release.gateway_signing_keys', 'UPDATE'),
  'the gateway runtime cannot touch the key table directly'
);
SELECT ok(
  has_function_privilege('selena_gateway_runtime',
    'selena_release.ensure_gateway_signing_key(text, text, text)', 'EXECUTE'),
  'the gateway runtime obtains its key through the function'
);
SELECT ok(
  has_column_privilege('selena_web_runtime', 'selena_release.gateway_signing_keys', 'public_key_pem', 'SELECT')
  AND has_column_privilege('selena_scanner_runtime', 'selena_release.gateway_signing_keys', 'public_key_pem', 'SELECT'),
  'anyone who verifies a signature can read the public half'
);
SELECT ok(
  NOT has_column_privilege('selena_web_runtime', 'selena_release.gateway_signing_keys', 'private_key_pem', 'SELECT')
  AND NOT has_column_privilege('selena_scanner_runtime', 'selena_release.gateway_signing_keys', 'private_key_pem', 'SELECT'),
  'no verifier can read the private half'
);
SELECT ok(
  NOT has_function_privilege('selena_web_runtime',
    'selena_release.ensure_gateway_signing_key(text, text, text)', 'EXECUTE')
  AND NOT has_function_privilege('public',
    'selena_release.ensure_gateway_signing_key(text, text, text)', 'EXECUTE'),
  'nobody else can ask for the signing key'
);
SELECT ok(
  NOT has_function_privilege('selena_gateway_runtime',
    'selena_release.retire_gateway_signing_key(text)', 'EXECUTE')
  AND NOT has_function_privilege('public',
    'selena_release.retire_gateway_signing_key(text)', 'EXECUTE'),
  'a runtime cannot retire the key it signs with'
);
SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity
   FROM pg_class WHERE oid = 'selena_release.gateway_signing_keys'::regclass),
  'row level security is on and forced for the key table'
);

-- Behaviour of the function, exercised as the runtime that calls it.
SET LOCAL ROLE selena_gateway_runtime;

SELECT is(
  (SELECT version FROM selena_release.ensure_gateway_signing_key(
    'k-first', '-----BEGIN PUBLIC KEY-----first', '-----BEGIN PRIVATE KEY-----first')),
  'k-first',
  'the first boot installs the key it minted'
);
SELECT is(
  (SELECT private_key_pem FROM selena_release.ensure_gateway_signing_key(
    'k-second', '-----BEGIN PUBLIC KEY-----second', '-----BEGIN PRIVATE KEY-----second')),
  '-----BEGIN PRIVATE KEY-----first',
  'a later boot discards its candidate and gets the key already in custody'
);
RESET ROLE;

-- Counted outside the runtime's session on purpose: the runtime cannot read
-- this table at all, which is asserted above.
SELECT is(
  (SELECT count(*)::integer FROM selena_release.gateway_signing_keys),
  1,
  'the discarded candidate was never stored'
);

-- Rotation: retiring the live key is what lets the next boot mint a new one.
SELECT selena_release.retire_gateway_signing_key('k-first');
SET LOCAL ROLE selena_gateway_runtime;
SELECT is(
  (SELECT version FROM selena_release.ensure_gateway_signing_key(
    'k-third', '-----BEGIN PUBLIC KEY-----third', '-----BEGIN PRIVATE KEY-----third')),
  'k-third',
  'after the live key is retired the next boot installs a fresh one'
);
RESET ROLE;

SELECT is(
  (SELECT count(*)::integer FROM selena_release.gateway_signing_keys WHERE retired_at IS NOT NULL),
  1,
  'the retired key is kept so manifests signed with it still verify'
);

-- A second live key would make "which key signed this" ambiguous.
SELECT throws_ok(
  $$INSERT INTO selena_release.gateway_signing_keys (version, public_key_pem, private_key_pem)
    VALUES ('k-fourth', '-----BEGIN PUBLIC KEY-----fourth', '-----BEGIN PRIVATE KEY-----fourth')$$,
  '23505',
  NULL,
  'two live keys cannot exist at once'
);

SELECT throws_ok(
  $$INSERT INTO selena_release.gateway_signing_keys (version, public_key_pem, private_key_pem)
    VALUES ('K Fifth', '-----BEGIN PUBLIC KEY-----fifth', '-----BEGIN PRIVATE KEY-----fifth')$$,
  '23514',
  NULL,
  'a version that is not a safe identifier is rejected'
);

SELECT * FROM finish();
ROLLBACK;
