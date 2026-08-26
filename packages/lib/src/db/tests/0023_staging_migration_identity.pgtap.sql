-- Run only against a disposable database after the full 0021-0023 chain.
BEGIN;

SELECT plan(9);

SELECT ok(
  has_schema_privilege('selena_web_runtime', 'selena_performance', 'USAGE'),
  'web runtime can resolve the performance schema'
);
SELECT ok(
  has_table_privilege('selena_web_runtime', 'selena_performance.metric_snapshots', 'SELECT'),
  'web runtime can read metric snapshots'
);
SELECT ok(
  NOT has_schema_privilege('selena_web_runtime', 'selena_performance', 'CREATE'),
  'web runtime cannot create performance objects'
);
SELECT ok(
  NOT has_table_privilege('selena_web_runtime', 'selena_performance.metric_snapshots', 'INSERT')
  AND NOT has_table_privilege('selena_web_runtime', 'selena_performance.metric_snapshots', 'UPDATE')
  AND NOT has_table_privilege('selena_web_runtime', 'selena_performance.metric_snapshots', 'DELETE')
  AND NOT has_table_privilege('selena_web_runtime', 'selena_performance.metric_snapshots', 'TRUNCATE'),
  'web runtime remains read-only for metric snapshots'
);
SELECT ok(
  NOT has_table_privilege('selena_web_runtime', 'selena_registry.channel_accounts', 'INSERT'),
  'web runtime cannot create provider accounts or change the allowlist'
);
SELECT ok(
  NOT pg_has_role('selena_web_runtime', 'selena_migrator', 'MEMBER')
  AND NOT pg_has_role('selena_web_runtime', 'selena_migrator', 'SET')
  AND NOT pg_has_role('selena_web_runtime', 'selena_schema_owner', 'MEMBER')
  AND NOT pg_has_role('selena_web_runtime', 'selena_schema_owner', 'SET'),
  'web runtime cannot become migrator or schema owner'
);
SELECT ok(
  NOT pg_has_role('selena_registry_worker_runtime', 'selena_migrator', 'MEMBER')
  AND NOT pg_has_role('selena_registry_worker_runtime', 'selena_migrator', 'SET')
  AND NOT pg_has_role('selena_registry_worker_runtime', 'selena_schema_owner', 'MEMBER')
  AND NOT pg_has_role('selena_registry_worker_runtime', 'selena_schema_owner', 'SET'),
  'worker runtime cannot become migrator or schema owner'
);
SELECT ok(
  (SELECT NOT rolcanlogin FROM pg_roles WHERE rolname = 'selena_migrator'),
  'base migration role remains a no-login role'
);
SELECT ok(
  NOT has_schema_privilege('anon', 'selena_performance', 'USAGE')
  AND NOT has_schema_privilege('authenticated', 'selena_performance', 'USAGE'),
  'frontend database roles cannot access the private performance schema'
);

SELECT * FROM finish();
ROLLBACK;
