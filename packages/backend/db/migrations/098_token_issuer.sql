-- A token never reaches beyond the person who issued it
-- (docs/research/integration-audit-2026-10-13.md §4.4): its spaces are
-- min(issuer's spaces, the token's grant) — read needs the issuer to be in the
-- space, write needs the issuer to be an editor or manager there. Tokens were
-- only mintable by the workspace owner, so existing ones are attributed to the
-- owner.
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS issued_by uuid REFERENCES actors(id) ON DELETE SET NULL;
UPDATE agent_tokens t SET issued_by = w.owner_actor_id
  FROM actors a JOIN workspaces w ON w.id = a.workspace_id
 WHERE a.id = t.actor_id AND t.issued_by IS NULL AND w.owner_actor_id IS NOT NULL;
