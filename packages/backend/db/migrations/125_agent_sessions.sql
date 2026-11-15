-- 125_agent_sessions.sql
--
-- @提及 AI 代理 (docs/architecture/proposals/agent-mentions-2026-10-22.md §2):
-- a person explicitly sends a mention in a note; Onden keeps ONE durable
-- session per mention, the agent's runner pulls it (long-poll /pending →
-- /claim), reports progress to an append-only log and finishes it; the server
-- writes the reply under the mention.
--
-- Differences from the proposal (owner decisions 2026-10-23: the runner always
-- PULLS, no webhook): agent_runners has no mode / webhook_url / signing_secret;
-- agent_sessions has claimed_by_token_id so a lost /claim response can be
-- retried by the same runner token only.

-- One row per agent that can be @mentioned: its @handle and its limits. `enabled`
-- is the per-agent kill switch; the handle grammar is packages/markdown mentions.ts (services/agentSessions.ts setRunnerEnabled).
CREATE TABLE IF NOT EXISTS agent_runners (
  actor_id        uuid PRIMARY KEY REFERENCES actors(id) ON DELETE CASCADE,  -- type = 'agent'
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  handle          text NOT NULL CHECK (handle = lower(handle) AND char_length(handle) BETWEEN 1 AND 32),
  enabled         boolean NOT NULL DEFAULT false,
  paused_until    timestamptz,
  max_concurrent  int NOT NULL DEFAULT 2 CHECK (max_concurrent > 0),
  max_per_hour    int NOT NULL DEFAULT 30 CHECK (max_per_hour > 0),
  timeout_seconds int NOT NULL DEFAULT 600 CHECK (timeout_seconds > 0),
  UNIQUE (workspace_id, handle)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_actor_id     uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  initiator_id       uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,  -- who pressed send
  node_id            uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  space_id           uuid NOT NULL,          -- the note's space when sent: the session token's only space
  anchor_block_id    text NOT NULL,          -- ^id of the block holding the mention
  revision           int  NOT NULL DEFAULT 1,  -- re-sends of the same mention (not a sync cursor)
  parent_session_id  uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  prompt             text NOT NULL,          -- snapshot of the text after @handle (skill reference removed)
  lead_in            text NOT NULL DEFAULT '', -- text of the block before @handle
  skill_node_id      uuid,                   -- NULL = the built-in `mention` skill
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN
                       ('queued','delivered','running','completed','failed','cancelled')),
  fail_code          text,
  root_event_id      bigint REFERENCES domain_events(id) ON DELETE SET NULL,  -- AGENT_SESSION_STARTED: the chain root
  reply_event_id     bigint REFERENCES domain_events(id) ON DELETE SET NULL,
  attempt            int  NOT NULL DEFAULT 0,
  claimed_by_token_id uuid,                  -- the runner token that claimed it
  created_at         timestamptz NOT NULL DEFAULT now(),
  delivered_at       timestamptz,
  acked_at           timestamptz,
  finished_at        timestamptz,
  deadline_at        timestamptz NOT NULL,   -- created_at + the agent's timeout_seconds
  UNIQUE (workspace_id, node_id, anchor_block_id, revision)  -- one mention, one session
);
CREATE INDEX IF NOT EXISTS agent_sessions_open_idx ON agent_sessions (agent_actor_id, created_at)
  WHERE status IN ('queued','delivered','running');
CREATE INDEX IF NOT EXISTS agent_sessions_agent_recent_idx ON agent_sessions (agent_actor_id, created_at DESC);

-- Append-only progress log. Not a domain event stream: it never syncs and
-- is never restored.
CREATE TABLE IF NOT EXISTS agent_session_events (
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq        int  NOT NULL,                  -- chosen by the runner: (session_id, seq) de-duplicates re-sends
  kind       text NOT NULL CHECK (kind IN ('ack','thought','action','message','error','result')),
  body       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);

-- A session token belongs to one session and dies with it.
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES agent_sessions(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS agent_tokens_session_idx ON agent_tokens (session_id) WHERE session_id IS NOT NULL;
