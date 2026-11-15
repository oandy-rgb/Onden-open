-- Imported Excalidraw drawings keep only what they were converted to (user,
-- 2026-10-18: 「Excalidraw標籤刪了 只在匯入時轉換」). Import no longer keeps the
-- original file or the plugin's own frontmatter (frontend lib/ink/excalidraw.ts
-- withoutPluginFrontmatter); this removes what earlier imports kept:
--   1. the original file each converted drawing kept (_import_excalidraw);
--   2. the plugin's frontmatter keys (excalidraw-plugin, excalidraw-export-*,
--      excalidraw-mask…): their lines in the note's frontmatter — else the
--      next save derives them again — and the attributes they became;
--   3. the plugin's #excalidraw tag (a top-level label tag, no schema): its
--      memberships go with it. Kept when something is filed under it.
-- A data repair outside the event log, like 105–107; the deploy's backup holds
-- the previous state. Repeatable.

DELETE FROM node_attributes WHERE key = '_import_excalidraw';

-- Only inside the leading frontmatter block (---…---), never in the body.
-- A key line goes with its indented continuation lines.
WITH fm AS (
  SELECT n.id, substring(n.markdown from '^---.*?\n---[ \t]*\n') AS block
    FROM content_nodes n
   WHERE n.id IN (SELECT node_id FROM node_attributes WHERE key LIKE 'excalidraw-%')
)
UPDATE content_nodes n
   SET markdown = regexp_replace(fm.block, '\nexcalidraw-[A-Za-z0-9_-]*[ \t]*:[^\n]*((\n[ \t]+[^\n]*)*)', '', 'g')
                  || substr(n.markdown, length(fm.block) + 1)
  FROM fm
 WHERE n.id = fm.id AND fm.block IS NOT NULL;

DELETE FROM node_attributes WHERE key LIKE 'excalidraw-%';

DELETE FROM content_nodes t
 WHERE t.node_type = 'class_tag' AND lower(t.title) = 'excalidraw'
   AND t.parent_id IS NULL AND t.tag_schema IS NULL
   AND NOT EXISTS (SELECT 1 FROM content_nodes c WHERE c.parent_id = t.id);
