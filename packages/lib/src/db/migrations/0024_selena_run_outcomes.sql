ALTER TABLE "sv_runs" ADD COLUMN IF NOT EXISTS "validity" text;
ALTER TABLE "sv_runs" ADD COLUMN IF NOT EXISTS "invalid_reason" text;
ALTER TABLE "sv_runs" ADD COLUMN IF NOT EXISTS "cost_usd" numeric(12, 6);
