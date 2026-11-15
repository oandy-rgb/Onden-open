-- 127: the workspace owner changes only through an ownership transfer
-- (docs/architecture/proposals/roles-owner-member-2026-10-22.md §3.5, decision 10).
--
-- Before: workspaces.owner_actor_id was ON DELETE SET NULL and freely updatable, so
-- a deletion path, a stray UPDATE or a future bug could leave the workspace with
-- no owner, and there was no legitimate way to hand it over.
--   * Deleting the owner's actor row is refused (RESTRICT): hand the workspace
--     over first (services/ownerTransfer.ts).
--   * Changing a SET owner is refused unless the transaction declares the new
--     owner in `onden.owner_transfer` (SET LOCAL) — which only the transfer
--     operation does. Setting the owner of an ownerless workspace (the first
--     person to sign in) is allowed; clearing it needs the declaration 'none'
--     (an operator's act; no API issues it).
--     Who may be the new owner (a person who has signed in) is the transfer
--     operation's rule, not the database's.

ALTER TABLE workspaces DROP CONSTRAINT workspaces_owner_actor_id_fkey;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_owner_actor_id_fkey
  FOREIGN KEY (owner_actor_id) REFERENCES actors(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION workspaces_guard_owner() RETURNS trigger AS $$
DECLARE
  declared text := current_setting('onden.owner_transfer', true);
BEGIN
  IF OLD.owner_actor_id IS NULL OR NEW.owner_actor_id IS NOT DISTINCT FROM OLD.owner_actor_id THEN
    RETURN NEW;
  END IF;
  IF declared IS NOT NULL AND declared <> ''
     AND (declared = NEW.owner_actor_id::text OR (declared = 'none' AND NEW.owner_actor_id IS NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the workspace owner changes only through an ownership transfer'
    USING ERRCODE = 'insufficient_privilege', HINT = 'POST /api/workspace/owner-transfer';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER workspaces_guard_owner BEFORE UPDATE OF owner_actor_id ON workspaces
  FOR EACH ROW EXECUTE FUNCTION workspaces_guard_owner();
