-- Selena Control Room is a clean-install migration. It has not been executed.
-- Exposed schema: public only for existing application/auth tables.
-- Private, never Data API-exposed: selena_registry, selena_release, selena_audit,
-- selena_ingest_raw, selena_performance.

DO $$
BEGIN
  CREATE ROLE selena_schema_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE ROLE selena_migrator NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE ROLE selena_web_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE ROLE selena_registry_worker_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE ROLE selena_gateway_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE ROLE selena_trigger_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE ROLE selena_ingestion_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE ROLE selena_analytics_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE ROLE selena_scanner_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$
BEGIN
  CREATE ROLE selena_backup_restore NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT selena_schema_owner TO selena_migrator;

-- The private schemas are owned by the dedicated schema role. It needs only
-- database-level CREATE during this clean-install migration, not at runtime.
DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO selena_schema_owner', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO selena_schema_owner;
GRANT SELECT, REFERENCES ON TABLE public.organization, public.member, public.brands
  TO selena_schema_owner;

-- The migration executor must be a dedicated identity that can SET ROLE to
-- selena_schema_owner. No normal application login receives this membership.
SET ROLE selena_schema_owner;

CREATE SCHEMA IF NOT EXISTS selena_registry AUTHORIZATION selena_schema_owner;
CREATE SCHEMA IF NOT EXISTS selena_release AUTHORIZATION selena_schema_owner;
CREATE SCHEMA IF NOT EXISTS selena_audit AUTHORIZATION selena_schema_owner;
CREATE SCHEMA IF NOT EXISTS selena_ingest_raw AUTHORIZATION selena_schema_owner;
CREATE SCHEMA IF NOT EXISTS selena_performance AUTHORIZATION selena_schema_owner;

CREATE TYPE selena_registry.content_status AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'RELEASED', 'ARCHIVED');
CREATE TYPE selena_registry.asset_scan_status AS ENUM ('QUARANTINED', 'PASSED', 'REJECTED');
CREATE TYPE selena_registry.approval_decision AS ENUM ('APPROVED', 'REJECTED', 'REVOKED');
CREATE TYPE selena_registry.kill_switch_scope AS ENUM ('GLOBAL', 'BRAND', 'ACCOUNT');
CREATE TYPE selena_release.manifest_status AS ENUM ('READY', 'INVALIDATED', 'DISPATCHED', 'CANCELLED', 'EXPIRED');
CREATE TYPE selena_release.release_intent_status AS ENUM (
  'QUEUED', 'DISPATCHING', 'BLOCKED', 'CANCELLED', 'SUCCEEDED', 'UNKNOWN', 'FAILED'
);
CREATE TYPE selena_release.outbox_event_status AS ENUM ('PENDING', 'LEASED', 'DELIVERED', 'DEAD_LETTER');
CREATE TYPE selena_release.publication_attempt_status AS ENUM (
  'RESERVED',
  'NOT_SENT',
  'ACCEPTED',
  'DEFINITIVE_FAILURE',
  'AMBIGUOUS',
  'RECONCILE_REQUIRED',
  'CONFIRMED',
  'MANUAL_REVIEW'
);
CREATE TYPE selena_audit.incident_status AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED');
CREATE TYPE selena_performance.metric_quality AS ENUM ('COMPLETE', 'PARTIAL', 'STALE', 'QUARANTINED');

CREATE TABLE selena_registry.channel_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  platform text NOT NULL,
  provider_account_ref text NOT NULL,
  provider_integration_id text,
  status text DEFAULT 'ACTIVE' NOT NULL,
  allowlisted boolean DEFAULT true NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX channel_accounts_brand_platform_ref_unique
  ON selena_registry.channel_accounts (brand_id, platform, provider_account_ref);
CREATE INDEX channel_accounts_brand_idx ON selena_registry.channel_accounts (brand_id);
CREATE INDEX channel_accounts_org_idx ON selena_registry.channel_accounts (organization_id);

CREATE TABLE selena_registry.content_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  title text NOT NULL,
  status selena_registry.content_status DEFAULT 'DRAFT' NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX content_items_brand_idx ON selena_registry.content_items (brand_id);
CREATE INDEX content_items_org_idx ON selena_registry.content_items (organization_id);

CREATE TABLE selena_registry.content_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  content_id uuid NOT NULL REFERENCES selena_registry.content_items(id),
  version integer NOT NULL,
  body text NOT NULL,
  cta_url text NOT NULL,
  claims jsonb DEFAULT '[]'::jsonb NOT NULL,
  evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
  disclosure jsonb DEFAULT '{}'::jsonb NOT NULL,
  policy_version text NOT NULL,
  content_hash text NOT NULL,
  evidence_expires_at timestamptz,
  immutable boolean DEFAULT true NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX content_versions_content_version_unique
  ON selena_registry.content_versions (content_id, version);
CREATE INDEX content_versions_content_idx ON selena_registry.content_versions (content_id, created_at);
CREATE INDEX content_versions_brand_idx ON selena_registry.content_versions (brand_id);
CREATE INDEX content_versions_org_idx ON selena_registry.content_versions (organization_id);

CREATE TABLE selena_registry.content_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  content_version_id uuid NOT NULL REFERENCES selena_registry.content_versions(id),
  storage_key text NOT NULL,
  object_version_id text,
  sha256 text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL,
  scan_status selena_registry.asset_scan_status DEFAULT 'QUARANTINED' NOT NULL,
  scan_provider_event_ref text,
  rights_expires_at timestamptz,
  consent_expires_at timestamptz,
  verified_at timestamptz,
  immutable boolean DEFAULT true NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT content_assets_sha256_format CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT content_assets_size_range CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  CONSTRAINT content_assets_mime_allowlist CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp'))
);
CREATE UNIQUE INDEX content_assets_version_hash_unique
  ON selena_registry.content_assets (content_version_id, sha256);
CREATE INDEX content_assets_version_idx ON selena_registry.content_assets (content_version_id);
CREATE INDEX content_assets_org_idx ON selena_registry.content_assets (organization_id);

CREATE TABLE selena_registry.approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  content_version_id uuid NOT NULL REFERENCES selena_registry.content_versions(id),
  channel_account_id uuid NOT NULL REFERENCES selena_registry.channel_accounts(id),
  decision selena_registry.approval_decision NOT NULL,
  binding_hash text NOT NULL,
  content_hash text NOT NULL,
  asset_bundle_hash text NOT NULL,
  policy_version text NOT NULL,
  disclosure_hash text NOT NULL,
  approver_id text NOT NULL,
  reason text,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX approvals_version_account_idx
  ON selena_registry.approvals (content_version_id, channel_account_id, created_at);
CREATE INDEX approvals_brand_idx ON selena_registry.approvals (brand_id);
CREATE INDEX approvals_org_idx ON selena_registry.approvals (organization_id);

CREATE TABLE selena_registry.kill_switches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  scope selena_registry.kill_switch_scope NOT NULL,
  brand_id text REFERENCES public.brands(id),
  channel_account_id uuid REFERENCES selena_registry.channel_accounts(id),
  active boolean DEFAULT false NOT NULL,
  reason text NOT NULL,
  changed_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX kill_switches_scope_idx
  ON selena_registry.kill_switches (organization_id, scope, active);
CREATE INDEX kill_switches_org_idx ON selena_registry.kill_switches (organization_id);

CREATE TABLE selena_release.release_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  content_version_id uuid NOT NULL REFERENCES selena_registry.content_versions(id),
  approval_id uuid NOT NULL REFERENCES selena_registry.approvals(id),
  channel_account_id uuid NOT NULL REFERENCES selena_registry.channel_accounts(id),
  platform text NOT NULL,
  manifest jsonb NOT NULL,
  manifest_hash text NOT NULL,
  signature_algorithm text NOT NULL,
  signing_key_version text NOT NULL,
  signature text NOT NULL,
  status selena_release.manifest_status DEFAULT 'READY' NOT NULL,
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX release_manifests_approval_account_unique
  ON selena_release.release_manifests (approval_id, channel_account_id);
CREATE INDEX release_manifests_brand_idx
  ON selena_release.release_manifests (brand_id, created_at);
CREATE INDEX release_manifests_org_idx ON selena_release.release_manifests (organization_id);

CREATE TABLE selena_release.release_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  content_version_id uuid NOT NULL REFERENCES selena_registry.content_versions(id),
  approval_id uuid NOT NULL REFERENCES selena_registry.approvals(id),
  channel_account_id uuid NOT NULL REFERENCES selena_registry.channel_accounts(id),
  platform text NOT NULL,
  idempotency_key text NOT NULL,
  correlation_id uuid NOT NULL,
  status selena_release.release_intent_status DEFAULT 'QUEUED' NOT NULL,
  not_before timestamptz DEFAULT now() NOT NULL,
  cancellation_reason text,
  created_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX release_intents_scope_idempotency_unique
  ON selena_release.release_intents (organization_id, brand_id, channel_account_id, idempotency_key);
CREATE UNIQUE INDEX release_intents_approval_account_unique
  ON selena_release.release_intents (approval_id, channel_account_id);
CREATE INDEX release_intents_brand_status_idx
  ON selena_release.release_intents (brand_id, status, created_at);

CREATE TABLE selena_release.outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  release_intent_id uuid NOT NULL REFERENCES selena_release.release_intents(id),
  event_type text NOT NULL,
  event_version integer DEFAULT 1 NOT NULL CHECK (event_version > 0),
  idempotency_key text NOT NULL,
  status selena_release.outbox_event_status DEFAULT 'PENDING' NOT NULL,
  available_at timestamptz DEFAULT now() NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer DEFAULT 0 NOT NULL CHECK (attempt_count >= 0),
  max_attempts integer DEFAULT 5 NOT NULL CHECK (max_attempts > 0),
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX release_outbox_events_intent_event_unique
  ON selena_release.outbox_events (release_intent_id, event_type, event_version);
CREATE UNIQUE INDEX release_outbox_events_idempotency_unique
  ON selena_release.outbox_events (idempotency_key);
CREATE INDEX release_outbox_events_claim_idx
  ON selena_release.outbox_events (status, available_at, lease_expires_at);

CREATE TABLE selena_release.dispatch_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  release_manifest_id uuid NOT NULL REFERENCES selena_release.release_manifests(id),
  channel_account_id uuid NOT NULL REFERENCES selena_registry.channel_accounts(id),
  platform text NOT NULL,
  integration_id text NOT NULL,
  allowlist_reference text NOT NULL,
  idempotency_key text NOT NULL,
  nonce text NOT NULL,
  reserved_at timestamptz DEFAULT now() NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX dispatch_reservations_scope_idempotency_unique
  ON selena_release.dispatch_reservations (organization_id, brand_id, channel_account_id, idempotency_key);
CREATE UNIQUE INDEX dispatch_reservations_nonce_unique
  ON selena_release.dispatch_reservations (nonce);
CREATE INDEX dispatch_reservations_manifest_idx
  ON selena_release.dispatch_reservations (release_manifest_id, reserved_at);

CREATE TABLE selena_release.publication_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  reservation_id uuid NOT NULL REFERENCES selena_release.dispatch_reservations(id),
  release_manifest_id uuid NOT NULL REFERENCES selena_release.release_manifests(id),
  channel_account_id uuid NOT NULL REFERENCES selena_registry.channel_accounts(id),
  platform text NOT NULL,
  integration_id text NOT NULL,
  allowlist_reference text NOT NULL,
  manifest_hash text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  transition_number integer NOT NULL CHECK (transition_number > 0),
  status selena_release.publication_attempt_status NOT NULL,
  provider_request_id text,
  provider_reference_id text,
  error_classification text,
  error_detail text,
  occurred_at timestamptz DEFAULT now() NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX publication_attempts_transition_unique
  ON selena_release.publication_attempts (reservation_id, attempt_number, transition_number);
CREATE UNIQUE INDEX publication_attempts_provider_request_unique
  ON selena_release.publication_attempts (provider_request_id);
CREATE INDEX publication_attempts_reservation_idx
  ON selena_release.publication_attempts (reservation_id, occurred_at);
CREATE INDEX publication_attempts_brand_idx
  ON selena_release.publication_attempts (brand_id, occurred_at);

CREATE TABLE selena_audit.incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  publication_attempt_id uuid REFERENCES selena_release.publication_attempts(id),
  severity text NOT NULL,
  code text NOT NULL,
  summary text NOT NULL,
  status selena_audit.incident_status DEFAULT 'OPEN' NOT NULL,
  detected_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  resolved_at timestamptz
);
CREATE INDEX incidents_brand_idx ON selena_audit.incidents (brand_id, status);
CREATE INDEX incidents_org_idx ON selena_audit.incidents (organization_id);

CREATE TABLE selena_audit.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text REFERENCES public.brands(id),
  actor_id text NOT NULL,
  action text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  previous_hash text,
  event_hash text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX audit_events_brand_idx ON selena_audit.audit_events (brand_id, created_at);
CREATE INDEX audit_events_org_idx ON selena_audit.audit_events (organization_id);

CREATE TABLE selena_ingest_raw.raw_platform_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  channel_account_id uuid NOT NULL REFERENCES selena_registry.channel_accounts(id),
  provider text NOT NULL,
  checkpoint text NOT NULL,
  request_key text NOT NULL,
  window_started_at timestamptz NOT NULL,
  window_ended_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX raw_platform_snapshots_request_unique
  ON selena_ingest_raw.raw_platform_snapshots (channel_account_id, request_key);
CREATE INDEX raw_platform_snapshots_account_checkpoint_idx
  ON selena_ingest_raw.raw_platform_snapshots (channel_account_id, checkpoint, captured_at);

CREATE TABLE selena_performance.metric_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  publication_attempt_id uuid NOT NULL REFERENCES selena_release.publication_attempts(id),
  raw_snapshot_id uuid REFERENCES selena_ingest_raw.raw_platform_snapshots(id),
  platform text NOT NULL,
  observed_at timestamptz NOT NULL,
  data_cutoff_at timestamptz NOT NULL,
  definition_version text NOT NULL,
  quality selena_performance.metric_quality NOT NULL,
  values jsonb NOT NULL,
  revision_of_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX metric_snapshots_publication_attempt_idx
  ON selena_performance.metric_snapshots (publication_attempt_id, observed_at);
CREATE INDEX metric_snapshots_raw_snapshot_idx
  ON selena_performance.metric_snapshots (raw_snapshot_id);
CREATE INDEX metric_snapshots_org_idx ON selena_performance.metric_snapshots (organization_id);

CREATE TABLE selena_performance.tracking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  publication_attempt_id uuid REFERENCES selena_release.publication_attempts(id),
  correlation_id uuid,
  event_type text NOT NULL,
  visitor_hash text,
  attribution_class text NOT NULL,
  occurred_at timestamptz NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX tracking_events_publication_attempt_idx
  ON selena_performance.tracking_events (publication_attempt_id, occurred_at);
CREATE INDEX tracking_events_org_idx ON selena_performance.tracking_events (organization_id);

-- The two SECURITY DEFINER helpers are deliberately narrow: they are the
-- database-side boundary for context construction and membership verification.
-- Their fixed search_path, no-PUBLIC EXECUTE, and role-specific grants prevent
-- them from becoming generic privilege-escalation helpers.
RESET ROLE;
GRANT SELECT ON public.member, public.brands TO selena_schema_owner;
GRANT SELECT ON public.member, public.organization, public.brands TO selena_web_runtime;
DROP POLICY IF EXISTS selena_context_lookup ON public.member;
CREATE POLICY selena_context_lookup ON public.member
  FOR SELECT TO selena_schema_owner USING (true);
DROP POLICY IF EXISTS selena_context_lookup ON public.brands;
CREATE POLICY selena_context_lookup ON public.brands
  FOR SELECT TO selena_schema_owner USING (true);

SET ROLE selena_schema_owner;
CREATE FUNCTION selena_registry.set_request_context(
  p_actor_id text,
  p_organization_id text,
  p_brand_id text,
  p_role text,
  p_correlation_id uuid,
  p_service_identity text,
  p_auth_type text,
  p_release_manifest_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
DECLARE
  v_member_role text;
BEGIN
  IF p_correlation_id IS NULL OR p_actor_id IS NULL OR p_organization_id IS NULL OR p_brand_id IS NULL THEN
    RAISE EXCEPTION 'Selena request context is incomplete';
  END IF;

  IF pg_has_role(session_user, 'selena_web_runtime', 'member') THEN
    IF p_service_identity <> 'web' OR p_auth_type <> 'session' THEN
      RAISE EXCEPTION 'Web runtime context must represent an interactive session';
    END IF;
    SELECT CASE m.role WHEN 'admin' THEN 'owner' WHEN 'owner' THEN 'owner' WHEN 'viewer' THEN 'viewer' ELSE 'member' END
      INTO v_member_role
      FROM public.member m
      JOIN public.brands b ON b.organization_id = m.organization_id
      WHERE m.user_id = p_actor_id
        AND m.organization_id = p_organization_id
        AND b.id = p_brand_id
      LIMIT 1;
    IF v_member_role IS NULL OR v_member_role <> p_role THEN
      RAISE EXCEPTION 'Selena membership or role context is invalid';
    END IF;
  ELSIF pg_has_role(session_user, 'selena_registry_worker_runtime', 'member') THEN
    IF p_service_identity <> 'registry_worker' OR p_auth_type <> 'service' OR p_actor_id <> 'service:registry-worker' THEN
      RAISE EXCEPTION 'Registry worker context is invalid';
    END IF;
  ELSIF pg_has_role(session_user, 'selena_gateway_runtime', 'member') THEN
    IF p_service_identity <> 'gateway' OR p_auth_type <> 'service' OR p_actor_id <> 'service:gateway' THEN
      RAISE EXCEPTION 'Gateway context is invalid';
    END IF;
  ELSIF pg_has_role(session_user, 'selena_ingestion_runtime', 'member') THEN
    IF p_service_identity <> 'ingestion' OR p_auth_type <> 'service' OR p_actor_id <> 'service:ingestion' THEN
      RAISE EXCEPTION 'Ingestion context is invalid';
    END IF;
  ELSIF pg_has_role(session_user, 'selena_analytics_runtime', 'member') THEN
    IF p_service_identity <> 'analytics' OR p_auth_type <> 'service' OR p_actor_id <> 'service:analytics' THEN
      RAISE EXCEPTION 'Analytics context is invalid';
    END IF;
  ELSIF pg_has_role(session_user, 'selena_scanner_runtime', 'member') THEN
    IF p_service_identity <> 'scanner' OR p_auth_type <> 'service' OR p_actor_id <> 'service:scanner' THEN
      RAISE EXCEPTION 'Scanner context is invalid';
    END IF;
  ELSE
    RAISE EXCEPTION 'Runtime identity may not establish Selena request context';
  END IF;

  PERFORM set_config('app.selena_actor_id', p_actor_id, true);
  PERFORM set_config('app.selena_organization_id', p_organization_id, true);
  PERFORM set_config('app.selena_brand_id', p_brand_id, true);
  PERFORM set_config('app.selena_role', p_role, true);
  PERFORM set_config('app.selena_correlation_id', p_correlation_id::text, true);
  PERFORM set_config('app.selena_service_identity', p_service_identity, true);
  PERFORM set_config('app.selena_auth_type', p_auth_type, true);
  PERFORM set_config('app.selena_release_manifest_id', COALESCE(p_release_manifest_id::text, ''), true);
END;
$$;

CREATE FUNCTION selena_registry.can_access_brand(
  p_organization_id text,
  p_brand_id text,
  p_services text[]
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
  SELECT
    current_setting('app.selena_organization_id', true) = p_organization_id
    AND current_setting('app.selena_brand_id', true) = p_brand_id
    AND current_setting('app.selena_service_identity', true) = ANY (p_services)
    AND (
      (
        current_setting('app.selena_service_identity', true) = 'web'
        AND pg_has_role(session_user, 'selena_web_runtime', 'member')
        AND current_setting('app.selena_auth_type', true) = 'session'
        AND EXISTS (
          SELECT 1
          FROM public.member m
          JOIN public.brands b ON b.organization_id = m.organization_id
          WHERE m.user_id = current_setting('app.selena_actor_id', true)
            AND m.organization_id = p_organization_id
            AND b.id = p_brand_id
            AND CASE m.role WHEN 'admin' THEN 'owner' WHEN 'owner' THEN 'owner' WHEN 'viewer' THEN 'viewer' ELSE 'member' END
                = current_setting('app.selena_role', true)
        )
      )
      OR (
        current_setting('app.selena_service_identity', true) = 'registry_worker'
        AND pg_has_role(session_user, 'selena_registry_worker_runtime', 'member')
        AND current_setting('app.selena_actor_id', true) = 'service:registry-worker'
        AND current_setting('app.selena_auth_type', true) = 'service'
      )
      OR (
        current_setting('app.selena_service_identity', true) = 'gateway'
        AND pg_has_role(session_user, 'selena_gateway_runtime', 'member')
        AND current_setting('app.selena_actor_id', true) = 'service:gateway'
        AND current_setting('app.selena_auth_type', true) = 'service'
      )
      OR (
        current_setting('app.selena_service_identity', true) = 'ingestion'
        AND pg_has_role(session_user, 'selena_ingestion_runtime', 'member')
        AND current_setting('app.selena_actor_id', true) = 'service:ingestion'
        AND current_setting('app.selena_auth_type', true) = 'service'
      )
      OR (
        current_setting('app.selena_service_identity', true) = 'analytics'
        AND pg_has_role(session_user, 'selena_analytics_runtime', 'member')
        AND current_setting('app.selena_actor_id', true) = 'service:analytics'
        AND current_setting('app.selena_auth_type', true) = 'service'
      )
      OR (
        current_setting('app.selena_service_identity', true) = 'scanner'
        AND pg_has_role(session_user, 'selena_scanner_runtime', 'member')
        AND current_setting('app.selena_actor_id', true) = 'service:scanner'
        AND current_setting('app.selena_auth_type', true) = 'service'
      )
    );
$$;

CREATE FUNCTION selena_registry.can_write_brand(
  p_organization_id text,
  p_brand_id text,
  p_services text[]
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, selena_registry
AS $$
  SELECT selena_registry.can_access_brand(p_organization_id, p_brand_id, p_services)
    AND current_setting('app.selena_role', true) IN ('owner', 'member', 'service');
$$;

CREATE FUNCTION selena_registry.can_human_approve(
  p_organization_id text,
  p_brand_id text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, selena_registry
AS $$
  SELECT selena_registry.can_access_brand(p_organization_id, p_brand_id, ARRAY['web'])
    AND current_setting('app.selena_auth_type', true) = 'session'
    AND current_setting('app.selena_role', true) = 'owner';
$$;

-- This SECURITY DEFINER predicate is intentionally limited to approval
-- preconditions. FORCE RLS stays enabled; explicit owner-only read policies
-- below let this function verify immutable source rows without granting those
-- reads to a runtime identity.
CREATE FUNCTION selena_registry.can_create_approval(
  p_organization_id text,
  p_brand_id text,
  p_content_version_id uuid,
  p_channel_account_id uuid,
  p_approver_id text,
  p_content_hash text,
  p_policy_version text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, selena_registry
AS $$
  SELECT
    selena_registry.can_human_approve(p_organization_id, p_brand_id)
    AND p_approver_id = current_setting('app.selena_actor_id', true)
    AND EXISTS (
      SELECT 1
      FROM selena_registry.content_versions cv
      WHERE cv.id = p_content_version_id
        AND cv.organization_id = p_organization_id
        AND cv.brand_id = p_brand_id
        AND cv.content_hash = p_content_hash
        AND cv.policy_version = p_policy_version
        AND cv.evidence <> '[]'::jsonb
        AND cv.evidence_expires_at IS NOT NULL
        AND cv.evidence_expires_at > now()
    )
    AND EXISTS (
      SELECT 1
      FROM selena_registry.channel_accounts ca
      WHERE ca.id = p_channel_account_id
        AND ca.organization_id = p_organization_id
        AND ca.brand_id = p_brand_id
        AND ca.allowlisted
        AND ca.status = 'ACTIVE'
    )
    AND 1 = (
      SELECT count(*)
      FROM selena_registry.content_assets a
      WHERE a.content_version_id = p_content_version_id
        AND a.organization_id = p_organization_id
        AND a.brand_id = p_brand_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM selena_registry.content_assets a
      WHERE a.content_version_id = p_content_version_id
        AND a.organization_id = p_organization_id
        AND a.brand_id = p_brand_id
        AND (
          a.scan_status <> 'PASSED'
          OR a.object_version_id IS NULL
          OR a.scan_provider_event_ref IS NULL
          OR a.verified_at IS NULL
          OR a.rights_expires_at IS NULL
          OR a.rights_expires_at <= now()
          OR a.consent_expires_at IS NULL
          OR a.consent_expires_at <= now()
        )
    );
$$;

CREATE FUNCTION selena_registry.can_access_exact_manifest(
  p_organization_id text,
  p_brand_id text,
  p_manifest_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, selena_registry
AS $$
  SELECT selena_registry.can_access_brand(p_organization_id, p_brand_id, ARRAY['gateway'])
    AND current_setting('app.selena_release_manifest_id', true) = p_manifest_id::text;
$$;

REVOKE ALL ON FUNCTION selena_registry.set_request_context(text, text, text, text, uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_registry.can_access_brand(text, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_registry.can_write_brand(text, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_registry.can_human_approve(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_registry.can_create_approval(text, text, uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_registry.can_access_exact_manifest(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_registry.set_request_context(text, text, text, text, uuid, text, text, uuid)
  TO selena_web_runtime, selena_registry_worker_runtime, selena_gateway_runtime, selena_ingestion_runtime,
     selena_analytics_runtime, selena_scanner_runtime;
GRANT EXECUTE ON FUNCTION selena_registry.can_access_brand(text, text, text[])
  TO selena_web_runtime, selena_registry_worker_runtime, selena_gateway_runtime, selena_ingestion_runtime,
     selena_analytics_runtime, selena_scanner_runtime;
GRANT EXECUTE ON FUNCTION selena_registry.can_write_brand(text, text, text[])
  TO selena_web_runtime, selena_registry_worker_runtime, selena_gateway_runtime, selena_ingestion_runtime,
     selena_scanner_runtime;
GRANT EXECUTE ON FUNCTION selena_registry.can_human_approve(text, text) TO selena_web_runtime;
GRANT EXECUTE ON FUNCTION selena_registry.can_create_approval(text, text, uuid, uuid, text, text, text)
  TO selena_web_runtime;
GRANT EXECUTE ON FUNCTION selena_registry.can_access_exact_manifest(text, text, uuid) TO selena_gateway_runtime;

DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'selena_registry.channel_accounts',
    'selena_registry.content_items',
    'selena_registry.content_versions',
    'selena_registry.content_assets',
    'selena_registry.approvals',
    'selena_registry.kill_switches',
    'selena_release.release_manifests',
    'selena_release.release_intents',
    'selena_release.outbox_events',
    'selena_release.dispatch_reservations',
    'selena_release.publication_attempts',
    'selena_audit.incidents',
    'selena_audit.audit_events',
    'selena_ingest_raw.raw_platform_snapshots',
    'selena_performance.metric_snapshots',
    'selena_performance.tracking_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', v_table);
  END LOOP;
END $$;

-- Web backend: brand-scoped registry reads; it has no direct release-write,
-- raw-ingestion, analytics-write, secret, DDL, or Trigger privilege.
CREATE POLICY channel_accounts_web_select ON selena_registry.channel_accounts
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY channel_accounts_web_delete_denied ON selena_registry.channel_accounts
  FOR DELETE TO selena_web_runtime USING (false);
CREATE POLICY channel_accounts_gateway_select ON selena_registry.channel_accounts
  FOR SELECT TO selena_gateway_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['gateway']));
CREATE POLICY channel_accounts_gateway_insert ON selena_registry.channel_accounts
  FOR INSERT TO selena_gateway_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['gateway']));
CREATE POLICY channel_accounts_gateway_update ON selena_registry.channel_accounts
  FOR UPDATE TO selena_gateway_runtime
  USING (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['gateway']))
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['gateway']));
CREATE POLICY channel_accounts_gateway_delete_denied ON selena_registry.channel_accounts
  FOR DELETE TO selena_gateway_runtime USING (false);

CREATE POLICY content_items_web_select ON selena_registry.content_items
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY content_items_web_insert ON selena_registry.content_items
  FOR INSERT TO selena_web_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY content_items_web_update ON selena_registry.content_items
  FOR UPDATE TO selena_web_runtime
  USING (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web']))
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY content_items_web_delete_denied ON selena_registry.content_items
  FOR DELETE TO selena_web_runtime USING (false);

CREATE POLICY content_versions_web_select ON selena_registry.content_versions
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY content_versions_web_insert ON selena_registry.content_versions
  FOR INSERT TO selena_web_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY content_versions_web_update_denied ON selena_registry.content_versions
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
CREATE POLICY content_versions_web_delete_denied ON selena_registry.content_versions
  FOR DELETE TO selena_web_runtime USING (false);

CREATE POLICY content_assets_web_select ON selena_registry.content_assets
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY content_assets_web_insert ON selena_registry.content_assets
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web'])
    AND scan_status = 'QUARANTINED'
  );
CREATE POLICY content_assets_web_update_denied ON selena_registry.content_assets
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
CREATE POLICY content_assets_web_delete_denied ON selena_registry.content_assets
  FOR DELETE TO selena_web_runtime USING (false);
CREATE POLICY content_assets_scanner_select ON selena_registry.content_assets
  FOR SELECT TO selena_scanner_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['scanner']));
CREATE POLICY content_assets_scanner_update ON selena_registry.content_assets
  FOR UPDATE TO selena_scanner_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['scanner']))
  WITH CHECK (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['scanner']));

CREATE POLICY approvals_web_select ON selena_registry.approvals
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY approvals_web_insert_human_only ON selena_registry.approvals
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    selena_registry.can_create_approval(
      organization_id,
      brand_id,
      content_version_id,
      channel_account_id,
      approver_id,
      content_hash,
      policy_version
    )
  );
CREATE POLICY approvals_web_update_denied ON selena_registry.approvals
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
CREATE POLICY approvals_web_delete_denied ON selena_registry.approvals
  FOR DELETE TO selena_web_runtime USING (false);

CREATE POLICY kill_switches_web_select ON selena_registry.kill_switches
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, COALESCE(brand_id, current_setting('app.selena_brand_id', true)), ARRAY['web']));
CREATE POLICY kill_switches_web_insert ON selena_registry.kill_switches
  FOR INSERT TO selena_web_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, COALESCE(brand_id, current_setting('app.selena_brand_id', true)), ARRAY['web']));
CREATE POLICY kill_switches_web_update ON selena_registry.kill_switches
  FOR UPDATE TO selena_web_runtime
  USING (selena_registry.can_write_brand(organization_id, COALESCE(brand_id, current_setting('app.selena_brand_id', true)), ARRAY['web']))
  WITH CHECK (selena_registry.can_write_brand(organization_id, COALESCE(brand_id, current_setting('app.selena_brand_id', true)), ARRAY['web']));
CREATE POLICY kill_switches_web_delete_denied ON selena_registry.kill_switches
  FOR DELETE TO selena_web_runtime USING (false);

-- A release intent and its outbox event are written in one web transaction.
-- A future registry worker may only claim/update delivery state; Trigger has
-- no PostgreSQL grant and receives opaque identifiers from that worker.
CREATE POLICY release_intents_web_select ON selena_release.release_intents
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY release_intents_web_insert ON selena_release.release_intents
  FOR INSERT TO selena_web_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY release_intents_web_update_denied ON selena_release.release_intents
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
CREATE POLICY release_intents_web_delete_denied ON selena_release.release_intents
  FOR DELETE TO selena_web_runtime USING (false);
CREATE POLICY release_intents_registry_worker_select ON selena_release.release_intents
  FOR SELECT TO selena_registry_worker_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['registry_worker']));
CREATE POLICY release_intents_registry_worker_update ON selena_release.release_intents
  FOR UPDATE TO selena_registry_worker_runtime
  USING (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['registry_worker']))
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['registry_worker']));
CREATE POLICY release_intents_registry_worker_delete_denied ON selena_release.release_intents
  FOR DELETE TO selena_registry_worker_runtime USING (false);

CREATE POLICY outbox_events_web_select ON selena_release.outbox_events
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY outbox_events_web_insert ON selena_release.outbox_events
  FOR INSERT TO selena_web_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY outbox_events_web_update_denied ON selena_release.outbox_events
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
CREATE POLICY outbox_events_web_delete_denied ON selena_release.outbox_events
  FOR DELETE TO selena_web_runtime USING (false);
CREATE POLICY outbox_events_registry_worker_select ON selena_release.outbox_events
  FOR SELECT TO selena_registry_worker_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['registry_worker']));
CREATE POLICY outbox_events_registry_worker_update ON selena_release.outbox_events
  FOR UPDATE TO selena_registry_worker_runtime
  USING (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['registry_worker']))
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['registry_worker']));
CREATE POLICY outbox_events_registry_worker_delete_denied ON selena_release.outbox_events
  FOR DELETE TO selena_registry_worker_runtime USING (false);

-- Release history is append-only. Gateway can read exactly the manifest id
-- placed in its verified transaction context, then append reservations/attempts.
CREATE POLICY release_manifests_gateway_select_exact ON selena_release.release_manifests
  FOR SELECT TO selena_gateway_runtime
  USING (
    status = 'READY'
    AND selena_registry.can_access_exact_manifest(organization_id, brand_id, id)
  );
CREATE POLICY release_manifests_gateway_insert ON selena_release.release_manifests
  FOR INSERT TO selena_gateway_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['gateway']));
CREATE POLICY release_manifests_gateway_update_denied ON selena_release.release_manifests
  FOR UPDATE TO selena_gateway_runtime USING (false) WITH CHECK (false);
CREATE POLICY release_manifests_gateway_delete_denied ON selena_release.release_manifests
  FOR DELETE TO selena_gateway_runtime USING (false);
CREATE POLICY release_manifests_web_select_projection ON selena_release.release_manifests
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));

CREATE POLICY dispatch_reservations_gateway_select ON selena_release.dispatch_reservations
  FOR SELECT TO selena_gateway_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['gateway']));
CREATE POLICY dispatch_reservations_gateway_insert ON selena_release.dispatch_reservations
  FOR INSERT TO selena_gateway_runtime
  WITH CHECK (
    selena_registry.can_write_brand(organization_id, brand_id, ARRAY['gateway'])
    AND current_setting('app.selena_release_manifest_id', true) = release_manifest_id::text
  );
CREATE POLICY dispatch_reservations_gateway_update_denied ON selena_release.dispatch_reservations
  FOR UPDATE TO selena_gateway_runtime USING (false) WITH CHECK (false);
CREATE POLICY dispatch_reservations_gateway_delete_denied ON selena_release.dispatch_reservations
  FOR DELETE TO selena_gateway_runtime USING (false);

CREATE POLICY publication_attempts_gateway_select ON selena_release.publication_attempts
  FOR SELECT TO selena_gateway_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['gateway']));
CREATE POLICY publication_attempts_gateway_insert ON selena_release.publication_attempts
  FOR INSERT TO selena_gateway_runtime
  WITH CHECK (
    selena_registry.can_write_brand(organization_id, brand_id, ARRAY['gateway'])
    AND selena_registry.can_access_exact_manifest(organization_id, brand_id, release_manifest_id)
  );
CREATE POLICY publication_attempts_gateway_update_denied ON selena_release.publication_attempts
  FOR UPDATE TO selena_gateway_runtime USING (false) WITH CHECK (false);
CREATE POLICY publication_attempts_gateway_delete_denied ON selena_release.publication_attempts
  FOR DELETE TO selena_gateway_runtime USING (false);
CREATE POLICY publication_attempts_web_select_projection ON selena_release.publication_attempts
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));

CREATE POLICY incidents_web_select ON selena_audit.incidents
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY incidents_gateway_insert ON selena_audit.incidents
  FOR INSERT TO selena_gateway_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['gateway']));
CREATE POLICY incidents_gateway_update ON selena_audit.incidents
  FOR UPDATE TO selena_gateway_runtime
  USING (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['gateway']))
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['gateway']));
CREATE POLICY incidents_gateway_delete_denied ON selena_audit.incidents
  FOR DELETE TO selena_gateway_runtime USING (false);

CREATE POLICY audit_events_web_select ON selena_audit.audit_events
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, COALESCE(brand_id, current_setting('app.selena_brand_id', true)), ARRAY['web']));
CREATE POLICY audit_events_web_insert ON selena_audit.audit_events
  FOR INSERT TO selena_web_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, COALESCE(brand_id, current_setting('app.selena_brand_id', true)), ARRAY['web']));
CREATE POLICY audit_events_gateway_insert ON selena_audit.audit_events
  FOR INSERT TO selena_gateway_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, COALESCE(brand_id, current_setting('app.selena_brand_id', true)), ARRAY['gateway']));
CREATE POLICY audit_events_update_denied ON selena_audit.audit_events
  FOR UPDATE TO selena_web_runtime, selena_gateway_runtime USING (false) WITH CHECK (false);
CREATE POLICY audit_events_delete_denied ON selena_audit.audit_events
  FOR DELETE TO selena_web_runtime, selena_gateway_runtime USING (false);

CREATE POLICY raw_platform_snapshots_ingestion_select ON selena_ingest_raw.raw_platform_snapshots
  FOR SELECT TO selena_ingestion_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['ingestion']));
CREATE POLICY raw_platform_snapshots_ingestion_insert ON selena_ingest_raw.raw_platform_snapshots
  FOR INSERT TO selena_ingestion_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['ingestion']));
CREATE POLICY raw_platform_snapshots_ingestion_update_denied ON selena_ingest_raw.raw_platform_snapshots
  FOR UPDATE TO selena_ingestion_runtime USING (false) WITH CHECK (false);
CREATE POLICY raw_platform_snapshots_ingestion_delete_denied ON selena_ingest_raw.raw_platform_snapshots
  FOR DELETE TO selena_ingestion_runtime USING (false);

CREATE POLICY metric_snapshots_analytics_select ON selena_performance.metric_snapshots
  FOR SELECT TO selena_analytics_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['analytics']));
CREATE POLICY metric_snapshots_web_select ON selena_performance.metric_snapshots
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY metric_snapshots_ingestion_insert ON selena_performance.metric_snapshots
  FOR INSERT TO selena_ingestion_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['ingestion']));
CREATE POLICY metric_snapshots_update_denied ON selena_performance.metric_snapshots
  FOR UPDATE TO selena_ingestion_runtime, selena_analytics_runtime USING (false) WITH CHECK (false);
CREATE POLICY metric_snapshots_delete_denied ON selena_performance.metric_snapshots
  FOR DELETE TO selena_ingestion_runtime, selena_analytics_runtime USING (false);

CREATE POLICY tracking_events_analytics_select ON selena_performance.tracking_events
  FOR SELECT TO selena_analytics_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['analytics']));
CREATE POLICY tracking_events_ingestion_insert ON selena_performance.tracking_events
  FOR INSERT TO selena_ingestion_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['ingestion']));
CREATE POLICY tracking_events_update_denied ON selena_performance.tracking_events
  FOR UPDATE TO selena_ingestion_runtime, selena_analytics_runtime USING (false) WITH CHECK (false);
CREATE POLICY tracking_events_delete_denied ON selena_performance.tracking_events
  FOR DELETE TO selena_ingestion_runtime, selena_analytics_runtime USING (false);

-- SECURITY DEFINER approval validation above needs to read these source rows
-- despite FORCE RLS. This owner is reachable only through the migrator group,
-- never by a runtime login, and has no BYPASSRLS attribute.
CREATE POLICY content_versions_schema_owner_select ON selena_registry.content_versions
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY content_assets_schema_owner_select ON selena_registry.content_assets
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY channel_accounts_schema_owner_select ON selena_registry.channel_accounts
  FOR SELECT TO selena_schema_owner USING (true);

CREATE FUNCTION selena_audit.reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, selena_audit
AS $$
BEGIN
  RAISE EXCEPTION 'Selena record % is append-only; create a compensating record instead', TG_TABLE_NAME;
END;
$$;
REVOKE ALL ON FUNCTION selena_audit.reject_immutable_mutation() FROM PUBLIC;

CREATE TRIGGER content_versions_append_only
  BEFORE UPDATE OR DELETE ON selena_registry.content_versions
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
CREATE TRIGGER approvals_append_only
  BEFORE UPDATE OR DELETE ON selena_registry.approvals
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
CREATE TRIGGER release_manifests_append_only
  BEFORE UPDATE OR DELETE ON selena_release.release_manifests
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
CREATE TRIGGER dispatch_reservations_append_only
  BEFORE UPDATE OR DELETE ON selena_release.dispatch_reservations
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
CREATE TRIGGER publication_attempts_append_only
  BEFORE UPDATE OR DELETE ON selena_release.publication_attempts
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON selena_audit.audit_events
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
CREATE TRIGGER raw_platform_snapshots_append_only
  BEFORE UPDATE OR DELETE ON selena_ingest_raw.raw_platform_snapshots
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
CREATE TRIGGER metric_snapshots_append_only
  BEFORE UPDATE OR DELETE ON selena_performance.metric_snapshots
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
CREATE TRIGGER tracking_events_append_only
  BEFORE UPDATE OR DELETE ON selena_performance.tracking_events
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();

REVOKE ALL ON SCHEMA selena_registry, selena_release, selena_audit, selena_ingest_raw, selena_performance FROM PUBLIC;
REVOKE CREATE ON SCHEMA selena_registry, selena_release, selena_audit, selena_ingest_raw, selena_performance
  FROM selena_web_runtime, selena_registry_worker_runtime, selena_gateway_runtime, selena_trigger_runtime,
       selena_ingestion_runtime, selena_analytics_runtime, selena_scanner_runtime, selena_backup_restore;

GRANT USAGE ON SCHEMA selena_registry TO selena_web_runtime, selena_registry_worker_runtime,
  selena_gateway_runtime, selena_scanner_runtime;
GRANT USAGE ON SCHEMA selena_release TO selena_web_runtime, selena_registry_worker_runtime, selena_gateway_runtime;
GRANT USAGE ON SCHEMA selena_audit TO selena_web_runtime, selena_gateway_runtime;
GRANT USAGE ON SCHEMA selena_ingest_raw TO selena_ingestion_runtime;
GRANT USAGE ON SCHEMA selena_performance TO selena_ingestion_runtime, selena_analytics_runtime;

GRANT SELECT ON selena_registry.channel_accounts TO selena_web_runtime;
GRANT SELECT, INSERT, UPDATE ON selena_registry.content_items TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_registry.content_versions TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_registry.content_assets TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_registry.approvals TO selena_web_runtime;
GRANT SELECT, INSERT, UPDATE ON selena_registry.kill_switches TO selena_web_runtime;
GRANT SELECT, UPDATE (scan_status, scan_provider_event_ref, verified_at) ON selena_registry.content_assets TO selena_scanner_runtime;

GRANT SELECT (id, organization_id, brand_id, platform, manifest_hash, status, expires_at, created_at)
  ON selena_release.release_manifests TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_release.release_intents TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_release.outbox_events TO selena_web_runtime;
GRANT SELECT (id, organization_id, brand_id, release_manifest_id, channel_account_id, platform, provider_reference_id, status, occurred_at)
  ON selena_release.publication_attempts TO selena_web_runtime;
GRANT SELECT ON selena_audit.incidents TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_audit.audit_events TO selena_web_runtime;

GRANT SELECT, INSERT ON selena_release.release_manifests TO selena_gateway_runtime;
GRANT SELECT, INSERT, UPDATE ON selena_registry.channel_accounts TO selena_gateway_runtime;
GRANT SELECT, INSERT ON selena_release.dispatch_reservations TO selena_gateway_runtime;
GRANT SELECT, INSERT ON selena_release.publication_attempts TO selena_gateway_runtime;
GRANT SELECT, INSERT, UPDATE ON selena_audit.incidents TO selena_gateway_runtime;
GRANT INSERT ON selena_audit.audit_events TO selena_gateway_runtime;

GRANT SELECT, UPDATE (status, cancellation_reason) ON selena_release.release_intents
  TO selena_registry_worker_runtime;
GRANT SELECT, UPDATE (status, available_at, lease_owner, lease_expires_at, attempt_count, last_error, delivered_at)
  ON selena_release.outbox_events TO selena_registry_worker_runtime;

GRANT SELECT, INSERT ON selena_ingest_raw.raw_platform_snapshots TO selena_ingestion_runtime;
GRANT INSERT ON selena_performance.metric_snapshots, selena_performance.tracking_events TO selena_ingestion_runtime;
GRANT SELECT ON selena_performance.metric_snapshots, selena_performance.tracking_events TO selena_analytics_runtime;
GRANT SELECT ON selena_performance.metric_snapshots TO selena_web_runtime;

GRANT USAGE ON SCHEMA selena_registry, selena_release, selena_audit, selena_ingest_raw, selena_performance
  TO selena_backup_restore;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA selena_registry, selena_release, selena_audit, selena_ingest_raw, selena_performance
  TO selena_backup_restore;

ALTER DEFAULT PRIVILEGES FOR ROLE selena_schema_owner IN SCHEMA selena_registry
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE selena_schema_owner IN SCHEMA selena_release
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE selena_schema_owner IN SCHEMA selena_audit
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE selena_schema_owner IN SCHEMA selena_ingest_raw
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE selena_schema_owner IN SCHEMA selena_performance
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE selena_schema_owner IN SCHEMA selena_registry
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE selena_schema_owner IN SCHEMA selena_audit
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $$
DECLARE
  v_role text;
  v_schema text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      FOREACH v_schema IN ARRAY ARRAY[
        'selena_registry',
        'selena_release',
        'selena_audit',
        'selena_ingest_raw',
        'selena_performance'
      ]
      LOOP
        EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', v_schema, v_role);
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', v_schema, v_role);
        EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM %I', v_schema, v_role);
      END LOOP;
    END IF;
  END LOOP;
END $$;

COMMENT ON SCHEMA selena_registry IS
  'Private Selena Content Registry. Never expose through Supabase Data API.';
COMMENT ON SCHEMA selena_release IS
  'Private Release Gateway state. Never expose through Supabase Data API.';
COMMENT ON SCHEMA selena_audit IS
  'Private immutable Selena audit state. Never expose through Supabase Data API.';
COMMENT ON SCHEMA selena_ingest_raw IS
  'Private append-only provider payloads. Never expose through Supabase Data API.';
COMMENT ON SCHEMA selena_performance IS
  'Private normalized performance and conversion records. Never expose through Supabase Data API.';
COMMENT ON TABLE selena_registry.content_assets IS
  'Storage contract only: private bucket, server-mediated upload, SHA-256, MIME/size validation, scanner evidence, immutable originals, derivatives, signed downloads, object versioning, and storage backup/restore are external implementation requirements.';
RESET ROLE;

REVOKE ALL ON TABLE public.secrets FROM selena_web_runtime, selena_gateway_runtime, selena_trigger_runtime,
  selena_ingestion_runtime, selena_analytics_runtime, selena_scanner_runtime;
