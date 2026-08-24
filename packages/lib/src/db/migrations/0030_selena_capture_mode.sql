ALTER TABLE "sv_runs" ADD COLUMN IF NOT EXISTS "capture_mode" text;
ALTER TABLE "sv_response_mentions" ADD COLUMN IF NOT EXISTS "capture_mode" text;
ALTER TABLE "sv_runs" ADD CONSTRAINT "sv_runs_capture_mode_known" CHECK ("capture_mode" IS NULL OR "capture_mode" IN ('live_search', 'training_data', 'unknown'));
ALTER TABLE "sv_response_mentions" ADD CONSTRAINT "sv_response_mentions_capture_mode_known" CHECK ("capture_mode" IS NULL OR "capture_mode" IN ('live_search', 'training_data', 'unknown'));
