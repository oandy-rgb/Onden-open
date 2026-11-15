-- Instance-level settings/secrets (memos' instance-setting pattern): values
-- the SERVER consumes (e.g. the Anthropic API key) — never node attributes
-- (those leak through list/publish surfaces). Plaintext by design: same trust
-- domain as .env on a self-hosted box; a DB-side master key would be circular.
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
