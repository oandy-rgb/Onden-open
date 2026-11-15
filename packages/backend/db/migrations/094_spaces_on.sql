-- Spaces decide access from now on (docs/architecture/spaces.md).
--
-- One-time conversion, then the old tag-permission model goes:
--   * notes already sit in the default shared space (migration 093), with
--     every member in it and every capability on — nobody's access changes;
--   * the cases the old model could express and spaces cannot are handled
--     fail-closed (each logged with RAISE NOTICE):
--       - a note carrying a tag with an access policy (and its subtree) moves
--         into an owner-only space 「受限」, detached from an unrestricted parent;
--       - a member limited to some tags (scoped_tag_ids) leaves the default
--         space and keeps only their personal space;
--       - an agent token limited to some tags (allowed_tag_ids) is left with no
--         spaces until it is re-scoped;
--   * tag policies, member tag scopes, token tag scopes and the epoch bump on
--     every tagging are removed.

-- Agent tokens reach spaces: NULL = every space the token's agent belongs
-- to, further limited to spaces whose external_ai switch is on.
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS read_space_ids uuid[];
ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS write_space_ids uuid[];

DO $$
DECLARE
  w record;
  owner uuid;
  restricted uuid;
  root record;
  moved int;
  n int;
BEGIN
  FOR w IN SELECT id, owner_actor_id FROM workspaces LOOP
    owner := w.owner_actor_id;
    -- Notes directly carrying a policy-bearing tag, with no such tag above
    -- them (their subtree comes along).
    FOR root IN
      WITH policy_tags AS (
        SELECT id FROM content_nodes
         WHERE workspace_id = w.id AND node_type = 'class_tag'
           AND jsonb_typeof(tag_schema->'policy') = 'object' AND tag_schema->'policy' <> '{}'::jsonb
      ), tagged AS (
        SELECT DISTINCT nt.node_id AS id FROM node_tags nt JOIN policy_tags p ON p.id = nt.tag_id
          JOIN content_nodes c ON c.id = nt.node_id AND c.node_type <> 'class_tag'
      )
      SELECT t.id, c.parent_id FROM tagged t JOIN content_nodes c ON c.id = t.id
       WHERE NOT EXISTS (
         WITH RECURSIVE up AS (
           SELECT c.parent_id AS id
           UNION
           SELECT p.parent_id FROM content_nodes p JOIN up ON p.id = up.id WHERE p.parent_id IS NOT NULL
         )
         SELECT 1 FROM up JOIN tagged t2 ON t2.id = up.id)
    LOOP
      IF restricted IS NULL OR NOT EXISTS (SELECT 1 FROM spaces WHERE id = restricted AND workspace_id = w.id) THEN
        INSERT INTO spaces (workspace_id, name, kind, capabilities)
        VALUES (w.id, '受限', 'shared', '{"publish": false, "external_ai": false, "backup": true, "shared_seen": false}'::jsonb)
        RETURNING id INTO restricted;
        IF owner IS NOT NULL THEN
          INSERT INTO space_members (space_id, actor_id, role) VALUES (restricted, owner, 'manager');
        END IF;
        RAISE NOTICE 'spaces: workspace % had notes behind tag access policies; they move to an owner-only space 受限 (%)', w.id, restricted;
      END IF;
      UPDATE content_nodes SET parent_id = NULL WHERE id = root.id AND root.parent_id IS NOT NULL;
      WITH RECURSIVE sub AS (
        SELECT root.id AS id
        UNION
        SELECT c.id FROM content_nodes c JOIN sub ON c.parent_id = sub.id WHERE c.node_type <> 'class_tag'
      )
      UPDATE content_nodes SET space_id = restricted WHERE id IN (SELECT id FROM sub);
      GET DIAGNOSTICS moved = ROW_COUNT;
      RAISE NOTICE 'spaces: note % and % notes under it moved to 受限', root.id, moved - 1;
    END LOOP;
    restricted := NULL;

    -- Members limited to some tags: fail closed to their personal space.
    -- (Guarded: the column is gone once this migration has run.)
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'actors' AND column_name = 'scoped_tag_ids') THEN
      FOR root IN EXECUTE 'SELECT id, name FROM actors WHERE workspace_id = $1 AND scoped_tag_ids IS NOT NULL' USING w.id LOOP
        DELETE FROM space_members m USING spaces s
         WHERE m.space_id = s.id AND s.is_default AND s.workspace_id = w.id AND m.actor_id = root.id;
        RAISE NOTICE 'spaces: member % (%) was limited to some tags; now only their personal space until added to spaces', root.name, root.id;
      END LOOP;
    END IF;

    -- Tokens limited to some tags: no spaces until re-scoped.
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tokens' AND column_name = 'allowed_tag_ids') THEN
      EXECUTE 'UPDATE agent_tokens t SET read_space_ids = ''{}'', write_space_ids = ''{}''
                 FROM actors a WHERE a.id = t.actor_id AND a.workspace_id = $1 AND t.allowed_tag_ids IS NOT NULL' USING w.id;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN RAISE NOTICE 'spaces: % agent tokens were limited to tags; they reach no space until re-scoped', n; END IF;
    END IF;
  END LOOP;
END $$;

-- The old model goes.
UPDATE content_nodes SET tag_schema = tag_schema - 'policy' WHERE tag_schema ? 'policy';
DROP TRIGGER IF EXISTS node_tags_membership_bump ON node_tags;
DROP FUNCTION IF EXISTS bump_membership_on_node_tag();
ALTER TABLE actors DROP COLUMN IF EXISTS scoped_tag_ids;
ALTER TABLE agent_tokens DROP COLUMN IF EXISTS allowed_tag_ids;

-- Membership is managed through spaces now: a role change no longer rewrites
-- anyone's space membership. A new member joins the default space (role
-- mapped: viewer → viewer, admin → manager, else editor) and gets a personal
-- space; only the workspace owner's personal space is in the owner's backup.
CREATE OR REPLACE FUNCTION actors_sync_spaces() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  personal uuid;
BEGIN
  INSERT INTO space_members (space_id, actor_id, role)
  SELECT s.id, NEW.id,
         CASE NEW.role WHEN 'viewer' THEN 'viewer' WHEN 'admin' THEN 'manager' ELSE 'editor' END
    FROM spaces s WHERE s.workspace_id = NEW.workspace_id AND s.is_default
  ON CONFLICT (space_id, actor_id) DO NOTHING;
  IF NEW.type = 'human' AND NOT EXISTS (
       SELECT 1 FROM spaces WHERE owner_actor_id = NEW.id AND kind = 'personal' AND deleted_at IS NULL) THEN
    INSERT INTO spaces (workspace_id, name, kind, owner_actor_id, capabilities)
    VALUES (NEW.workspace_id, 'personal', 'personal', NEW.id,
            jsonb_build_object('publish', false, 'external_ai', false, 'shared_seen', false,
              'backup', COALESCE((SELECT owner_actor_id IS NULL OR owner_actor_id = NEW.id FROM workspaces WHERE id = NEW.workspace_id), true)))
    RETURNING id INTO personal;
    INSERT INTO space_members (space_id, actor_id, role) VALUES (personal, NEW.id, 'manager');
  END IF;
  IF NEW.type = 'human' AND NEW.role = 'admin' THEN
    UPDATE workspaces SET owner_actor_id = NEW.id WHERE id = NEW.workspace_id AND owner_actor_id IS NULL;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS actors_sync_spaces ON actors;
CREATE TRIGGER actors_sync_spaces AFTER INSERT ON actors
  FOR EACH ROW EXECUTE FUNCTION actors_sync_spaces();

-- Only the workspace owner's personal space is in the owner's backup.
UPDATE spaces s SET capabilities = s.capabilities || '{"backup": false}'::jsonb
  FROM workspaces w
 WHERE s.workspace_id = w.id AND s.kind = 'personal'
   AND s.owner_actor_id IS DISTINCT FROM w.owner_actor_id;

-- A root note created without a parent or an explicit space lands in the
-- creator's personal space (mutate() sets onden.actor_space for the
-- transaction), otherwise the workspace's default space.
CREATE OR REPLACE FUNCTION content_nodes_derive_space() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_space uuid;
  parent_type text;
  actor_space text;
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
      actor_space := NULLIF(current_setting('onden.actor_space', true), '');
      IF actor_space IS NOT NULL THEN NEW.space_id := actor_space::uuid; END IF;
    END IF;
    IF NEW.space_id IS NULL THEN
      SELECT id INTO NEW.space_id FROM spaces WHERE workspace_id = NEW.workspace_id AND is_default;
    END IF;
  END IF;
  RETURN NEW;
END $$;
