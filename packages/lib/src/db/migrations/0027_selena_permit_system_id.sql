ALTER TABLE "sv_run_permits" ADD COLUMN IF NOT EXISTS "system_id" text;
ALTER TABLE "sv_runs" ADD COLUMN IF NOT EXISTS "system_id" text;
