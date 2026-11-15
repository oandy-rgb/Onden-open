-- Reserved tags are found by a key, not by their title
-- (docs/research/integration-audit-2026-10-13.md, tag review). The code found
-- #task, #subscription, #workspace-config and #page by title: renaming one broke
-- every task, feed or the site settings, and #task matched at any depth, so a
-- member's #project/task turned notes into tasks. reserved_key names the role;
-- the title is free to change. services/reservedTags.ts owns the keys.
ALTER TABLE content_nodes ADD COLUMN IF NOT EXISTS reserved_key text;

CREATE UNIQUE INDEX IF NOT EXISTS content_nodes_reserved_key_uq ON content_nodes (workspace_id, reserved_key)
  WHERE reserved_key IS NOT NULL AND deleted_at IS NULL;
COMMENT ON COLUMN content_nodes.reserved_key IS 'Role of a system-reserved class_tag (task, subscription, workspace-config, page); NULL for ordinary nodes. See services/reservedTags.ts.';

-- One live tag per (workspace, key): the root tag of that title, else the
-- oldest. The config tag was already matched at the root only (migration 096).
UPDATE content_nodes t SET reserved_key = pick.title
  FROM (
    SELECT DISTINCT ON (workspace_id, title) id, title
      FROM content_nodes
     WHERE node_type = 'class_tag' AND deleted_at IS NULL
       AND title IN ('task', 'subscription', 'workspace-config', 'page')
       AND (title <> 'workspace-config' OR parent_id IS NULL)
     ORDER BY workspace_id, title, (parent_id IS NOT NULL), created_at, id
  ) pick
 WHERE t.id = pick.id;

-- The config check is lifecycle-agnostic (restoring a deleted config tag is as
-- sensitive as editing a live one), so deleted root config tags keep the key.
UPDATE content_nodes SET reserved_key = 'workspace-config'
 WHERE node_type = 'class_tag' AND deleted_at IS NOT NULL AND parent_id IS NULL
   AND title = 'workspace-config' AND reserved_key IS NULL;
