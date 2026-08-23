CREATE TABLE "prompt_run_hourly_aggregates" (
	"prompt_id" uuid NOT NULL REFERENCES "prompts"("id") ON DELETE CASCADE,
	"brand_id" text NOT NULL REFERENCES "brands"("id") ON DELETE CASCADE,
	"model" text NOT NULL,
	"provider" text,
	"web_search_enabled" boolean NOT NULL,
	"hour_bucket" timestamptz NOT NULL,
	"total_runs" integer NOT NULL,
	"brand_mentioned_count" integer NOT NULL,
	CONSTRAINT "prompt_run_hourly_aggregates_bucket_unique" UNIQUE NULLS NOT DISTINCT ("prompt_id", "model", "provider", "web_search_enabled", "hour_bucket")
);
--> statement-breakpoint
ALTER TABLE "prompt_run_hourly_aggregates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "prompt_run_hourly_aggregates_brand_hour_idx" ON "prompt_run_hourly_aggregates" ("brand_id", "hour_bucket");
--> statement-breakpoint
INSERT INTO "prompt_run_hourly_aggregates" ("prompt_id", "brand_id", "model", "provider", "web_search_enabled", "hour_bucket", "total_runs", "brand_mentioned_count")
SELECT
	"prompt_id",
	"brand_id",
	"model",
	"provider",
	"web_search_enabled",
	date_trunc('hour', "created_at") AS "hour_bucket",
	count(*)::int,
	count(*) FILTER (WHERE "brand_mentioned")::int
FROM "prompt_runs"
GROUP BY "prompt_id", "brand_id", "model", "provider", "web_search_enabled", date_trunc('hour', "created_at")
ON CONFLICT ("prompt_id", "model", "provider", "web_search_enabled", "hour_bucket") DO UPDATE
SET "total_runs" = excluded."total_runs",
	"brand_mentioned_count" = excluded."brand_mentioned_count";
