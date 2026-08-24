CREATE TABLE "sv_order_requests" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "organization_id" text NOT NULL REFERENCES "organization"("id"), "project_id" uuid NOT NULL REFERENCES "sv_projects"("id"), "plan_id" text NOT NULL, "contact_name" text NOT NULL, "contact_channel" text NOT NULL, "comment" text, "promo_code" text, "promo_applied" boolean DEFAULT false NOT NULL, "status" text DEFAULT 'NEW' NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL);
--> statement-breakpoint
CREATE INDEX "sv_order_requests_org_created_idx" ON "sv_order_requests" ("organization_id", "created_at");
--> statement-breakpoint
ALTER TABLE "sv_order_requests" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_order_requests"
	USING ("organization_id" = current_setting('app.organization_id', true));
