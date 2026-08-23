ALTER TABLE "reports" ADD COLUMN "organization_id" text REFERENCES "organization"("id");
--> statement-breakpoint
CREATE INDEX "reports_organization_idx" ON "reports" ("organization_id");
