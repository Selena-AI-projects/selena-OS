CREATE TABLE "sv_qc_records" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "organization_id" text NOT NULL REFERENCES "organization"("id"), "order_id" uuid NOT NULL REFERENCES "sv_orders"("id"), "cycle_id" uuid REFERENCES "sv_cycles"("id"), "reviewer" text NOT NULL, "reviewed_at" timestamptz NOT NULL, "scope" text NOT NULL, "decision" text NOT NULL, "notes" text, "created_at" timestamptz DEFAULT now() NOT NULL);
CREATE INDEX "sv_qc_records_org_order_idx" ON "sv_qc_records" ("organization_id", "order_id");
ALTER TABLE "sv_qc_records" ENABLE ROW LEVEL SECURITY;
