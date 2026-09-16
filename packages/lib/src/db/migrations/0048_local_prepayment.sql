SET ROLE selena_schema_owner;

-- Prepared orders never enter sv_orders or any worker dispatch queue.
CREATE TABLE selena_registry.local_prepayment_restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES public.organization(id),
  created_by text NOT NULL,
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND payload->>'confirmed' IS NOT DISTINCT FROM 'true'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, request_key),
  UNIQUE (id, organization_id)
);
CREATE TABLE selena_registry.local_prepayment_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES public.organization(id),
  created_by text NOT NULL,
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object'
    AND payload->>'product' IS NOT DISTINCT FROM 'LOCAL_MAPS_ONE_OFF'
    AND payload->>'status' IS NOT DISTINCT FROM 'PREPARED'
    AND payload->>'paymentMode' IS NOT DISTINCT FROM 'DISABLED'
    AND payload->>'executionMode' IS NOT DISTINCT FROM 'DISABLED'
    AND payload->>'priceAmount' IS NOT DISTINCT FROM '49.00'
    AND payload->>'currency' IS NOT DISTINCT FROM 'USD'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  restaurant_id uuid GENERATED ALWAYS AS ((payload->>'restaurantId')::uuid) STORED NOT NULL,
  UNIQUE (organization_id, request_key),
  FOREIGN KEY (restaurant_id, organization_id)
    REFERENCES selena_registry.local_prepayment_restaurants(id, organization_id)
);
CREATE TABLE selena_registry.local_retained_reports (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL REFERENCES public.organization(id),
  title text NOT NULL,
  payload jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  source_reference text NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (payload->>'organizationId' IS NOT DISTINCT FROM organization_id),
  CHECK (payload->>'reportId' IS NOT DISTINCT FROM id::text),
  CHECK (payload->>'measurementMode' IS NOT DISTINCT FROM 'PROVIDER'),
  CHECK (payload->>'publication' IS NOT DISTINCT FROM 'PUBLISHED')
);

CREATE FUNCTION selena_registry.local_prepayment_access(org text, writing boolean)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  SELECT org = current_setting('app.local_organization_id', true)
    AND EXISTS (SELECT 1 FROM public.member m
      WHERE m.organization_id = org AND m.user_id = current_setting('app.local_actor_id', true)
      AND (NOT writing OR m.role IN ('owner', 'admin')))
$$;
REVOKE ALL ON FUNCTION selena_registry.local_prepayment_access(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_registry.local_prepayment_access(text, boolean) TO selena_web_runtime;

DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['local_prepayment_restaurants','local_prepayment_orders','local_retained_reports'] LOOP
    EXECUTE format('ALTER TABLE selena_registry.%I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE selena_registry.%I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY local_read ON selena_registry.%I FOR SELECT TO selena_web_runtime USING (selena_registry.local_prepayment_access(organization_id,false))', tab);
    EXECUTE format('CREATE POLICY local_schema_owner ON selena_registry.%I TO selena_schema_owner USING (true) WITH CHECK (true)', tab);
    EXECUTE format('GRANT SELECT ON selena_registry.%I TO selena_web_runtime', tab);
    IF tab <> 'local_retained_reports' THEN
      EXECUTE format('CREATE POLICY local_create ON selena_registry.%I FOR INSERT TO selena_web_runtime WITH CHECK (selena_registry.local_prepayment_access(organization_id,true) AND created_by=current_setting(''app.local_actor_id'',true))', tab);
      EXECUTE format('GRANT INSERT ON selena_registry.%I TO selena_web_runtime', tab);
    END IF;
  END LOOP;
END $$;
RESET ROLE;
