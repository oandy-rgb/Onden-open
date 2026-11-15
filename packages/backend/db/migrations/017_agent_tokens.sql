-- Agent identity tokens.
--
-- Each row mints a bearer token for an actor (typically type='agent'). The plaintext
-- token is shown to the admin exactly once at mint time; the DB only stores its
-- SHA-256 hash. Auth middleware looks up by hash on each request.
--
-- Tokens are scoped to the actor's workspace via the FK chain (actors.workspace_id).

CREATE TABLE IF NOT EXISTS agent_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  name         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS agent_tokens_actor_idx ON agent_tokens (actor_id);
