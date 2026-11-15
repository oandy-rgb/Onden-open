-- Calendar, board and cards join the module library as view modules
-- (docs/architecture/views-as-modules.md). Every collection had these layouts
-- before, so a workspace that already records its imported modules keeps
-- them: add the three ids to every recorded list. NULL lists (every module
-- imported) are left to the boot backfill, which imports them by default.
-- Repeatable.
UPDATE workspaces
   SET modules = modules || (
         SELECT COALESCE(jsonb_agg(id), '[]'::jsonb)
           FROM unnest(ARRAY['calendar', 'kanban', 'gallery']) AS id
          WHERE NOT modules ? id
       )
 WHERE modules IS NOT NULL
   AND jsonb_typeof(modules) = 'array';
