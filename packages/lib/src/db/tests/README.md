# Disposable pgTAP runner

These suites are database-destructive test fixtures and must run only against a
fresh disposable PostgreSQL database. They are not a staging or production
check.

Prerequisites:

1. Start an isolated PostgreSQL instance with the `pgtap` extension available.
2. Apply the migration chain to that instance with the migration runner.
3. Set `SELENA_DISPOSABLE_DATABASE_URL` to that instance's connection string.

Run the Slice 1 assertions from the repository root:

```bash
SELENA_DISPOSABLE_DATABASE_URL=postgres://... \
  pnpm --filter @workspace/lib test:pgtap \
  src/db/tests/0032_content_project_profiles.pgtap.sql
```

The runner refuses to start without the explicitly named disposable URL,
prints the TAP assertions, and exits non-zero when any assertion is `not ok`.
It does not create the database, apply migrations, call providers, or publish
content.
