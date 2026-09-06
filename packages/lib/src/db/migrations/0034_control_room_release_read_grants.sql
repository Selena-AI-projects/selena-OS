SET ROLE selena_schema_owner;

-- The web runtime reads release history through a column projection, so the
-- signed manifest body, its signature and its signing key stay out of reach.
-- Two columns the releases section selects were left out of that projection:
-- which content version a manifest was built from, and which channel account it
-- targets. Postgres reports a missing column privilege as a permission error
-- rather than a null, so the query failed outright and took the whole Control
-- Room page down with it — not just the one section.
GRANT SELECT (content_version_id, channel_account_id)
  ON selena_release.release_manifests TO selena_web_runtime;

DO $$
BEGIN
  IF has_column_privilege('selena_web_runtime', 'selena_release.release_manifests', 'manifest', 'SELECT')
    OR has_column_privilege('selena_web_runtime', 'selena_release.release_manifests', 'signature', 'SELECT')
    OR has_column_privilege('selena_web_runtime', 'selena_release.release_manifests', 'signing_key_version', 'SELECT')
    OR has_column_privilege('selena_web_runtime', 'selena_release.release_manifests', 'approval_id', 'SELECT') THEN
    RAISE EXCEPTION 'Widening the projection must not expose the signed manifest';
  END IF;
END $$;

RESET ROLE;
