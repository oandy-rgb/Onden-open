-- 126: only an owner and members; space permission view / edit; token access
-- read / write (docs/architecture/proposals/roles-owner-member-2026-10-22.md
-- §7.3, decisions in §9). One conversion, no compatibility period: the old
-- columns are removed here.
--
-- Principle (§8.1): nobody and no token reaches more after this than before.
--   * actors.role (viewer/editor/reviewer/admin) never gated reading or writing
--     (spaces do); it only decided who owns the workspace as a fallback and who
--     reviews. Both now belong to workspaces.owner_actor_id alone.
--   * space_members.role viewer -> view; editor, manager -> edit. Managing a
--     space is no longer member data: the workspace owner manages shared
--     spaces, a person manages their own personal space.
--   * agent_tokens: the per-token space lists and the issuer clamp are gone, so
--     an agent's reach is its own space membership. To keep every token's reach
--     the same or narrower, each agent's membership is cut down to what ALL its
--     live tokens could reach before (the intersection, decision 5).
-- Everything that changes is written to owner_member_migration_log.

CREATE TABLE owner_member_migration_log (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  step text NOT NULL,            -- see the INSERTs below
  subject_type text NOT NULL,    -- 'actor' | 'token' | 'space_member' | 'workspace'
  subject_id uuid,
  space_id uuid,
  before jsonb NOT NULL,
  after jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── 1. A workspace with no owner gets the earliest human admin ─────────────
-- (the old fallback made every admin the owner of such a workspace; with the
-- fallback gone it must be a stored fact). A workspace with no human stays
-- ownerless: the first person to sign in becomes the owner (trigger below).
WITH filled AS (
  UPDATE workspaces w SET owner_actor_id = (
    SELECT a.id FROM actors a
     WHERE a.workspace_id = w.id AND a.type = 'human' AND a.role = 'admin' AND a.external_id IS NOT NULL
     ORDER BY a.created_at, a.id LIMIT 1)
   WHERE w.owner_actor_id IS NULL
     AND EXISTS (SELECT 1 FROM actors a WHERE a.workspace_id = w.id AND a.type = 'human' AND a.role = 'admin' AND a.external_id IS NOT NULL)
  RETURNING w.id, w.owner_actor_id
)
INSERT INTO owner_member_migration_log (workspace_id, step, subject_type, subject_id, before, after, note)
SELECT id, 'owner_filled', 'workspace', owner_actor_id, jsonb_build_object('owner_actor_id', NULL), jsonb_build_object('owner_actor_id', owner_actor_id),
       'no owner: the earliest signed-in human admin is now the owner'
  FROM filled;

-- ── 2. Who loses review (only the owner reviews, decision 1) ───────────────
INSERT INTO owner_member_migration_log (workspace_id, step, subject_type, subject_id, before, after, note)
SELECT a.workspace_id, 'review_lost', 'actor', a.id, jsonb_build_object('role', a.role), jsonb_build_object('reviews', false),
       'could review the inbox as ' || a.role || '; now only the owner reviews'
  FROM actors a JOIN workspaces w ON w.id = a.workspace_id
 WHERE a.type = 'human' AND a.role IN ('reviewer', 'admin') AND w.owner_actor_id IS DISTINCT FROM a.id
   AND a.external_id IS DISTINCT FROM 'system';

-- ── 3. Token access (read / write) ─────────────────────────────────────────
ALTER TABLE agent_tokens ADD COLUMN access text;
UPDATE agent_tokens SET access = CASE
  WHEN allowed_tools IS NULL OR allowed_tools && ARRAY['applyTag', 'removeTag', 'updateNode', 'createNode', 'proposeTagPack', 'publishSite']::text[]
  THEN 'write' ELSE 'read' END;
-- allowed_tools is kept as stored (NULL = every tool, as before): a token is
-- never narrowed or widened by this step, and a registry that later grows does
-- not change an existing token (services/agentTools/templates.ts).
INSERT INTO owner_member_migration_log (workspace_id, step, subject_type, subject_id, before, after, note)
SELECT a.workspace_id, 'token_all_tools', 'token', t.id, jsonb_build_object('allowed_tools', NULL), jsonb_build_object('access', 'write'),
       'a token with no tool list (every tool) is now "write" and keeps every tool until the owner resets it'
  FROM agent_tokens t JOIN actors a ON a.id = t.actor_id WHERE t.allowed_tools IS NULL;
ALTER TABLE agent_tokens ALTER COLUMN access SET NOT NULL;
ALTER TABLE agent_tokens ADD CONSTRAINT agent_tokens_access_check CHECK (access IN ('read', 'write'));

-- ── 4. Tokens whose issuer was removed stay dead ───────────────────────────
-- They reach nothing today (the issuer clamp); without the clamp they would
-- come back to life.
WITH revoked AS (
  UPDATE agent_tokens SET revoked_at = now() WHERE issuer_removed_at IS NOT NULL AND revoked_at IS NULL RETURNING id, actor_id
)
INSERT INTO owner_member_migration_log (workspace_id, step, subject_type, subject_id, before, after, note)
SELECT a.workspace_id, 'token_revoked_issuer_removed', 'token', r.id, jsonb_build_object('revoked', false), jsonb_build_object('revoked', true),
       'its issuer was removed, so it reached nothing; revoked so it cannot come back'
  FROM revoked r JOIN actors a ON a.id = r.actor_id;

-- ── 5. What each live token could reach before, per space ──────────────────
-- (the legacy rule: the agent is a member, the space lets external AI in, the
-- token's list and its issuer's own spaces allow it; writing also needs the
-- editor/manager role and an editor/manager issuer.)
CREATE TEMP TABLE omm_reach AS
SELECT t.id AS token_id, t.actor_id, t.access, m.space_id, m.role,
       (s.capabilities->>'external_ai' = 'true'
        AND (t.read_space_ids IS NULL OR m.space_id = ANY(t.read_space_ids))
        AND (t.issued_by IS NULL OR EXISTS (
              SELECT 1 FROM space_members im JOIN spaces isp ON isp.id = im.space_id AND isp.deleted_at IS NULL
               WHERE im.actor_id = t.issued_by AND im.space_id = m.space_id))) AS can_read,
       (m.role IN ('editor', 'manager') AND s.capabilities->>'external_ai' = 'true'
        AND (t.write_space_ids IS NULL OR m.space_id = ANY(t.write_space_ids))
        AND (t.issued_by IS NULL OR EXISTS (
              SELECT 1 FROM space_members im JOIN spaces isp ON isp.id = im.space_id AND isp.deleted_at IS NULL
               WHERE im.actor_id = t.issued_by AND im.space_id = m.space_id AND im.role IN ('editor', 'manager')))) AS can_write
  FROM agent_tokens t
  JOIN actors a ON a.id = t.actor_id AND a.external_id IS DISTINCT FROM 'system'
  JOIN space_members m ON m.actor_id = t.actor_id
  JOIN spaces s ON s.id = m.space_id AND s.deleted_at IS NULL
 WHERE t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now());

-- Per (agent, space): read survives only if EVERY live token read it; edit only
-- if the member role is editor/manager and EVERY write token wrote it. An agent
-- with no live token keeps its membership (no credential, nothing to widen).
CREATE TEMP TABLE omm_plan AS
SELECT actor_id, space_id, role,
       bool_and(can_read) AS keep_read,
       (role IN ('editor', 'manager') AND COALESCE(bool_and(can_write) FILTER (WHERE access = 'write'), true)) AS keep_edit
  FROM omm_reach GROUP BY actor_id, space_id, role;

INSERT INTO owner_member_migration_log (workspace_id, step, subject_type, subject_id, space_id, before, after, note)
SELECT a.workspace_id, 'agent_removed_from_space', 'space_member', p.actor_id, p.space_id,
       jsonb_build_object('role', p.role), NULL,
       'a live token of this agent could not read the space, so the agent leaves it (the owner can add it back)'
  FROM omm_plan p JOIN actors a ON a.id = p.actor_id WHERE NOT p.keep_read;

INSERT INTO owner_member_migration_log (workspace_id, step, subject_type, subject_id, space_id, before, after, note)
SELECT a.workspace_id, 'agent_edit_to_view', 'space_member', p.actor_id, p.space_id,
       jsonb_build_object('role', p.role), jsonb_build_object('permission', 'view'),
       'not every write token of this agent could write here, so it can only view (the owner can raise it)'
  FROM omm_plan p JOIN actors a ON a.id = p.actor_id
 WHERE p.keep_read AND p.role IN ('editor', 'manager') AND NOT p.keep_edit;

DELETE FROM space_members m USING omm_plan p
 WHERE m.actor_id = p.actor_id AND m.space_id = p.space_id AND NOT p.keep_read;

-- ── 6. Space permission view / edit ────────────────────────────────────────
ALTER TABLE space_members ADD COLUMN permission text;
UPDATE space_members SET permission = CASE role WHEN 'viewer' THEN 'view' ELSE 'edit' END;
UPDATE space_members m SET permission = 'view'
  FROM omm_plan p WHERE p.actor_id = m.actor_id AND p.space_id = m.space_id AND p.keep_read AND NOT p.keep_edit;

-- Non-owner managers of a shared space lose the right to manage it (decision 3).
INSERT INTO owner_member_migration_log (workspace_id, step, subject_type, subject_id, space_id, before, after, note)
SELECT s.workspace_id, 'manager_to_edit', 'space_member', m.actor_id, m.space_id,
       jsonb_build_object('role', 'manager'), jsonb_build_object('permission', 'edit'),
       'managed a shared space (members, switches); now edits it, and only the owner manages'
  FROM space_members m JOIN spaces s ON s.id = m.space_id JOIN actors a ON a.id = m.actor_id
  JOIN workspaces w ON w.id = s.workspace_id
 WHERE m.role = 'manager' AND s.kind <> 'personal' AND w.owner_actor_id IS DISTINCT FROM m.actor_id
   AND a.external_id IS DISTINCT FROM 'system' AND m.permission = 'edit';

ALTER TABLE space_members ALTER COLUMN permission SET NOT NULL;
ALTER TABLE space_members ADD CONSTRAINT space_members_permission_check CHECK (permission IN ('view', 'edit'));
ALTER TABLE space_members DROP COLUMN role;  -- also drops space_members_role_check

DROP TABLE omm_plan;
DROP TABLE omm_reach;

-- ── 7. Token space lists are gone ──────────────────────────────────────────
ALTER TABLE agent_tokens DROP COLUMN read_space_ids, DROP COLUMN write_space_ids;

-- ── 8. actors.role is gone ─────────────────────────────────────────────────
-- A new member joins the default space with the permission a person without a
-- grant gets: none. The first human on an ownerless workspace becomes its
-- owner (and edits the default space); everyone has a personal space.
CREATE OR REPLACE FUNCTION actors_sync_spaces() RETURNS trigger AS $$
DECLARE
  personal uuid;
  became_owner boolean := false;
BEGIN
  IF NEW.type = 'human' THEN
    UPDATE workspaces SET owner_actor_id = NEW.id WHERE id = NEW.workspace_id AND owner_actor_id IS NULL;
    became_owner := FOUND;
  END IF;
  IF became_owner THEN
    INSERT INTO space_members (space_id, actor_id, permission)
    SELECT s.id, NEW.id, 'edit' FROM spaces s WHERE s.workspace_id = NEW.workspace_id AND s.is_default
    ON CONFLICT (space_id, actor_id) DO NOTHING;
  END IF;
  IF NEW.type = 'human' AND NOT EXISTS (
       SELECT 1 FROM spaces WHERE owner_actor_id = NEW.id AND kind = 'personal' AND deleted_at IS NULL) THEN
    INSERT INTO spaces (workspace_id, name, kind, owner_actor_id, capabilities)
    VALUES (NEW.workspace_id, 'personal', 'personal', NEW.id,
            jsonb_build_object('publish', false, 'external_ai', false, 'shared_seen', false,
              'backup', COALESCE((SELECT owner_actor_id = NEW.id FROM workspaces WHERE id = NEW.workspace_id), false)))
    RETURNING id INTO personal;
    INSERT INTO space_members (space_id, actor_id, permission) VALUES (personal, NEW.id, 'edit');
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

ALTER TABLE actors DROP CONSTRAINT actors_role_check;
ALTER TABLE actors DROP COLUMN role;

-- ── 9. Everyone's readable set is re-checked ───────────────────────────────
UPDATE workspaces SET membership_epoch = membership_epoch + 1;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT step, count(*) AS n FROM owner_member_migration_log GROUP BY step ORDER BY step LOOP
    RAISE NOTICE 'owner/member: % x% (see owner_member_migration_log)', r.step, r.n;
  END LOOP;
END $$;
