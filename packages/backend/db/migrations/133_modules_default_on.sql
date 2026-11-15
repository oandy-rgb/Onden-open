-- 133: built-in functions are on by default (docs/architecture/module-library.md).
--
-- Before: workspaces.modules listed the modules the owner had imported; a module
-- not in the list was off, whether the owner had decided so or never chose.
-- Now: every shipped module is on unless the owner turned it off, so the table
-- keeps only what the owner decided:
--   modules_off        modules the owner turned off (a list)
--   modules_confirmed  modules that need the owner's one-time agreement
--                      (semantic search, RSS, website) and got it. NULL = not
--                      decided yet; backfillModuleImports (modules/index.ts) fills
--                      it at boot from what the workspace already uses.
--
-- Nothing is deleted. A module the owner never chose about becomes on. The old
-- list cannot tell "never chose" from "turned off", but the event log can:
-- every import and removal wrote MODULE_IMPORTED / MODULE_REMOVED, so a module is
-- off when its latest such event is a removal. workspaces.modules stays as it was
-- and is no longer read for this. Idempotent: the columns and the updates only
-- fill what is still empty.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS modules_off jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS modules_confirmed jsonb;

-- Off: the owner's latest decision on the module was to remove it.
UPDATE workspaces w SET modules_off = COALESCE((
  SELECT jsonb_agg(last.module ORDER BY last.module)
    FROM (
      SELECT DISTINCT ON (e.payload->>'module') e.payload->>'module' AS module, e.event_type
        FROM domain_events e
       WHERE e.workspace_id = w.id
         AND e.event_type IN ('MODULE_IMPORTED', 'MODULE_REMOVED')
         AND e.payload ? 'module'
       ORDER BY e.payload->>'module', e.id DESC
    ) last
   WHERE last.event_type = 'MODULE_REMOVED'
), '[]'::jsonb)
 WHERE w.modules_off = '[]'::jsonb;

-- Confirmed: the owner had already imported a module that now needs agreement
-- (listed now, or ever imported), so they are not asked again. A workspace from
-- before the library (modules IS NULL) stays NULL for the boot backfill.
UPDATE workspaces w SET modules_confirmed = COALESCE((
  SELECT jsonb_agg(c.module ORDER BY c.module)
    FROM (
      SELECT m AS module FROM jsonb_array_elements_text(w.modules) AS m WHERE m IN ('semantic', 'rss', 'website')
      UNION
      SELECT e.payload->>'module' FROM domain_events e
       WHERE e.workspace_id = w.id AND e.event_type = 'MODULE_IMPORTED'
         AND e.payload->>'module' IN ('semantic', 'rss', 'website')
    ) c
), '[]'::jsonb)
 WHERE w.modules_confirmed IS NULL AND w.modules IS NOT NULL AND jsonb_typeof(w.modules) = 'array';

ALTER TABLE workspaces ALTER COLUMN modules_confirmed SET DEFAULT '[]'::jsonb;

COMMENT ON COLUMN workspaces.modules_off IS 'Built-in modules the owner turned off (ids). Everything else shipped is on.';
COMMENT ON COLUMN workspaces.modules_confirmed IS 'Confirm-once modules (semantic, rss, website) the owner agreed to use; NULL until the boot backfill decides.';
