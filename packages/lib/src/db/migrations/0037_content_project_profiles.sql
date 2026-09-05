SET ROLE selena_schema_owner;

CREATE TYPE selena_registry.profile_decision AS ENUM ('CONFIRMED', 'REVOKED');

CREATE TABLE selena_registry.brand_content_profile_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  version integer NOT NULL CHECK (version > 0),
  languages text[] NOT NULL CHECK (cardinality(languages) > 0),
  audience jsonb NOT NULL CHECK (jsonb_typeof(audience) = 'object'),
  voice jsonb NOT NULL CHECK (jsonb_typeof(voice) = 'object'),
  cta_rules jsonb DEFAULT '[]'::jsonb NOT NULL CHECK (jsonb_typeof(cta_rules) = 'array'),
  visual_rules jsonb DEFAULT '{}'::jsonb NOT NULL CHECK (jsonb_typeof(visual_rules) = 'object'),
  claim_rules jsonb DEFAULT '{}'::jsonb NOT NULL CHECK (jsonb_typeof(claim_rules) = 'object'),
  facts jsonb DEFAULT '[]'::jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'array'),
  source_refs jsonb DEFAULT '[]'::jsonb NOT NULL CHECK (jsonb_typeof(source_refs) = 'array'),
  profile_hash text NOT NULL CHECK (profile_hash ~ '^[a-f0-9]{64}$'),
  immutable boolean DEFAULT true NOT NULL CHECK (immutable),
  created_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX brand_content_profile_versions_brand_version_unique
  ON selena_registry.brand_content_profile_versions (brand_id, version);
CREATE UNIQUE INDEX brand_content_profile_versions_brand_hash_unique
  ON selena_registry.brand_content_profile_versions (brand_id, profile_hash);
CREATE INDEX brand_content_profile_versions_brand_idx
  ON selena_registry.brand_content_profile_versions (brand_id, version);
CREATE INDEX brand_content_profile_versions_org_idx
  ON selena_registry.brand_content_profile_versions (organization_id);

CREATE TABLE selena_registry.brand_content_profile_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  profile_version_id uuid NOT NULL REFERENCES selena_registry.brand_content_profile_versions(id),
  profile_hash text NOT NULL CHECK (profile_hash ~ '^[a-f0-9]{64}$'),
  decision selena_registry.profile_decision NOT NULL,
  decided_by text NOT NULL,
  reason text,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT brand_content_profile_decisions_revoke_reason
    CHECK (decision <> 'REVOKED' OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);
CREATE INDEX brand_content_profile_decisions_version_idx
  ON selena_registry.brand_content_profile_decisions (profile_version_id, created_at);
CREATE INDEX brand_content_profile_decisions_brand_idx
  ON selena_registry.brand_content_profile_decisions (brand_id, created_at);
CREATE INDEX brand_content_profile_decisions_org_idx
  ON selena_registry.brand_content_profile_decisions (organization_id);

CREATE TABLE selena_registry.content_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  platform text NOT NULL CHECK (platform = 'youtube'),
  publication_mode text DEFAULT 'DRAFT_ONLY' NOT NULL CHECK (publication_mode = 'DRAFT_ONLY'),
  display_name text DEFAULT 'YouTube' NOT NULL,
  channel_url text,
  languages text[] CHECK (languages IS NULL OR cardinality(languages) > 0),
  created_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX content_channels_brand_platform_unique
  ON selena_registry.content_channels (brand_id, platform);
CREATE INDEX content_channels_brand_idx ON selena_registry.content_channels (brand_id);
CREATE INDEX content_channels_org_idx ON selena_registry.content_channels (organization_id);

ALTER TABLE selena_registry.brand_content_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.brand_content_profile_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.brand_content_profile_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.brand_content_profile_decisions FORCE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.content_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.content_channels FORCE ROW LEVEL SECURITY;

CREATE POLICY brand_content_profile_versions_web_select ON selena_registry.brand_content_profile_versions
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY brand_content_profile_versions_web_insert ON selena_registry.brand_content_profile_versions
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    created_by = current_setting('app.selena_actor_id', true)
    AND selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web'])
  );
CREATE POLICY brand_content_profile_versions_web_update_denied ON selena_registry.brand_content_profile_versions
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
CREATE POLICY brand_content_profile_versions_web_delete_denied ON selena_registry.brand_content_profile_versions
  FOR DELETE TO selena_web_runtime USING (false);

CREATE POLICY brand_content_profile_decisions_web_select ON selena_registry.brand_content_profile_decisions
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY brand_content_profile_decisions_web_insert_owner ON selena_registry.brand_content_profile_decisions
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    selena_registry.can_human_approve(organization_id, brand_id)
    AND decided_by = current_setting('app.selena_actor_id', true)
    AND EXISTS (
      SELECT 1 FROM selena_registry.brand_content_profile_versions version
      WHERE version.id = profile_version_id
        AND version.organization_id = selena_registry.brand_content_profile_decisions.organization_id
        AND version.brand_id = selena_registry.brand_content_profile_decisions.brand_id
        AND version.profile_hash = selena_registry.brand_content_profile_decisions.profile_hash
    )
  );
CREATE POLICY brand_content_profile_decisions_web_update_denied ON selena_registry.brand_content_profile_decisions
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
CREATE POLICY brand_content_profile_decisions_web_delete_denied ON selena_registry.brand_content_profile_decisions
  FOR DELETE TO selena_web_runtime USING (false);

CREATE POLICY content_channels_web_select ON selena_registry.content_channels
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY content_channels_web_insert_draft_only ON selena_registry.content_channels
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    platform = 'youtube'
    AND publication_mode = 'DRAFT_ONLY'
    AND created_by = current_setting('app.selena_actor_id', true)
    AND selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web'])
  );
CREATE POLICY content_channels_web_update_denied ON selena_registry.content_channels
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
CREATE POLICY content_channels_web_delete_denied ON selena_registry.content_channels
  FOR DELETE TO selena_web_runtime USING (false);

CREATE POLICY brand_content_profile_versions_schema_owner_select ON selena_registry.brand_content_profile_versions
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY brand_content_profile_decisions_schema_owner_select ON selena_registry.brand_content_profile_decisions
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY content_channels_schema_owner_select ON selena_registry.content_channels
  FOR SELECT TO selena_schema_owner USING (true);

CREATE TRIGGER brand_content_profile_versions_append_only
  BEFORE UPDATE OR DELETE ON selena_registry.brand_content_profile_versions
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
CREATE TRIGGER brand_content_profile_decisions_append_only
  BEFORE UPDATE OR DELETE ON selena_registry.brand_content_profile_decisions
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
CREATE TRIGGER content_channels_append_only
  BEFORE UPDATE OR DELETE ON selena_registry.content_channels
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();

GRANT USAGE ON TYPE selena_registry.profile_decision TO selena_web_runtime;
GRANT USAGE ON SCHEMA selena_registry TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_registry.brand_content_profile_versions TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_registry.brand_content_profile_decisions TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_registry.content_channels TO selena_web_runtime;

RESET ROLE;
