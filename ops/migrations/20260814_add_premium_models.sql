-- Production hotfix validated on a restored backup before application.
-- Exact upstream 0012 definition: text[] NOT NULL DEFAULT '{}'.
ALTER TABLE "prompts"
  ADD COLUMN IF NOT EXISTS "premium_models" text[] DEFAULT '{}'::text[] NOT NULL;

-- Rollback (execute separately only with owner approval after disabling jobs):
-- ALTER TABLE "prompts" DROP COLUMN IF EXISTS "premium_models";
