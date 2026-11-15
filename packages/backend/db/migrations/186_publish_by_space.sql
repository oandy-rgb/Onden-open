-- 186: a space's 「發布到網站」 switch now publishes the space (owner 2026-11-10). Before, it only ALLOWED its
-- notes on the site and each note was opted in (`_published` = 'true'); now every note in a space that publishes is
-- on the site unless kept off (its own `_published` = 'false', blank, or an article saved from a feed:
-- modules/website/publishing/publishedSet.ts).
--
-- Changes data: a space whose switch is on but that never put a note on the site (no live note in it is marked
-- `_published` = 'true') has the switch turned off, so the new meaning does not publish notes nobody chose. A space
-- that did publish keeps it on, and from the next publish all its notes go out — the preview lists them first. The
-- default space a new workspace gets starts with the switch off. No note changes. The owner agreed (2026-11-10).
-- Rolling back: the older backend reads the switch as "allowed", so the spaces turned off here publish nothing they
-- did not before; turn a switch back on in Settings if wanted.
UPDATE spaces s
   SET capabilities = s.capabilities || '{"publish": false}'::jsonb
 WHERE s.capabilities->>'publish' = 'true'
   AND NOT EXISTS (
     SELECT 1 FROM content_nodes n JOIN node_attributes a ON a.node_id = n.id
      WHERE n.space_id = s.id AND n.deleted_at IS NULL AND a.key = '_published' AND a.value = 'true');

CREATE OR REPLACE FUNCTION workspaces_default_space() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO spaces (workspace_id, name, kind, is_default, capabilities)
  VALUES (NEW.id, '共用', 'shared', true, '{"publish": false, "external_ai": true, "backup": true, "shared_seen": false}'::jsonb)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
