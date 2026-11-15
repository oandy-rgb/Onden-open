-- 152_ai_runner_seen.sql
--
-- When the subscription runner last asked for work (the long poll on
-- /api/mcp/sessions/pending). The settings page turns it into "online / offline /
-- last seen"; whether the runner can be used is computed from this fact, never
-- stored as a flag (proposal 2026-10-27 §3.1, §5.6). Diagnostic only: no event.
ALTER TABLE agent_runners
  ADD COLUMN IF NOT EXISTS runner_seen_at timestamptz;
