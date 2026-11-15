-- 147: standalone tasks move into notes (docs/architecture/day-timeline.md).
--
-- A task used to be able to belong to no note (parent_id NULL: quick-add made
-- those). From now on a task is a checkbox line of a note — usually the day
-- note of the day it is for — so the day's diary and the day's task list are
-- the same text. This moves the tasks already standalone:
--
--   * a task with a day in `_task_when` goes into that day's note, in the
--     task's own space; one with no (valid) day goes into a note called 任務
--     in the task's space;
--   * the day note is the live note of that space titled (or slugged) with the
--     day. When there is none it is made, with the id the app derives for
--     (space, day) — uuid v5 of "<space>/<day>" in the day-note namespace
--     (frontend lib/data/dayNotes.ts dayNoteId) — so a device that starts the
--     same day later finds it. The 任務 note has the id derived from
--     "<space>/任務" in the same namespace;
--   * the task node keeps its id and every attribute; only parent_id changes.
--     The line `- [ ] title {task} ^t-<12 hex of the id>` is appended to the
--     note, with its block node linked to the task (block_nodes.task_id) and
--     the task tag on the block, exactly as a saved line would have them, so
--     the note's next save finds the link and makes no second task;
--   * a space is never crossed: a task of a shared space goes into a note of
--     that space (a day note there that the app's Today button, which looks
--     in the personal space, does not open — it is a note like any other).
--
-- Left as they are, still standalone and still listed in Tasks: trashed tasks,
-- and a task whose title would not read back from a line (it holds `{`, `}`,
-- `#`, `^`, a line break, or starts with a clock time such as 15:00): writing
-- it as a line would rename it or tag it on the note's next save. Nothing is
-- deleted and no task loses a field. Each moved note and task gets an event
-- (system 'migration:147') so open devices see the change on their next sync;
-- the event has no inverse (the move is not offered as an undo).
--
-- Idempotent: it selects the live standalone tasks, and a second run finds
-- only the ones left on purpose, which it skips again.
-- drill: allows notes_live, note-bodies

CREATE OR REPLACE FUNCTION pg_temp.m147_uuid5(ns uuid, name text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(
    set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid
  FROM (SELECT substring(public.digest(decode(replace(ns::text, '-', ''), 'hex') || convert_to(name, 'UTF8'), 'sha1') from 1 for 16) AS h) x
$$;

DO $m147$
DECLARE
  ns constant uuid := '6f0b7a52-3c1e-4d5a-9a3e-2b8f4c7d1e60';
  r record;
  day text;
  note_name text;
  note_id uuid;
  note_title text;
  note_md text;
  line text;
  ref text;
  sep text;
  note_slug text;
  block_id uuid;
  moved int := 0;
  kept int := 0;
BEGIN
  FOR r IN
    SELECT t.id, t.workspace_id, t.space_id, t.title, tg.id AS tag_id,
           (SELECT a.value FROM node_attributes a WHERE a.node_id = t.id AND a.key = '_task_when') AS w,
           (SELECT a.value FROM node_attributes a WHERE a.node_id = t.id AND a.key = '_task_status') AS status,
           (SELECT a.value FROM node_attributes a WHERE a.node_id = t.id AND a.key = '_task_time') AS tm,
           (SELECT a.value FROM node_attributes a WHERE a.node_id = t.id AND a.key = '_task_until') AS un
      FROM content_nodes t
      JOIN node_tags nt ON nt.node_id = t.id
      JOIN content_nodes tg ON tg.id = nt.tag_id AND tg.node_type = 'class_tag' AND tg.deleted_at IS NULL
                           AND tg.tag_schema->>'module' = 'tasks'
     WHERE t.parent_id IS NULL AND t.hidden AND t.node_type = 'content' AND t.deleted_at IS NULL
       AND t.space_id IS NOT NULL
       -- The tests set this to run the move on one workspace; unset, it is all of them.
       AND (COALESCE(current_setting('onden.m147_workspace', true), '') = ''
            OR t.workspace_id::text = current_setting('onden.m147_workspace', true))
       AND EXISTS (SELECT 1 FROM node_attributes a WHERE a.node_id = t.id AND a.key = '_task_status')
     ORDER BY t.workspace_id, t.created_at, t.id
  LOOP
    -- A title the line would not carry unchanged stays where it is.
    IF btrim(r.title) = '' OR r.title ~ '[{}#^\r\n]' OR r.title ~ '^\s*[0-9]{1,2}:[0-9]{2}' THEN
      kept := kept + 1;
      CONTINUE;
    END IF;

    -- The day the task is for: a real YYYY-MM-DD, else none.
    day := NULL;
    BEGIN
      IF r.w ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND to_char(to_date(r.w, 'YYYY-MM-DD'), 'YYYY-MM-DD') = r.w THEN
        day := r.w;
      END IF;
    EXCEPTION WHEN others THEN
      day := NULL;
    END;
    note_name := COALESCE(day, '任務');
    note_title := note_name;

    -- The note: the day's live note in this space, else the one the app would derive.
    note_id := NULL;
    IF day IS NOT NULL THEN
      SELECT n.id INTO note_id FROM content_nodes n
       WHERE n.workspace_id = r.workspace_id AND n.space_id = r.space_id AND n.deleted_at IS NULL
         AND n.node_type = 'content' AND NOT n.hidden AND (n.title = day OR n.slug = day)
       ORDER BY n.created_at, n.id LIMIT 1;
    ELSE
      SELECT n.id INTO note_id FROM content_nodes n
       WHERE n.id = pg_temp.m147_uuid5(ns, r.space_id::text || '/' || note_name)
         AND n.workspace_id = r.workspace_id AND n.space_id = r.space_id AND n.deleted_at IS NULL
         AND n.node_type = 'content' AND NOT n.hidden;
    END IF;

    IF note_id IS NULL THEN
      note_id := pg_temp.m147_uuid5(ns, r.space_id::text || '/' || note_name);
      -- That id is a note already (trashed, or another space's): a new one.
      IF EXISTS (SELECT 1 FROM content_nodes WHERE id = note_id) THEN note_id := gen_random_uuid(); END IF;
      note_slug := CASE WHEN day IS NOT NULL THEN day ELSE 'tasks-' || substr(replace(note_id::text, '-', ''), 1, 8) END;
      IF EXISTS (SELECT 1 FROM content_nodes n WHERE n.workspace_id = r.workspace_id AND n.space_id = r.space_id
                  AND n.slug = note_slug AND n.deleted_at IS NULL) THEN
        note_slug := note_slug || '-' || substr(replace(note_id::text, '-', ''), 1, 8);
      END IF;
      INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
      VALUES (r.workspace_id, 'system', 'migration:147', 'NODE_CREATED', 'node', note_id::text,
              jsonb_build_object('title', note_title),
              jsonb_build_object('ui_context', 'migration.tasks_into_notes'));
      INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, hidden, space_id)
      VALUES (note_id, r.workspace_id, 'manual', 'content', note_title, note_slug, '', false, r.space_id);
    END IF;

    -- The line, appended after a blank line the way placing a task does.
    ref := 't-' || substr(replace(r.id::text, '-', ''), 1, 12);
    line := '- [' || CASE WHEN r.status = 'done' THEN 'x' ELSE ' ' END || '] '
         || CASE WHEN r.tm ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                 THEN r.tm || CASE WHEN r.un ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND r.un > r.tm THEN '–' || r.un ELSE '' END || ' '
                 ELSE '' END
         || regexp_replace(btrim(r.title), '\s+', ' ', 'g') || ' {task} ^' || ref;
    SELECT markdown INTO note_md FROM content_nodes WHERE id = note_id FOR UPDATE;
    sep := CASE WHEN note_md = '' OR note_md LIKE E'%\n\n' THEN ''
                WHEN note_md LIKE E'%\n' THEN E'\n' ELSE E'\n\n' END;
    UPDATE content_nodes SET markdown = note_md || sep || line || E'\n', updated_at = now() WHERE id = note_id;

    -- The task goes under the note (its space stays: the note is in it).
    UPDATE content_nodes SET parent_id = note_id, updated_at = now() WHERE id = r.id;

    -- The line's block node, linked to the task, carrying the task tag.
    INSERT INTO block_nodes (workspace_id, note_id, block_ref, parent_block_id, kind, label, text_cache, task_id)
    VALUES (r.workspace_id, note_id, ref, NULL, 'listItem', left(regexp_replace(btrim(r.title), '\s+', ' ', 'g'), 60), line, r.id)
    RETURNING id INTO block_id;
    INSERT INTO block_node_tags (block_node_id, tag_id, workspace_id) VALUES (block_id, r.tag_id, r.workspace_id);

    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    VALUES (r.workspace_id, 'system', 'migration:147', 'NODE_UPDATED', 'node', note_id::text,
            jsonb_build_object('block_node_id', block_id, 'task_id', r.id),
            jsonb_build_object('ui_context', 'migration.tasks_into_notes'));
    INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
    VALUES (r.workspace_id, 'system', 'migration:147', 'NODE_UPDATED', 'node', r.id::text,
            jsonb_build_object('parent_id', note_id, 'task', true),
            jsonb_build_object('ui_context', 'migration.tasks_into_notes'));
    moved := moved + 1;
  END LOOP;
  RAISE NOTICE 'migration 147: % standalone task(s) moved into notes, % left standalone (title or trashed)', moved, kept;
END $m147$;
