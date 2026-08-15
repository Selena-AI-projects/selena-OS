CREATE TABLE IF NOT EXISTS "sv_website_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id"),
  "project_id" uuid NOT NULL REFERENCES "sv_projects"("id"),
  "website" text NOT NULL,
  "content_hash" text NOT NULL,
  "captured_at" timestamptz NOT NULL,
  "snapshot" jsonb NOT NULL,
  "immutable" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "sv_website_snapshots_project_hash_unique" ON "sv_website_snapshots" ("project_id", "content_hash");
CREATE INDEX IF NOT EXISTS "sv_website_snapshots_org_idx" ON "sv_website_snapshots" ("organization_id");
CREATE INDEX IF NOT EXISTS "sv_website_snapshots_project_idx" ON "sv_website_snapshots" ("project_id");
ALTER TABLE "sv_website_snapshots" ENABLE ROW LEVEL SECURITY;
