-- 134: remove the old site's data (publish redesign P5, docs/architecture/proposals/publish-redesign-2026-10-24.md).
--
-- What this DROPS, in plain words (nothing here touches a note's title or text,
-- a tag, a link, or the v2 site design; the notes of the old collections stay
-- ordinary notes):
--   1. the hosted share link's token and the learner access mode and tokens:
--      the attributes share_token, access_tokens and access_mode of the
--      site-settings note;
--   2. the old design settings on that same note: template, default_layout,
--      default_sidebar_ratio (the look now comes from the v2 design alone);
--   3. the old site design stored on the site-settings note, whenever it is not
--      v2 (the 24-block studio pages, per-page block lists): its `presentation`
--      is emptied, so the site uses the default design until the owner makes one;
--   4. the page layouts: the layout and sidebar_ratio attributes of notes
--      carrying the reserved #page tag (the tag itself stays);
--   5. the collection status of every note: its _status attribute (draft or
--      published). Collection items were ordinary notes carrying a tag; only
--      this status goes;
--   6. in every stored publish snapshot: the published collections and the old
--      design keys of its presentation (template, tokens, custom_css, site_bg,
--      blocks, pageBlocks, pageLayouts, site_pages). The page text, edges and
--      v2 design in the snapshot are kept;
--   7. the snapshot_media rows that named a collection item (kind 'item').
--
-- Attributes are deleted in 1, 2, 4 and 5, so the restore drill's attribute
-- count changes by design:
-- drill: allows attributes

-- The site-settings note: the note slugged _workspace_config that carries the
-- reserved workspace-config tag (services/siteConfig.ts getConfigNodeId).
CREATE TEMP TABLE site_config_nodes AS
SELECT n.id
  FROM content_nodes n
 WHERE n.slug = '_workspace_config'
   AND EXISTS (SELECT 1 FROM node_tags nt
                 JOIN content_nodes t ON t.id = nt.tag_id AND t.reserved_key = 'workspace-config'
                WHERE nt.node_id = n.id);

DELETE FROM node_attributes
 WHERE node_id IN (SELECT id FROM site_config_nodes)
   AND key IN ('share_token', 'access_tokens', 'access_mode', 'template', 'default_layout', 'default_sidebar_ratio');

UPDATE content_nodes
   SET presentation = NULL
 WHERE id IN (SELECT id FROM site_config_nodes)
   AND presentation IS NOT NULL
   AND (presentation->>'v') IS DISTINCT FROM '2';

DELETE FROM node_attributes a
 USING node_tags nt, content_nodes t
 WHERE a.key IN ('layout', 'sidebar_ratio')
   AND nt.node_id = a.node_id
   AND t.id = nt.tag_id
   AND t.reserved_key = 'page';

DELETE FROM node_attributes WHERE key = '_status';

UPDATE publish_snapshots
   SET payload = (payload - 'collections')
       || CASE WHEN jsonb_typeof(payload->'presentation') = 'object'
               THEN jsonb_build_object('presentation',
                      (payload->'presentation') - ARRAY['template', 'tokens', 'custom_css', 'site_bg',
                                                        'blocks', 'pageBlocks', 'pageLayouts', 'site_pages']::text[])
               ELSE '{}'::jsonb END
 WHERE payload ? 'collections'
    OR (jsonb_typeof(payload->'presentation') = 'object'
        AND (payload->'presentation') ?| ARRAY['template', 'tokens', 'custom_css', 'site_bg',
                                               'blocks', 'pageBlocks', 'pageLayouts', 'site_pages']::text[]);

DELETE FROM snapshot_media WHERE kind = 'item';
ALTER TABLE snapshot_media DROP CONSTRAINT IF EXISTS snapshot_media_kind_check;
ALTER TABLE snapshot_media ADD CONSTRAINT snapshot_media_kind_check CHECK (kind IN ('node', 'presentation'));

DROP TABLE site_config_nodes;
