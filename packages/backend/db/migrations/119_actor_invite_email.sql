-- 119_actor_invite_email.sql
--
-- Adding a person is an invite with an email (audit D110). Until now the owner
-- could add a "human" by name only (Settings › Users & Agents) and nothing ever
-- linked it to a login: when that person signed up, session resolution made a
-- SECOND actor for them, a viewer with only a personal space, and the role and
-- spaces the owner had set stayed on a row nobody could sign in as.
--
-- Now the owner gives the email; the row waits (external_id NULL) until the
-- first sign-in through the owner's one-time invite link, with that email,
-- claims it (services/actors.ts actorForSession), keeping its role and spaces.
-- Signup on a closed server (ONDEN_SIGNUP first-only) lets a valid invite
-- link with a matching email through (auth.ts).
--
-- Stored normalised (trimmed, lower case) so the claim and the uniqueness check
-- compare one form. The address stays on the row after the claim, as the record
-- of whom the owner invited; only an unclaimed invite reserves it.
ALTER TABLE actors ADD COLUMN IF NOT EXISTS invite_email text;
ALTER TABLE actors DROP CONSTRAINT IF EXISTS actors_invite_email_normalised;
ALTER TABLE actors ADD CONSTRAINT actors_invite_email_normalised
  CHECK (invite_email IS NULL OR (invite_email = lower(btrim(invite_email)) AND invite_email <> ''));
CREATE UNIQUE INDEX IF NOT EXISTS actors_pending_invite_email_uq ON actors (workspace_id, invite_email)
  WHERE type = 'human' AND external_id IS NULL AND invite_email IS NOT NULL;
-- The one-time invite link: only the token's sha256 is kept (as
-- agent_tokens.token_hash), valid 14 days, spent by the claim. The claim needs
-- BOTH this token and the login's email to match: knowing the address alone
-- no longer takes the invite.
ALTER TABLE actors ADD COLUMN IF NOT EXISTS invite_token_hash text;
ALTER TABLE actors ADD COLUMN IF NOT EXISTS invite_expires_at timestamptz;
ALTER TABLE actors ADD COLUMN IF NOT EXISTS invite_used_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS actors_invite_token_hash_uq ON actors (invite_token_hash)
  WHERE invite_token_hash IS NOT NULL;
