-- The whiteboard joins the module library (docs/architecture/module-library.md,
-- 「白板」). It was part of Onden before the library, so a workspace that
-- already records its imported modules keeps it: add "canvas" to every
-- recorded list. NULL lists (every module imported) are left to the boot
-- backfill, which imports the whiteboard by default. Repeatable.
UPDATE workspaces
   SET modules = modules || '["canvas"]'::jsonb
 WHERE modules IS NOT NULL
   AND jsonb_typeof(modules) = 'array'
   AND NOT modules ? 'canvas';
