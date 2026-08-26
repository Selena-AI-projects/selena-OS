ALTER TABLE "sv_cost_events" ALTER COLUMN "cycle_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "sv_cost_events" ADD COLUMN "kind" text DEFAULT 'measurement' NOT NULL;
--> statement-breakpoint
CREATE INDEX "sv_cost_events_kind_created_idx" ON "sv_cost_events" ("kind", "created_at");
