-- 150_ai_runtime_api.sql
--
-- AI 跑法 API (docs/architecture/proposals/ai-collaboration-2026-10-27.md §3.1, §3.3, §4.2;
-- 業主 2026-10-30 同意第 9 節第 1 題：伺服器可用使用者自己的 API 金鑰呼叫模型，
-- 但工具、權限、寫入、紀錄與 MCP 同一份)。
--
-- Not done here (other batches of the proposal): renaming agent_runners to ai_roles,
-- ai_suggestions. The columns below sit on agent_runners as it is today.

-- The owner's own Anthropic API keys. Only the AES-256-GCM ciphertext is stored
-- (key: ONDEN_SECRET_KEY, a deploy environment variable — never in the database);
-- the API shows the last four characters only. A database backup holds the
-- ciphertext, so the backup and ONDEN_SECRET_KEY must be kept apart (docs/agents/deploy.md).
CREATE TABLE IF NOT EXISTS ai_credentials (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label             text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  secret_ciphertext bytea NOT NULL,
  secret_last4      text NOT NULL CHECK (char_length(secret_last4) = 4),
  created_by        uuid NOT NULL REFERENCES actors(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz
);
CREATE INDEX IF NOT EXISTS ai_credentials_live_idx ON ai_credentials (workspace_id) WHERE revoked_at IS NULL;

-- Per-agent API settings. There is NO default model: api_model is chosen by the
-- owner from the key's own model list. api_cap_choice records that the owner
-- answered the "monthly cap or unlimited" question the first time API was
-- switched on; an API role cannot run before it is answered.
ALTER TABLE agent_runners
  ADD COLUMN IF NOT EXISTS default_runtime         text NOT NULL DEFAULT 'subscription'
    CHECK (default_runtime IN ('api','subscription','mcp')),
  ADD COLUMN IF NOT EXISTS api_credential_id       uuid REFERENCES ai_credentials(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS api_model               text,
  ADD COLUMN IF NOT EXISTS api_small_actions_only  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS api_web_search          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS api_model_retired_at   timestamptz,  -- the model's lifecycle went 'retired': the API runtime pauses until a new one is chosen
  ADD COLUMN IF NOT EXISTS api_cap_choice          text CHECK (api_cap_choice IN ('capped','unlimited')),
  ADD COLUMN IF NOT EXISTS monthly_cap_micro_usd   bigint CHECK (monthly_cap_micro_usd > 0);
ALTER TABLE agent_runners DROP CONSTRAINT IF EXISTS agent_runners_api_needs_key_and_model;
ALTER TABLE agent_runners ADD CONSTRAINT agent_runners_api_needs_key_and_model
  CHECK (default_runtime <> 'api' OR (api_credential_id IS NOT NULL AND api_model IS NOT NULL AND api_cap_choice IS NOT NULL));
ALTER TABLE agent_runners DROP CONSTRAINT IF EXISTS agent_runners_cap_matches_choice;
ALTER TABLE agent_runners ADD CONSTRAINT agent_runners_cap_matches_choice
  CHECK (api_cap_choice IS DISTINCT FROM 'capped' OR monthly_cap_micro_usd IS NOT NULL);

-- Sessions record which runtime ran them. write_mode is derived from the runtime
-- and fixed by the database: an API session is always 'suggest' (it can only
-- propose), whatever a client sends. 'apply' is today's behaviour of the
-- subscription runner and MCP, which stays as it is.
ALTER TABLE agent_sessions
  ADD COLUMN IF NOT EXISTS runtime  text NOT NULL DEFAULT 'subscription' CHECK (runtime IN ('api','subscription','mcp')),
  ADD COLUMN IF NOT EXISTS kind     text NOT NULL DEFAULT 'mention' CHECK (kind IN ('mention','selection_action','panel_chat')),
  ADD COLUMN IF NOT EXISTS model    text,
  ADD COLUMN IF NOT EXISTS write_mode text NOT NULL DEFAULT 'apply' CHECK (write_mode IN ('suggest','apply')),
  ADD COLUMN IF NOT EXISTS input_tokens        bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_tokens       bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_read_tokens   bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_estimate_micro_usd bigint,
  ADD COLUMN IF NOT EXISTS turns               int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skill_ref          text,   -- a selection action's built-in skill id (a note skill is skill_node_id)
  ADD COLUMN IF NOT EXISTS request_id          uuid;
ALTER TABLE agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_api_suggests_only;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_api_suggests_only
  CHECK (runtime <> 'api' OR (write_mode = 'suggest' AND model IS NOT NULL));
-- A selection action has no @mention to anchor to.
ALTER TABLE agent_sessions ALTER COLUMN anchor_block_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_request_uidx
  ON agent_sessions (workspace_id, initiator_id, request_id) WHERE request_id IS NOT NULL;

ALTER TABLE agent_session_events DROP CONSTRAINT IF EXISTS agent_session_events_kind_check;
ALTER TABLE agent_session_events ADD CONSTRAINT agent_session_events_kind_check
  CHECK (kind IN ('ack','thought','action','message','error','result','read','search','usage'));
