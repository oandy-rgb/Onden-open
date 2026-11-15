-- Space membership is explicit (pre-invite list, docs/research/integration-audit-2026-10-13.md §4.3).
--
-- Until now a new member joined the default space 共用 automatically, and the
-- existing notes all live there: the second person invited would have seen
-- every note the owner ever wrote. Now a new member gets only their personal
-- space; the owner adds them to spaces (共用 included) in Settings › Spaces.
-- The first human admin becomes the workspace owner and manages the default
-- space; the System actor is added by the boot seeding (db.ts). Existing
-- memberships are left as they are.
CREATE OR REPLACE FUNCTION actors_sync_spaces() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  personal uuid;
  became_owner boolean := false;
BEGIN
  IF NEW.type = 'human' AND NEW.role = 'admin' THEN
    UPDATE workspaces SET owner_actor_id = NEW.id WHERE id = NEW.workspace_id AND owner_actor_id IS NULL;
    became_owner := FOUND;
  END IF;
  IF became_owner THEN
    INSERT INTO space_members (space_id, actor_id, role)
    SELECT s.id, NEW.id, 'manager' FROM spaces s WHERE s.workspace_id = NEW.workspace_id AND s.is_default
    ON CONFLICT (space_id, actor_id) DO NOTHING;
  END IF;
  IF NEW.type = 'human' AND NOT EXISTS (
       SELECT 1 FROM spaces WHERE owner_actor_id = NEW.id AND kind = 'personal' AND deleted_at IS NULL) THEN
    INSERT INTO spaces (workspace_id, name, kind, owner_actor_id, capabilities)
    VALUES (NEW.workspace_id, 'personal', 'personal', NEW.id,
            jsonb_build_object('publish', false, 'external_ai', false, 'shared_seen', false,
              'backup', COALESCE((SELECT owner_actor_id = NEW.id FROM workspaces WHERE id = NEW.workspace_id), false)))
    RETURNING id INTO personal;
    INSERT INTO space_members (space_id, actor_id, role) VALUES (personal, NEW.id, 'manager');
  END IF;
  RETURN NULL;
END $$;
