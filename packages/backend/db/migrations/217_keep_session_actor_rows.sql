-- 217: a temporary session's actors row is never deleted and never stops being a session's, while its workspace exists. Adds only: one function
-- and two triggers on actors. No existing row is read for a purpose other than the preview below, changed or deleted.
--
-- WHY IN THE DATABASE
--   Two rules read this row and nothing else to know an id was a session's (PR #1856): spine/snapshotTables.json `neverLeaves` of space_members
--   ("the member is an actor of type 'session'": the membership rows and their tombstones never leave this node) and services/authorName.ts (a
--   history reader says "a temporary session" only when this node's own actors row of type 'session' says so). Were the row deleted, or its type
--   changed, the session's membership tombstones would become ones that may leave, and its writes would read as a removed person's. Until now the
--   rule was kept by the one application DELETE (services/actors.ts removeActor refuses a session; its DELETE excludes type 'session') and a text
--   scan of the source (guards/neverLeaves.guard.test.ts). Text matching cannot cover every spelling (`public.actors`, `ONLY actors`, a query
--   builder, a variable table name, `type <> 'session' OR …`), an UPDATE of the type, scripts or migrations: the database can.
--
-- WHAT THIS ADDS
--   actors_keep_session_row()   BEFORE DELETE OR UPDATE OF id, workspace_id, type, per row:
--     * DELETE of a row whose type is 'session' is refused, unless its workspace is being deleted (below);
--     * UPDATE of a session's row that changes its id, its workspace or its type is refused; so is an UPDATE that makes a row a session's
--       (a session's row is made a session's at INSERT, services/participantSessions.ts, and stays one).
--   actors_keep_session_rows_truncate   BEFORE TRUNCATE (statement): refused while any row of type 'session' exists (row triggers do not see a TRUNCATE).
--   Refusals are raised with SQLSTATE 23001 (restrict_violation), like a RESTRICT foreign key.
--   Both are ENABLE ALWAYS: they run under session_replication_role = replica too (which skips ordinary triggers and foreign keys).
--   The function names its tables with their schema and runs with search_path = public, pg_temp: a temporary table called `workspaces` or
--   `actors` on the same connection cannot stand in for the real one.
--
-- WHEN A SESSION'S ROW MAY GO: the whole workspace is being deleted
--   Judged by the workspace's own row: the delete goes ahead when no workspaces row with the actor's workspace_id is visible. A delete of a workspace
--   reaches its actors through actors_workspace_id_fkey ON DELETE CASCADE, and Postgres runs that cascade after the workspaces row is deleted, in the
--   same transaction, so the trigger's query no longer sees it. The trigger reads no setting (no GUC). What can still take a session's row with its
--   workspace standing: a statement that turns the trigger off (ALTER TABLE actors DISABLE TRIGGER …, which needs the table's owner and is DDL,
--   not a query an application path makes), or dropping the table. The two places that delete a workspace (spine/stampedImport.ts: an unfinished
--   join and an empty shell replaced by a snapshot) delete its stamps, stamp heads and clock right after, so no tombstone of that workspace is
--   left to leave either. Not the same as that exemption: TRUNCATE workspaces CASCADE (which reaches actors) is refused while a session's row
--   exists, because a statement trigger cannot tell a whole-table truncate from anything else; nothing in the product, the tests or the scripts
--   truncates workspaces or actors.
--   A backup restore is unaffected: pg_dump --clean (scripts/backup.sh) drops and re-creates the tables and loads rows with COPY, which fires no
--   DELETE, UPDATE or TRUNCATE trigger (checked on a throwaway database holding a session's row; PR #1856).
--
-- WHAT THIS DOES NOT DO, on purpose
--   * no existing actors, participant_sessions or stamp row is read, changed or deleted. Rows a cleanup would remove (a session's actors and
--     participant_sessions rows that nobody clears) are a decision for a later batch (proposal sessions-reads-own-2026-11-17.md, section 7).
--   * the opener's removal is not changed: participant_sessions.opened_by cascades from the opener's row, the session's actors row has no foreign
--     key to the opener and stays (sessionActorKept.integration.test.ts).
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward). In place:
--   DROP TRIGGER actors_keep_session_row ON actors; DROP TRIGGER actors_keep_session_rows_truncate ON actors; DROP FUNCTION actors_keep_session_row();
-- (the older code never deletes a session's row: removeActor refuses it).
-- drill: no allowance needed. This migration writes no row of any table the drill compares.
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on; counts only):
--
--   SELECT 'actors rows of type session the triggers will keep' AS part, count(*)::bigint AS rows FROM actors WHERE type = 'session'
--   UNION ALL SELECT 'rows changed or deleted by this migration', 0
--   ;

CREATE OR REPLACE FUNCTION actors_keep_session_row() RETURNS trigger
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM public.actors WHERE type = 'session') THEN
      RAISE EXCEPTION 'a temporary session''s actors row is kept: actors cannot be truncated while one exists'
        USING ERRCODE = 'restrict_violation', HINT = 'a session is ended (services/participantSessions.ts), never removed';
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.type = 'session' AND EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = OLD.workspace_id) THEN
      RAISE EXCEPTION 'a temporary session''s actors row is kept: it is ended, never deleted'
        USING ERRCODE = 'restrict_violation', HINT = 'only deleting its whole workspace takes it';
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE
  IF (OLD.type = 'session' OR NEW.type = 'session')
     AND (NEW.type IS DISTINCT FROM OLD.type OR NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
    RAISE EXCEPTION 'a temporary session''s actors row keeps its id, workspace and type'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS actors_keep_session_row ON actors;
CREATE TRIGGER actors_keep_session_row BEFORE DELETE OR UPDATE OF id, workspace_id, type ON actors
  FOR EACH ROW EXECUTE FUNCTION actors_keep_session_row();

DROP TRIGGER IF EXISTS actors_keep_session_rows_truncate ON actors;
CREATE TRIGGER actors_keep_session_rows_truncate BEFORE TRUNCATE ON actors
  FOR EACH STATEMENT EXECUTE FUNCTION actors_keep_session_row();

ALTER TABLE actors ENABLE ALWAYS TRIGGER actors_keep_session_row;
ALTER TABLE actors ENABLE ALWAYS TRIGGER actors_keep_session_rows_truncate;
