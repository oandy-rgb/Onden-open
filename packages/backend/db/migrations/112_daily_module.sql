-- Daily notes (日記) join the module library (src/modules/daily). Day notes
-- were always on before, so a workspace that already records its imported
-- modules keeps them: add "daily" to every recorded list. A new workspace
-- starts without it (the boot backfill imports it only where day notes
-- exist). NULL lists (every module imported) are left to that backfill.
-- Repeatable.
UPDATE workspaces
   SET modules = modules || '["daily"]'::jsonb
 WHERE modules IS NOT NULL
   AND jsonb_typeof(modules) = 'array'
   AND NOT modules ? 'daily';
