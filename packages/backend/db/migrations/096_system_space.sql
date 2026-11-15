-- The workspace settings in a place no note surface serves
-- (docs/architecture/spaces.md 「workspace 設定節點保護」; audit D2 in
-- docs/research/integration-audit-2026-10-13.md).
--
-- The hidden Site Config note holds the site settings and two secrets: the
-- hosted-share token and the site's access tokens. In 共用 it reached every
-- member, and their agents, through bootstrap and the note routes. It now
-- sits in a `system` space with no members, so no member, owner or token reads
-- it as a note. The server reads and writes it through the settings functions
-- (services/siteConfig.ts), and the owner changes it through PATCH
-- /api/workspace/config.
INSERT INTO spaces (workspace_id, name, kind, capabilities)
SELECT w.id, 'system', 'system', '{"publish": false, "external_ai": false, "backup": false, "shared_seen": false}'::jsonb
  FROM workspaces w
 WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.workspace_id = w.id AND s.kind = 'system' AND s.deleted_at IS NULL);

-- Only the Site Config note itself: the system-made note carrying the ROOT
-- workspace-config tag. Tag titles are unique per parent, so a member's
-- nested `#foo/workspace-config` must not pull ordinary notes in here.
UPDATE content_nodes n SET space_id = s.id
  FROM spaces s
 WHERE s.workspace_id = n.workspace_id AND s.kind = 'system' AND s.deleted_at IS NULL
   AND n.node_type = 'content' AND n.source_type = 'system'
   AND EXISTS (SELECT 1 FROM node_tags nt JOIN content_nodes t ON t.id = nt.tag_id
                WHERE nt.node_id = n.id AND t.node_type = 'class_tag' AND t.parent_id IS NULL
                  AND t.title = 'workspace-config');
