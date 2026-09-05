-- Run only against a disposable database after migration 0034 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(6);

-- The releases section selects these two alongside the columns the projection
-- already covered. A missing column privilege is a permission error, not a
-- null, so leaving one out fails the query and the page rather than the cell.
SELECT ok(
  has_column_privilege('selena_web_runtime', 'selena_release.release_manifests', 'content_version_id', 'SELECT'),
  'web runtime can read which content version a manifest was built from'
);
SELECT ok(
  has_column_privilege('selena_web_runtime', 'selena_release.release_manifests', 'channel_account_id', 'SELECT'),
  'web runtime can read which channel account a manifest targets'
);

-- Widening a projection is where a signed artefact leaks, so the boundary is
-- restated rather than assumed.
SELECT ok(
  NOT has_column_privilege('selena_web_runtime', 'selena_release.release_manifests', 'manifest', 'SELECT')
  AND NOT has_column_privilege('selena_web_runtime', 'selena_release.release_manifests', 'signature', 'SELECT')
  AND NOT has_column_privilege('selena_web_runtime', 'selena_release.release_manifests', 'signing_key_version', 'SELECT'),
  'the signed manifest, its signature and its key stay out of the web runtime'
);
SELECT ok(
  NOT has_table_privilege('selena_web_runtime', 'selena_release.release_manifests', 'INSERT')
  AND NOT has_table_privilege('selena_web_runtime', 'selena_release.release_manifests', 'UPDATE')
  AND NOT has_table_privilege('selena_web_runtime', 'selena_release.release_manifests', 'DELETE'),
  'release history stays read-only for the web runtime'
);

-- Every column the releases and publications sections read, asserted as one
-- set: adding a column to either query without extending the grant is the
-- defect this migration fixed, and it fails here rather than in the browser.
SELECT is(
  (SELECT count(*)::int FROM unnest(ARRAY[
     'id', 'organization_id', 'brand_id', 'content_version_id', 'channel_account_id',
     'platform', 'manifest_hash', 'status', 'expires_at', 'created_at'
   ]) AS column_name
    WHERE NOT has_column_privilege('selena_web_runtime', 'selena_release.release_manifests', column_name, 'SELECT')),
  0,
  'the releases section can read every column it selects'
);
SELECT is(
  (SELECT count(*)::int FROM unnest(ARRAY[
     'id', 'organization_id', 'brand_id', 'release_manifest_id', 'channel_account_id',
     'platform', 'provider_reference_id', 'status', 'occurred_at'
   ]) AS column_name
    WHERE NOT has_column_privilege('selena_web_runtime', 'selena_release.publication_attempts', column_name, 'SELECT')),
  0,
  'the publications section can read every column it selects'
);

SELECT * FROM finish();
ROLLBACK;
