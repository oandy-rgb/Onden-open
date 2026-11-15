-- Which note owns an uploaded file (docs/architecture/spaces.md, phase 0;
-- docs/research/integration-audit-2026-10-13.md, pre-invite item 6).
--
-- canReadMedia let the OLDEST note referencing `/api/media/<file>` decide who
-- may read it. Someone who had once seen the URL could paste it into an older
-- note of their own and read the file forever. The file now belongs to the
-- first note saved with a reference to it (services/mediaOwners.ts); a
-- reference added later from another note does not change that.
ALTER TABLE media_uploads ADD COLUMN IF NOT EXISTS node_id uuid REFERENCES content_nodes(id) ON DELETE SET NULL;

-- Files uploaded before: the note that decided until now, the oldest one
-- referencing it from its body or site layout.
UPDATE media_uploads m SET node_id = (
  SELECT n.id FROM content_nodes n
   WHERE n.workspace_id = m.workspace_id
     AND (strpos(lower(coalesce(n.markdown, '')), lower('/api/media/' || m.filename)) > 0
          OR strpos(lower(coalesce(n.presentation::text, '')), lower('/api/media/' || m.filename)) > 0)
   ORDER BY n.created_at, n.id
   LIMIT 1)
 WHERE m.node_id IS NULL;
