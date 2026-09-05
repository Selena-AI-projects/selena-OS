SET ROLE selena_schema_owner;

-- Custody of the release signing key.
--
-- The key exists so that exactly one component can sign a publication package.
-- Handing it to a person to paste into a hosting panel works against that: the
-- value then exists in a clipboard, a password manager and a deploy log before
-- it ever reaches the process that needs it. So the gateway mints its own pair
-- on first boot and keeps the private half here, where the database — not a
-- convention — decides who may read it.
CREATE TABLE IF NOT EXISTS selena_release.gateway_signing_keys (
  version         text PRIMARY KEY,
  public_key_pem  text NOT NULL,
  private_key_pem text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,

  -- NULL once retired, so the unique index below permits any number of retired
  -- keys and at most one live one.
  live            boolean GENERATED ALWAYS AS (CASE WHEN retired_at IS NULL THEN true END) STORED,

  CONSTRAINT gateway_signing_keys_version_shape
    CHECK (version ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT gateway_signing_keys_public_key_shape
    CHECK (public_key_pem LIKE '-----BEGIN PUBLIC KEY-----%'),
  CONSTRAINT gateway_signing_keys_private_key_shape
    CHECK (private_key_pem LIKE '-----BEGIN PRIVATE KEY-----%')
);

CREATE UNIQUE INDEX IF NOT EXISTS gateway_signing_keys_single_live
  ON selena_release.gateway_signing_keys (live);

ALTER TABLE selena_release.gateway_signing_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE selena_release.gateway_signing_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY gateway_signing_keys_schema_owner_select ON selena_release.gateway_signing_keys
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY gateway_signing_keys_schema_owner_insert ON selena_release.gateway_signing_keys
  FOR INSERT TO selena_schema_owner WITH CHECK (true);
CREATE POLICY gateway_signing_keys_schema_owner_update ON selena_release.gateway_signing_keys
  FOR UPDATE TO selena_schema_owner USING (true) WITH CHECK (true);

-- Everyone who has to check a signature needs the public half and nothing else.
-- The row is visible to them; the column grant below is what keeps the private
-- half out of reach, so both halves of the boundary are asserted in pgTAP.
CREATE POLICY gateway_signing_keys_verifier_select ON selena_release.gateway_signing_keys
  FOR SELECT TO selena_web_runtime, selena_scanner_runtime USING (true);

REVOKE ALL ON selena_release.gateway_signing_keys FROM PUBLIC;
GRANT SELECT (version, public_key_pem, created_at, retired_at)
  ON selena_release.gateway_signing_keys TO selena_web_runtime, selena_scanner_runtime;

-- The gateway reaches the table only through this function. Direct SELECT would
-- let a compromised runtime read retired keys as well as the live one, and
-- direct INSERT would let it install a key of its choosing beside the live one.
CREATE OR REPLACE FUNCTION selena_release.ensure_gateway_signing_key(
  p_version text,
  p_public_key_pem text,
  p_private_key_pem text
) RETURNS TABLE (version text, public_key_pem text, private_key_pem text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'selena_gateway_runtime', 'member') THEN
    RAISE EXCEPTION 'only the gateway runtime may obtain the release signing key';
  END IF;

  -- Two gateway replicas booting together would otherwise both see an empty
  -- table and both insert. The lock is transaction-scoped and this function is
  -- its own transaction when called as a single statement.
  PERFORM pg_advisory_xact_lock(hashtext('selena_release.gateway_signing_keys'));

  INSERT INTO selena_release.gateway_signing_keys (version, public_key_pem, private_key_pem)
  SELECT p_version, p_public_key_pem, p_private_key_pem
  WHERE NOT EXISTS (
    SELECT 1 FROM selena_release.gateway_signing_keys existing WHERE existing.retired_at IS NULL
  );

  RETURN QUERY
    SELECT live_key.version, live_key.public_key_pem, live_key.private_key_pem
    FROM selena_release.gateway_signing_keys live_key
    WHERE live_key.retired_at IS NULL;
END;
$$;

-- Rotation is deliberately not something the gateway can do to itself: a
-- runtime that could retire the live key could also force a fresh one to be
-- minted, and every manifest signed before that moment would stop verifying.
CREATE OR REPLACE FUNCTION selena_release.retire_gateway_signing_key(p_version text)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, public
AS $$
  UPDATE selena_release.gateway_signing_keys
  SET retired_at = now()
  WHERE version = p_version AND retired_at IS NULL;
$$;

REVOKE ALL ON FUNCTION selena_release.ensure_gateway_signing_key(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_release.retire_gateway_signing_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_release.ensure_gateway_signing_key(text, text, text) TO selena_gateway_runtime;

DO $$
BEGIN
  IF has_table_privilege('selena_gateway_runtime', 'selena_release.gateway_signing_keys', 'SELECT') THEN
    RAISE EXCEPTION 'gateway runtime must not read the signing key table directly';
  END IF;
  IF has_column_privilege('selena_web_runtime', 'selena_release.gateway_signing_keys', 'private_key_pem', 'SELECT') THEN
    RAISE EXCEPTION 'web runtime must not be able to read the private signing key';
  END IF;
END;
$$;

RESET ROLE;
