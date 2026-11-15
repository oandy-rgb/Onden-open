-- Removing a member ends the tokens they issued (W35). Migration 098 bounds a
-- token by its issuer's spaces, but issued_by is ON DELETE SET NULL and a NULL
-- issuer meant "keep the stored grant": deleting the issuer WIDENED their
-- tokens to the raw grant. DELETE /api/actors/:id now revokes them
-- (services/agentTokens.ts revokeTokensIssuedBy); this column records that the
-- token once had an issuer who is gone, so the effective spaces
-- (services/currentActor.ts EFFECTIVE_TOKEN_SPACES_SQL) are empty for it even
-- if some other path deletes the actor. A NULL issuer without this mark is a
-- token 098 could not attribute (no workspace owner then) and keeps its grant.
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS issuer_removed_at timestamptz;

CREATE OR REPLACE FUNCTION mark_tokens_issuer_removed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agent_tokens SET issuer_removed_at = now()
   WHERE issued_by = OLD.id AND issuer_removed_at IS NULL;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS actors_mark_tokens_issuer_removed ON actors;
CREATE TRIGGER actors_mark_tokens_issuer_removed BEFORE DELETE ON actors
  FOR EACH ROW EXECUTE FUNCTION mark_tokens_issuer_removed();
