-- Module library (docs/architecture/module-library.md): the modules a
-- workspace has imported, as a JSON array of module ids.
--
-- NULL means the workspace predates the library: every module counts as
-- imported. At boot, backfillModuleImports (modules/index.ts) replaces NULL
-- with the modules the workspace actually uses (each module's library.inUse),
-- so existing workspaces keep what they use and new ones start with nothing
-- imported. The backfill runs at boot rather than here because it asks the
-- modules, which live in application code.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS modules jsonb;
