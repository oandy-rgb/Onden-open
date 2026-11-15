-- Synthetic workspace for the restore drill's self-test (scripts/restore-drill-selftest.sh).
-- Loaded into a schema-only database; every title, body and media name is made up.
-- Covers what the drill counts: notes, trash, tags (incl. the reserved #task tag),
-- canvas, edges, node_tags, attributes, spaces, actors, events, media references.
BEGIN;

-- schema.sql already carries the 'default' workspace row, as a production database does.

INSERT INTO actors (workspace_id, name, type, external_id)
SELECT id, 'Owner', 'human', 'drill-owner' FROM workspaces WHERE slug = 'default';
INSERT INTO actors (workspace_id, name, type, external_id)
SELECT id, 'Helper', 'agent', 'drill-helper' FROM workspaces WHERE slug = 'default';
SELECT set_config('onden.owner_transfer', (SELECT id::text FROM actors WHERE external_id = 'drill-owner'), true);
UPDATE workspaces SET owner_actor_id = (SELECT id FROM actors WHERE external_id = 'drill-owner') WHERE slug = 'default';

INSERT INTO spaces (workspace_id, name, kind, is_default, capabilities)
SELECT id, '共用', 'shared', true, '{}'::jsonb FROM workspaces w WHERE slug = 'default'
   AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.workspace_id = w.id AND s.is_default);

-- tags: #task (reserved), #school, and a child tag
INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, reserved_key, tag_color)
SELECT id, 'system', 'class_tag', 'task', 'tag-task', '', 'task', '#3366ff' FROM workspaces WHERE slug = 'default';
INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
SELECT id, 'manual', 'class_tag', 'school', 'tag-school', '' FROM workspaces WHERE slug = 'default';
INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id)
SELECT w.id, 'manual', 'class_tag', 'os-course', 'tag-os-course', '', t.id
  FROM workspaces w JOIN content_nodes t ON t.slug = 'tag-school' AND t.workspace_id = w.id WHERE w.slug = 'default';

-- 60 notes: every 5th is a child of the previous note, every 7th carries #school,
-- every 10th is a #task; bodies are deterministic text, some with media references.
INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id)
SELECT w.id, 'manual', 'content', 'Note ' || g, 'note-' || g,
       'Body of note ' || g || E'\n\nÜñíçødé 內文 ' || md5(g::text)
       || CASE WHEN g % 6 = 0 THEN E'\n\n![pic](/api/media/' || lpad(to_hex(g), 32, '0') || '.png)' ELSE '' END,
       NULL
  FROM workspaces w, generate_series(1, 60) g WHERE w.slug = 'default';
UPDATE content_nodes c SET parent_id = p.id
  FROM content_nodes p
 WHERE c.node_type = 'content' AND p.node_type = 'content' AND c.workspace_id = p.workspace_id
   AND substring(c.slug from 6)::int % 5 = 0 AND p.slug = 'note-' || (substring(c.slug from 6)::int - 1);

INSERT INTO node_tags (node_id, tag_id)
SELECT n.id, t.id FROM content_nodes n JOIN content_nodes t ON t.slug = 'tag-school'
 WHERE n.node_type = 'content' AND substring(n.slug from 6)::int % 7 = 0;
INSERT INTO node_tags (node_id, tag_id)
SELECT n.id, t.id FROM content_nodes n JOIN content_nodes t ON t.slug = 'tag-task'
 WHERE n.node_type = 'content' AND substring(n.slug from 6)::int % 10 = 0;

INSERT INTO node_attributes (workspace_id, node_id, key, value)
SELECT workspace_id, id, 'due', '2026-11-' || lpad((substring(slug from 6)::int % 28 + 1)::text, 2, '0')
  FROM content_nodes WHERE node_type = 'content' AND substring(slug from 6)::int % 10 = 0;
INSERT INTO node_attributes (workspace_id, node_id, key, value)
SELECT workspace_id, id, 'cover', '/api/media/' || lpad(to_hex(1000), 32, '0') || '.jpg'
  FROM content_nodes WHERE slug = 'note-1';

INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status)
SELECT a.workspace_id, a.id, b.id, 'knowledge_link', 'active'
  FROM content_nodes a JOIN content_nodes b ON b.workspace_id = a.workspace_id
   AND substring(b.slug from 6)::int = substring(a.slug from 6)::int + 1
 WHERE a.node_type = 'content' AND b.node_type = 'content' AND substring(a.slug from 6)::int % 3 = 0;

-- a canvas and a few trashed rows (one note, one tag)
INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
SELECT id, 'manual', 'canvas', 'Board', 'canvas-1', '' FROM workspaces WHERE slug = 'default';
-- two cards on the canvas (placements keyed by the board's own id, as a whiteboard note keeps them)
INSERT INTO node_positions (node_id, surface, x, y, workspace_id)
SELECT n.id, c.id::text, 10, 20, n.workspace_id
  FROM content_nodes c JOIN content_nodes n ON n.workspace_id = c.workspace_id AND n.slug IN ('note-1', 'note-2')
 WHERE c.slug = 'canvas-1';
UPDATE content_nodes SET deleted_at = now() WHERE slug IN ('note-59', 'note-60', 'tag-os-course');

INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id)
SELECT lpad(to_hex(1000), 32, '0') || '.jpg', w.id, a.id::text
  FROM workspaces w JOIN actors a ON a.external_id = 'drill-owner' WHERE w.slug = 'default';

INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id)
SELECT w.id, 'user', a.id::text, 'NODE_CREATED', 'node', n.id::text
  FROM workspaces w JOIN actors a ON a.external_id = 'drill-owner'
  JOIN content_nodes n ON n.workspace_id = w.id AND n.node_type = 'content' WHERE w.slug = 'default';

COMMIT;
