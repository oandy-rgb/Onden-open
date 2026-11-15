-- 177: a restore job may be a whole-workspace move (mode 'workspace').
--
-- The backup restore job (migration 123) knew two modes, 'empty' and 'merge'. Moving a
-- workspace from one place to another (services/backupWorkspaceMove.ts) is a third. Only
-- the allowed values of an existing column widen: no row changes, nothing is dropped.
ALTER TABLE backup_restore_jobs DROP CONSTRAINT IF EXISTS backup_restore_jobs_mode_check;
ALTER TABLE backup_restore_jobs ADD CONSTRAINT backup_restore_jobs_mode_check CHECK (mode IN ('empty', 'merge', 'workspace'));
