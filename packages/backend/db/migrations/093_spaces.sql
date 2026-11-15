-- Spaces (docs/architecture/spaces.md, phase 1a).
--
-- Every note lives in exactly one space; space membership (viewer / editor /
-- manager) will decide who can read and write it. Tags never carry permission
-- and their definitions are global (space_id NULL).
--
-- Phase 1a only ADDS the structure and keeps it consistent. Reads and writes
-- are still decided by the old rules; the space rule runs beside them in
-- shadow mode (services/spaces.ts) until phase 3 switches over. So this
-- migration must not change what anyone can see:
--   * one shared default space 「共用」 holds every existing note, with every
--     member in it (viewer → viewer, editor/reviewer → editor, admin → manager)
--     and every capability on (publish / external_ai / backup keep working);
--   * each human gets an empty personal space.

-- The workspace owner: the one principal the spaces design gives permission
-- administration to. Today "principal" means any non-token admin; the owner is
-- the earliest human admin.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS owner_actor_id uuid REFERENCES actors(id) ON DELETE SET NULL;
UPDATE workspaces w
   SET owner_actor_id = (
     SELECT a.id FROM actors a
      WHERE a.workspace_id = w.id AND a.type = 'human' AND a.role = 'admin'
      ORDER BY a.created_at, a.id LIMIT 1)
 WHERE w.owner_actor_id IS NULL;

CREATE TABLE IF NOT EXISTS spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('personal', 'shared', 'system')),
  -- The personal space's person.
  owner_actor_id uuid REFERENCES actors(id) ON DELETE SET NULL,
  -- Where a note goes when nothing else says (root creates without a space
  -- during phases 1–2). Exactly one per workspace.
  is_default boolean NOT NULL DEFAULT false,
  -- {"publish": bool, "external_ai": bool, "backup": bool, "shared_seen": bool}
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS spaces_one_default_idx ON spaces (workspace_id) WHERE is_default;
CREATE UNIQUE INDEX IF NOT EXISTS spaces_one_personal_idx ON spaces (owner_actor_id) WHERE kind = 'personal' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS space_members (
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer', 'editor', 'manager')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (space_id, actor_id)
);
CREATE INDEX IF NOT EXISTS space_members_actor_idx ON space_members (actor_id);

ALTER TABLE content_nodes ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES spaces(id);
CREATE INDEX IF NOT EXISTS content_nodes_space_idx ON content_nodes (workspace_id, space_id) WHERE deleted_at IS NULL;

-- Backfill: the default shared space, its members, personal spaces.
INSERT INTO spaces (workspace_id, name, kind, is_default, capabilities)
SELECT w.id, '共用', 'shared', true,
       '{"publish": true, "external_ai": true, "backup": true, "shared_seen": false}'::jsonb
  FROM workspaces w
 WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.workspace_id = w.id AND s.is_default);

INSERT INTO space_members (space_id, actor_id, role)
SELECT s.id, a.id,
       CASE a.role WHEN 'viewer' THEN 'viewer' WHEN 'admin' THEN 'manager' ELSE 'editor' END
  FROM spaces s JOIN actors a ON a.workspace_id = s.workspace_id
 WHERE s.is_default
ON CONFLICT (space_id, actor_id) DO NOTHING;

INSERT INTO spaces (workspace_id, name, kind, owner_actor_id, capabilities)
SELECT a.workspace_id, 'personal', 'personal', a.id,
       '{"publish": false, "external_ai": false, "backup": true, "shared_seen": false}'::jsonb
  FROM actors a
 WHERE a.type = 'human'
   AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.owner_actor_id = a.id AND s.kind = 'personal' AND s.deleted_at IS NULL);

INSERT INTO space_members (space_id, actor_id, role)
SELECT s.id, s.owner_actor_id, 'manager' FROM spaces s
 WHERE s.kind = 'personal' AND s.owner_actor_id IS NOT NULL
ON CONFLICT (space_id, actor_id) DO NOTHING;

UPDATE content_nodes n
   SET space_id = s.id
  FROM spaces s
 WHERE s.workspace_id = n.workspace_id AND s.is_default
   AND n.space_id IS NULL AND n.node_type <> 'class_tag';

-- A note's space: tag definitions are global (NULL); everything else has one.
-- Derived on write so the many INSERT paths need no change: a child takes its
-- parent's space (a tag parent is "global", so it does not pass one down), and
-- a root falls back to the workspace's default space.
CREATE OR REPLACE FUNCTION content_nodes_derive_space() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_space uuid;
  parent_type text;
BEGIN
  IF NEW.node_type = 'class_tag' THEN
    NEW.space_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.space_id IS NULL THEN
    IF NEW.parent_id IS NOT NULL THEN
      SELECT space_id, node_type INTO parent_space, parent_type FROM content_nodes WHERE id = NEW.parent_id;
      IF parent_type IS DISTINCT FROM 'class_tag' THEN NEW.space_id := parent_space; END IF;
    END IF;
    IF NEW.space_id IS NULL THEN
      SELECT id INTO NEW.space_id FROM spaces WHERE workspace_id = NEW.workspace_id AND is_default;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS content_nodes_derive_space ON content_nodes;
CREATE TRIGGER content_nodes_derive_space
  BEFORE INSERT OR UPDATE OF space_id, parent_id, node_type ON content_nodes
  FOR EACH ROW EXECUTE FUNCTION content_nodes_derive_space();

-- A child is always in its parent's space (unless the parent is a global tag).
-- Checked at COMMIT (deferred) so a whole subtree can move in one statement in
-- any row order. Checked from both sides: the row's own parent, and the row's
-- children (a node whose space changed must have brought its children along).
CREATE OR REPLACE FUNCTION content_nodes_check_space() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cur record;
  bad uuid;
BEGIN
  SELECT id, parent_id, space_id, node_type INTO cur FROM content_nodes WHERE id = NEW.id;
  IF NOT FOUND OR cur.node_type = 'class_tag' THEN RETURN NULL; END IF;
  IF cur.parent_id IS NOT NULL THEN
    SELECT p.id INTO bad FROM content_nodes p
     WHERE p.id = cur.parent_id AND p.node_type <> 'class_tag' AND p.space_id IS DISTINCT FROM cur.space_id;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION 'node % is in a different space than its parent %', cur.id, bad
        USING ERRCODE = 'check_violation', CONSTRAINT = 'content_nodes_space_matches_parent';
    END IF;
  END IF;
  SELECT c.id INTO bad FROM content_nodes c
   WHERE c.parent_id = cur.id AND c.node_type <> 'class_tag' AND c.space_id IS DISTINCT FROM cur.space_id
   LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'node % is in a different space than its parent %', bad, cur.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'content_nodes_space_matches_parent';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS content_nodes_check_space ON content_nodes;
CREATE CONSTRAINT TRIGGER content_nodes_check_space
  AFTER INSERT OR UPDATE OF space_id, parent_id, node_type ON content_nodes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION content_nodes_check_space();

-- Phases 1–2 keep space membership in step with the old model, so the shadow
-- comparison measures the real policy differences and nothing else:
--   * a new workspace gets its default shared space;
--   * every actor is in the default space with the role-mapped space role,
--     updated when the role changes;
--   * every human gets a personal space;
--   * the first human admin becomes the workspace owner.
-- Phase 3 drops these triggers; membership is then managed only through the
-- spaces API.
CREATE OR REPLACE FUNCTION workspaces_default_space() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO spaces (workspace_id, name, kind, is_default, capabilities)
  VALUES (NEW.id, '共用', 'shared', true, '{"publish": true, "external_ai": true, "backup": true, "shared_seen": false}'::jsonb)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS workspaces_default_space ON workspaces;
CREATE TRIGGER workspaces_default_space AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION workspaces_default_space();

CREATE OR REPLACE FUNCTION actors_sync_spaces() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  personal uuid;
BEGIN
  INSERT INTO space_members (space_id, actor_id, role)
  SELECT s.id, NEW.id,
         CASE NEW.role WHEN 'viewer' THEN 'viewer' WHEN 'admin' THEN 'manager' ELSE 'editor' END
    FROM spaces s WHERE s.workspace_id = NEW.workspace_id AND s.is_default
  ON CONFLICT (space_id, actor_id) DO UPDATE SET role = EXCLUDED.role;
  IF TG_OP = 'INSERT' AND NEW.type = 'human' THEN
    IF NOT EXISTS (SELECT 1 FROM spaces WHERE owner_actor_id = NEW.id AND kind = 'personal' AND deleted_at IS NULL) THEN
      INSERT INTO spaces (workspace_id, name, kind, owner_actor_id, capabilities)
      VALUES (NEW.workspace_id, 'personal', 'personal', NEW.id,
              '{"publish": false, "external_ai": false, "backup": true, "shared_seen": false}'::jsonb)
      RETURNING id INTO personal;
      INSERT INTO space_members (space_id, actor_id, role) VALUES (personal, NEW.id, 'manager');
    END IF;
  END IF;
  IF NEW.type = 'human' AND NEW.role = 'admin' THEN
    UPDATE workspaces SET owner_actor_id = NEW.id WHERE id = NEW.workspace_id AND owner_actor_id IS NULL;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS actors_sync_spaces ON actors;
CREATE TRIGGER actors_sync_spaces AFTER INSERT OR UPDATE OF role ON actors
  FOR EACH ROW EXECUTE FUNCTION actors_sync_spaces();
