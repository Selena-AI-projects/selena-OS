SET ROLE selena_schema_owner;

-- 0032 made "one active provider per channel and environment" a constraint, but
-- left the provider name free text. A typo would then create a silent third
-- provider that nothing dispatches through and nothing warns about. Adding a
-- provider is a deliberate act, so it costs a migration.
ALTER TABLE selena_registry.channel_provider_bindings
  ADD CONSTRAINT channel_provider_bindings_provider_known
  CHECK (provider IN ('postiz', 'blotato'));

COMMENT ON CONSTRAINT channel_provider_bindings_provider_known
  ON selena_registry.channel_provider_bindings IS
  'Known release providers. Extend here, not by writing a new name into a row.';

RESET ROLE;
