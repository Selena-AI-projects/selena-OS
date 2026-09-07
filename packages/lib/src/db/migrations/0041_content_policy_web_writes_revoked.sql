SET ROLE selena_schema_owner;

-- The lifecycle functions of 0040 are the only way a policy may be set or
-- withdrawn: they insist on an interactive owner and write the audit row. The
-- web runtime still held INSERT and UPDATE on the table itself from 0027, with
-- policies that admit any member of the brand — a path around both checks that
-- no application code uses, and that must not exist.
REVOKE INSERT, UPDATE ON selena_registry.content_policies FROM selena_web_runtime;
DROP POLICY IF EXISTS content_policies_web_insert ON selena_registry.content_policies;
DROP POLICY IF EXISTS content_policies_web_update ON selena_registry.content_policies;

DO $$
BEGIN
  IF has_table_privilege('selena_web_runtime', 'selena_registry.content_policies', 'INSERT')
     OR has_table_privilege('selena_web_runtime', 'selena_registry.content_policies', 'UPDATE')
     OR has_table_privilege('selena_web_runtime', 'selena_registry.content_policies', 'DELETE') THEN
    RAISE EXCEPTION 'selena_web_runtime must reach selena_registry.content_policies only through its lifecycle functions';
  END IF;
  IF NOT has_table_privilege('selena_web_runtime', 'selena_registry.content_policies', 'SELECT') THEN
    RAISE EXCEPTION 'selena_web_runtime must still read selena_registry.content_policies';
  END IF;
END $$;

RESET ROLE;
