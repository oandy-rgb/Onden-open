-- 201: things Onden makes by itself get an id that can be computed (distributed-ready proposal §4.5, node-sync-channels
-- pre-launch list item 11), and function_refs records who last changed it (causal-stamps proposal §8, as S1-S4 did for the
-- other tables).
--
-- WHAT THIS REWRITES (existing data): the id of these rows, and every reference to that id. Their content does not change.
--   capture tag, skills tag, site settings tag (reserved key workspace-config), page tag (reserved key page)
--       the single live tag of that purpose in a workspace      -> uuid v5 of 'module-tag/<module>/<workspace>' or 'reserved-tag/<key>/<workspace>'
--   site settings note   the live system note with slug _workspace_config  -> 'site-config-note/<workspace>'
--   system space         the live space of kind system             -> 'system-space/<workspace>'
--   default space        the workspace's default space             -> 'default-space/<workspace>'
--   personal space       a person's live personal space            -> 'personal-space/<workspace>/<actor>'
--   tasks note           of a space whose id changes: its id is derived from the SPACE id (dayNoteIdName; migration 147; the sidebar and
--                        openTasksNote find it by that id), so it moves to v5(DAY_NOTE_NAMESPACE, '<new space>/任務'). Only a note whose id IS the
--                        old derivation (a renamed one too) and whose new id is free. Day notes are NOT moved: the app finds them by title
--                        (findDayNode, appendToDayNote), and the one that is made from now on is found the same way.
-- (namespace DERIVED_ID_NAMESPACE of @onden/markdown sharedContract.ts, the same v5 mechanism as a day note's id and as
-- migration 147's m147_uuid5.) A row is left exactly as it is, and listed in the preview, when two live rows of one purpose
-- exist in a workspace (the migration does not guess which is the one) or when the new id already belongs to another row.
-- A row whose id is already the derived one is not touched (running this twice changes nothing).
--
-- WHAT THIS DOES NOT REWRITE, on purpose (each is a record of what happened, or a name that carries no meaning):
--   domain_events (target_id, payload, tx_meta)  append-only by trigger; they keep the old ids. id_rewrites (made here) records old -> new, and
--                                                restoring an event follows it (services/idRewrites.ts), so undo of an earlier tag change,
--                                                space move or settings change still lands on the row. (The history LIST of a rewritten row
--                                                is read by its id and shows only what was written under the new one.)
--   structure_log                                append-only by trigger, never sent anywhere (190)
--   ds_* (the earlier distributed-sync op log and its failure records), outbox payloads, agent_session_events.body,
--   publish_snapshots.payload, owner_member_migration_log, board_copy_folds / board_copy_unparents undo records
--                                                records of what was true when they were written
--   (publish_snapshots.payload, with its `taken_down` list, is not rewritten either: the served site and the take-down record read it
--   through id_rewrites, so a published page stays shown and a taken-down one stays down; modules/website/publishing/takenDown.ts.)
--   slugs (module-<old id>, tag-<key>-<first six of the old id>) and note text   content, not a reference
--   rss_staging, tasks that were already made   not in this migration (see the Part B note below)
-- What it DOES update, one by one, is the list printed by the preview: every foreign key to content_nodes and spaces (found
-- in pg_constraint, not a fixed list), the uuid and uuid[] columns that name a note or space without a foreign key, the
-- attribute values equal to the id, the ids inside tag_schema / collection_views / presentation / function_refs.config /
-- actor_prefs / actor_module_settings / ai_suggestions.payload, node_event_meta, and sync_stamps.row_key.
--
-- Before upgrading, let the job queue (outbox) empty: a job still waiting that names an old id (an `embed` of a rewritten note, say) would
-- fail as a job for a deleted note does and be retried until it is given up; the next edit files it again. The preview counts them.
-- Anything that held the old id outside the database (an open tab's local copy, a queued offline write aimed at the old
-- tag or space) is stale after this: the migration raises workspaces.membership_epoch for every workspace it changed, so
-- every device re-reads what it may see, and a device with a write queued for an old id is told the target is gone.
-- No route or wire shape changes; only the values of these ids do.
--
-- HOW: the foreign keys to content_nodes and spaces are made DEFERRABLE for the length of this transaction (and put back),
-- the user triggers of the tables written are switched off (the rewrite is not a user's edit: no stamp, no event, no
-- membership bump from it), the ids are changed in place, then everything is checked at the end (SET CONSTRAINTS ALL
-- IMMEDIATE) before the constraints and triggers are put back. One transaction; any failure rolls all of it back.
--
-- Part A, creation (code, with this migration): the same ids are used when these rows are made from now on, so two devices
-- that each make one offline make the same row. The default space and a person's personal space are made by the database
-- (workspaces_default_space / actors_sync_spaces, redefined here with the derived id); when the derived id is already taken by
-- another row the database falls back to a random id, as day notes do.
--
-- Part B, repeatable jobs (code only): the next occurrence of a recurring task and an RSS article are made with a derived
-- id from now on. Existing tasks and articles are NOT rewritten: nothing needs it (an article is found by its feed and guid,
-- which are unique already; a task already made is found by the event that minted it), and a rewrite would touch the tasks of
-- every user for no gain.
--
-- Part C: function_refs gets the write stamps of 190 / 199 (the row, and its config per key). Records only; existing rows get
-- no stamp (S5 does that).
--
-- Rolling back to an older backend: restore the pre-upgrade backup (migrations only go forward; an older backend refuses a
-- database with a migration it does not know). The old ids are not kept anywhere in the database.
--
-- drill: allows notes_gone
--
-- Read-only preview for the production database (SELECT only: counts, row ids and reasons, never a title or text). Per purpose:
-- how many rows get a new id, how many are already derived, how many are left untouched and why; then how many references to
-- those rows each place holds today (the number of rows that will be updated). src/test/derivedIdsMigration.integration.test.ts
-- runs this exact text and checks it against what the migration does. `part` = rows | left untouched | references | left as is.
--
--   WITH
--   cand0 AS (
--     SELECT 'capture tag' AS purpose, 'node' AS kind, t.workspace_id::text AS grp, t.workspace_id, t.id AS old_id,
--            (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('module-tag/capture/' || t.workspace_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5) AS new_id
--       FROM content_nodes t WHERE t.node_type = 'class_tag' AND t.deleted_at IS NULL AND t.tag_schema->>'module' = 'capture'
--     UNION ALL
--     SELECT 'skills tag', 'node', t.workspace_id::text, t.workspace_id, t.id,
--            (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('module-tag/skills/' || t.workspace_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
--       FROM content_nodes t WHERE t.node_type = 'class_tag' AND t.deleted_at IS NULL AND t.tag_schema->>'module' = 'skills'
--     UNION ALL
--     SELECT 'site settings tag', 'node', t.workspace_id::text, t.workspace_id, t.id,
--            (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('reserved-tag/workspace-config/' || t.workspace_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
--       FROM content_nodes t WHERE t.node_type = 'class_tag' AND t.deleted_at IS NULL AND t.reserved_key = 'workspace-config'
--     UNION ALL
--     SELECT 'page tag', 'node', t.workspace_id::text, t.workspace_id, t.id,
--            (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('reserved-tag/page/' || t.workspace_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
--       FROM content_nodes t WHERE t.node_type = 'class_tag' AND t.deleted_at IS NULL AND t.reserved_key = 'page'
--     UNION ALL
--     SELECT 'site settings note', 'node', n.workspace_id::text, n.workspace_id, n.id,
--            (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('site-config-note/' || n.workspace_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
--       FROM content_nodes n WHERE n.node_type = 'content' AND n.deleted_at IS NULL AND n.slug = '_workspace_config' AND n.source_type = 'system'
--     UNION ALL
--     SELECT 'system space', 'space', s.workspace_id::text, s.workspace_id, s.id,
--            (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('system-space/' || s.workspace_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
--       FROM spaces s WHERE s.kind = 'system' AND s.deleted_at IS NULL
--     UNION ALL
--     SELECT 'default space', 'space', s.workspace_id::text, s.workspace_id, s.id,
--            (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('default-space/' || s.workspace_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
--       FROM spaces s WHERE s.is_default
--     UNION ALL
--     SELECT 'personal space', 'space', s.workspace_id::text || '/' || s.owner_actor_id::text, s.workspace_id, s.id,
--            (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('personal-space/' || s.workspace_id || '/' || s.owner_actor_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
--       FROM spaces s WHERE s.kind = 'personal' AND s.deleted_at IS NULL AND s.owner_actor_id IS NOT NULL
--   ),
--   -- a space's tasks note has an id derived from the SPACE id derived from the SPACE id (@onden/markdown dayNoteIdName, migration 147): it follows the space. Day notes stay as they are (the app finds them by title)
--   judged0 AS (
--     SELECT c.*, CASE WHEN count(*) OVER (PARTITION BY c.purpose, c.grp) > 1 THEN 'several_candidates'
--                      WHEN c.old_id = c.new_id THEN 'already_derived'
--                      WHEN c.kind = 'space' AND EXISTS (SELECT 1 FROM spaces x WHERE x.id = c.new_id) THEN 'new_id_taken'
--                      WHEN c.kind = 'node' AND EXISTS (SELECT 1 FROM content_nodes x WHERE x.id = c.new_id) THEN 'new_id_taken'
--                      ELSE 'rewrite' END AS verdict
--       FROM cand0 c
--   ),
--   cand AS (
--     SELECT purpose, kind, grp, workspace_id, old_id, new_id FROM cand0
--     UNION ALL
--     SELECT 'tasks note', 'node', n.id::text, n.workspace_id, n.id,
--            (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('6f0b7a52-3c1e-4d5a-9a3e-2b8f4c7d1e60', '-', ''), 'hex') || convert_to(j.new_id::text || '/任務', 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
--       FROM judged0 j JOIN content_nodes n ON n.space_id = j.old_id
--      WHERE j.kind = 'space' AND j.verdict = 'rewrite' AND n.id = (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('6f0b7a52-3c1e-4d5a-9a3e-2b8f4c7d1e60', '-', ''), 'hex') || convert_to(j.old_id::text || '/任務', 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
--   ),
--   judged AS (
--     SELECT c.purpose, c.kind, c.grp, c.workspace_id, c.old_id, c.new_id,
--            CASE WHEN count(*) OVER (PARTITION BY c.purpose, c.grp) > 1 THEN 'several_candidates'
--                 WHEN c.old_id = c.new_id THEN 'already_derived'
--                 WHEN c.kind = 'node' AND EXISTS (SELECT 1 FROM content_nodes x WHERE x.id = c.new_id) THEN 'new_id_taken'
--                 WHEN c.kind = 'space' AND EXISTS (SELECT 1 FROM spaces x WHERE x.id = c.new_id) THEN 'new_id_taken'
--                 ELSE 'rewrite' END AS verdict
--       FROM cand c
--   )
--   SELECT 'rows' AS part, purpose AS what,
--          count(*) FILTER (WHERE verdict = 'rewrite') AS will_change, count(*) FILTER (WHERE verdict = 'already_derived') AS already_derived,
--          count(*) FILTER (WHERE verdict IN ('several_candidates', 'new_id_taken')) AS left_untouched,
--          NULL::text AS ids, NULL::text AS reason FROM judged GROUP BY purpose
--   UNION ALL
--   SELECT 'left untouched', purpose, NULL, NULL, NULL, old_id::text, verdict FROM judged WHERE verdict IN ('several_candidates', 'new_id_taken')
--   UNION ALL
--   SELECT 'references', 'actor_module_settings.tag_id', count(*), NULL, NULL, NULL, NULL FROM actor_module_settings WHERE tag_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'agent_sessions.node_id', count(*), NULL, NULL, NULL, NULL FROM agent_sessions WHERE node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'ai_edit_suggestions.node_id', count(*), NULL, NULL, NULL, NULL FROM ai_edit_suggestions WHERE node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'block_anchors.note_id', count(*), NULL, NULL, NULL, NULL FROM block_anchors WHERE note_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'block_link_bindings.note_id', count(*), NULL, NULL, NULL, NULL FROM block_link_bindings WHERE note_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'block_node_tags.tag_id', count(*), NULL, NULL, NULL, NULL FROM block_node_tags WHERE tag_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'block_nodes.detached_note_id', count(*), NULL, NULL, NULL, NULL FROM block_nodes WHERE detached_note_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'block_nodes.note_id', count(*), NULL, NULL, NULL, NULL FROM block_nodes WHERE note_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'block_nodes.task_id', count(*), NULL, NULL, NULL, NULL FROM block_nodes WHERE task_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'board_copy_folds.node_id', count(*), NULL, NULL, NULL, NULL FROM board_copy_folds WHERE node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'board_copy_unparents.node_id', count(*), NULL, NULL, NULL, NULL FROM board_copy_unparents WHERE node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'board_ink_moves.node_id', count(*), NULL, NULL, NULL, NULL FROM board_ink_moves WHERE node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'canvas_note_conversions.node_id', count(*), NULL, NULL, NULL, NULL FROM canvas_note_conversions WHERE node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'content_nodes.parent_id', count(*), NULL, NULL, NULL, NULL FROM content_nodes WHERE parent_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'content_nodes.space_id', count(*), NULL, NULL, NULL, NULL FROM content_nodes WHERE space_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'space')
--   UNION ALL
--   SELECT 'references', 'focus_sessions.task_id', count(*), NULL, NULL, NULL, NULL FROM focus_sessions WHERE task_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'function_refs.holder_node_id', count(*), NULL, NULL, NULL, NULL FROM function_refs WHERE holder_node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'function_refs.holder_space_id', count(*), NULL, NULL, NULL, NULL FROM function_refs WHERE holder_space_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'space')
--   UNION ALL
--   SELECT 'references', 'media_uploads.node_id', count(*), NULL, NULL, NULL, NULL FROM media_uploads WHERE node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'node_attributes.node_id', count(*), NULL, NULL, NULL, NULL FROM node_attributes WHERE node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'node_edges.source_node_id', count(*), NULL, NULL, NULL, NULL FROM node_edges WHERE source_node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'node_edges.target_node_id', count(*), NULL, NULL, NULL, NULL FROM node_edges WHERE target_node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'node_embeddings.node_id', count(*), NULL, NULL, NULL, NULL FROM node_embeddings WHERE node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'node_positions.node_id', count(*), NULL, NULL, NULL, NULL FROM node_positions WHERE node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'node_tag_states.node_id', count(*), NULL, NULL, NULL, NULL FROM node_tag_states WHERE node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'node_tag_states.tag_id', count(*), NULL, NULL, NULL, NULL FROM node_tag_states WHERE tag_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'node_tags.node_id', count(*), NULL, NULL, NULL, NULL FROM node_tags WHERE node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'node_tags.tag_id', count(*), NULL, NULL, NULL, NULL FROM node_tags WHERE tag_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'note_block_refs.note_id', count(*), NULL, NULL, NULL, NULL FROM note_block_refs WHERE note_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'note_pointers.parent_id', count(*), NULL, NULL, NULL, NULL FROM note_pointers WHERE parent_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'note_pointers.target_id', count(*), NULL, NULL, NULL, NULL FROM note_pointers WHERE target_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'publish_snapshots.home_node_id', count(*), NULL, NULL, NULL, NULL FROM publish_snapshots WHERE home_node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'push_reminder_sent.task_id', count(*), NULL, NULL, NULL, NULL FROM push_reminder_sent WHERE task_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'read_later_done_removed_192.node_id', count(*), NULL, NULL, NULL, NULL FROM read_later_done_removed_192 WHERE node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'review_states.node_id', count(*), NULL, NULL, NULL, NULL FROM review_states WHERE node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'rss_staging.saved_node_id', count(*), NULL, NULL, NULL, NULL FROM rss_staging WHERE saved_node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'rss_subscriptions.auto_tag_id', count(*), NULL, NULL, NULL, NULL FROM rss_subscriptions WHERE auto_tag_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'rss_subscriptions.default_parent_id', count(*), NULL, NULL, NULL, NULL FROM rss_subscriptions WHERE default_parent_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'rss_subscriptions.space_id', count(*), NULL, NULL, NULL, NULL FROM rss_subscriptions WHERE space_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'space')
--   UNION ALL
--   SELECT 'references', 'space_members.space_id', count(*), NULL, NULL, NULL, NULL FROM space_members WHERE space_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'space')
--   UNION ALL
--   SELECT 'references', 'workspaces.home_node_id', count(*), NULL, NULL, NULL, NULL FROM workspaces WHERE home_node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'note_link_index.note_id', count(*), NULL, NULL, NULL, NULL FROM note_link_index WHERE note_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'agent_sessions.space_id', count(*), NULL, NULL, NULL, NULL FROM agent_sessions WHERE space_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'space')
--   UNION ALL
--   SELECT 'references', 'agent_sessions.skill_node_id', count(*), NULL, NULL, NULL, NULL FROM agent_sessions WHERE skill_node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'ai_edit_suggestions.space_id', count(*), NULL, NULL, NULL, NULL FROM ai_edit_suggestions WHERE space_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'space')
--   UNION ALL
--   SELECT 'references', 'ai_suggestions.target_id', count(*), NULL, NULL, NULL, NULL FROM ai_suggestions WHERE target_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'backup_restore_jobs.space_id', count(*), NULL, NULL, NULL, NULL FROM backup_restore_jobs WHERE space_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'space')
--   UNION ALL
--   SELECT 'references', 'dispatcher_pending.node_id', count(*), NULL, NULL, NULL, NULL FROM dispatcher_pending WHERE node_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'node_positions.sub_canvas_id', count(*), NULL, NULL, NULL, NULL FROM node_positions WHERE sub_canvas_id IN (SELECT old_id FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'agent_sessions.scope_node_ids', count(*), NULL, NULL, NULL, NULL FROM agent_sessions WHERE scope_node_ids::text[] && ARRAY(SELECT old_id::text FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'agent_sessions.scope_tag_ids', count(*), NULL, NULL, NULL, NULL FROM agent_sessions WHERE scope_tag_ids::text[] && ARRAY(SELECT old_id::text FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'block_nodes.detached_tags', count(*), NULL, NULL, NULL, NULL FROM block_nodes WHERE detached_tags::text[] && ARRAY(SELECT old_id::text FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'rss_subscriptions.default_tag_ids', count(*), NULL, NULL, NULL, NULL FROM rss_subscriptions WHERE default_tag_ids::text[] && ARRAY(SELECT old_id::text FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'node_event_meta.node_id', count(*), NULL, NULL, NULL, NULL FROM node_event_meta WHERE node_id::text IN (SELECT old_id::text FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'node_attributes.value', count(*), NULL, NULL, NULL, NULL FROM node_attributes WHERE value::text IN (SELECT old_id::text FROM judged WHERE verdict = 'rewrite' AND kind = 'node')
--   UNION ALL
--   SELECT 'references', 'content_nodes.tag_schema (inside the JSON)', count(*), NULL, NULL, NULL, NULL FROM content_nodes x WHERE EXISTS (SELECT 1 FROM judged j WHERE j.verdict = 'rewrite' AND x.tag_schema::text LIKE '%' || j.old_id::text || '%')
--   UNION ALL
--   SELECT 'references', 'content_nodes.collection_views (inside the JSON)', count(*), NULL, NULL, NULL, NULL FROM content_nodes x WHERE EXISTS (SELECT 1 FROM judged j WHERE j.verdict = 'rewrite' AND x.collection_views::text LIKE '%' || j.old_id::text || '%')
--   UNION ALL
--   SELECT 'references', 'content_nodes.presentation (inside the JSON)', count(*), NULL, NULL, NULL, NULL FROM content_nodes x WHERE EXISTS (SELECT 1 FROM judged j WHERE j.verdict = 'rewrite' AND x.presentation::text LIKE '%' || j.old_id::text || '%')
--   UNION ALL
--   SELECT 'references', 'function_refs.config (inside the JSON)', count(*), NULL, NULL, NULL, NULL FROM function_refs x WHERE EXISTS (SELECT 1 FROM judged j WHERE j.verdict = 'rewrite' AND x.config::text LIKE '%' || j.old_id::text || '%')
--   UNION ALL
--   SELECT 'references', 'actor_prefs.value (inside the JSON)', count(*), NULL, NULL, NULL, NULL FROM actor_prefs x WHERE EXISTS (SELECT 1 FROM judged j WHERE j.verdict = 'rewrite' AND x.value::text LIKE '%' || j.old_id::text || '%')
--   UNION ALL
--   SELECT 'references', 'actor_module_settings.settings (inside the JSON)', count(*), NULL, NULL, NULL, NULL FROM actor_module_settings x WHERE EXISTS (SELECT 1 FROM judged j WHERE j.verdict = 'rewrite' AND x.settings::text LIKE '%' || j.old_id::text || '%')
--   UNION ALL
--   SELECT 'references', 'ai_suggestions.payload (inside the JSON)', count(*), NULL, NULL, NULL, NULL FROM ai_suggestions x WHERE EXISTS (SELECT 1 FROM judged j WHERE j.verdict = 'rewrite' AND x.payload::text LIKE '%' || j.old_id::text || '%')
--   UNION ALL
--   SELECT 'references', 'sync_stamps.row_key', count(*), NULL, NULL, NULL, NULL FROM sync_stamps x WHERE EXISTS (SELECT 1 FROM judged j WHERE j.verdict = 'rewrite' AND x.workspace_id = j.workspace_id AND x.row_key LIKE '%' || j.old_id::text || '%')
--   UNION ALL
--   SELECT 'left as is', 'content_nodes.markdown (note text that mentions the id; not changed)', count(*), NULL, NULL, NULL, NULL FROM content_nodes x WHERE EXISTS (SELECT 1 FROM judged j WHERE j.verdict = 'rewrite' AND j.kind = 'node' AND x.markdown LIKE '%' || j.old_id::text || '%')
--   UNION ALL
--   SELECT 'left as is', 'outbox.payload (jobs still waiting that mention the id: let the queue empty before upgrading)', count(*), NULL, NULL, NULL, NULL FROM outbox x WHERE x.status = 'pending' AND EXISTS (SELECT 1 FROM judged j WHERE j.verdict = 'rewrite' AND x.payload::text LIKE '%' || j.old_id::text || '%')
--   UNION ALL
--   SELECT 'references', 'workspaces (devices re-read their readable set)', count(DISTINCT workspace_id), NULL, NULL, NULL, NULL FROM judged WHERE verdict = 'rewrite'
--   ORDER BY 1 DESC, 2;
--

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. The id derivation, in SQL (the TypeScript side is utils.ts uuidV5; src/test checks the two agree).

CREATE OR REPLACE FUNCTION onden_uuid5(p_ns uuid, p_name text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(
    set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid
  FROM (SELECT substring(public.digest(decode(replace(p_ns::text, '-', ''), 'hex') || convert_to(p_name, 'UTF8'), 'sha1') from 1 for 16) AS h) x
$$;

-- The id for a space made by the database: the derived one, or a random one when another space already has it (a deleted
-- personal space of the same person, say), so making a space never fails on the derivation.
CREATE OR REPLACE FUNCTION onden_space_id(p_name text) RETURNS uuid
LANGUAGE sql VOLATILE AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM spaces WHERE id = onden_uuid5('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', p_name))
              THEN gen_random_uuid()
              ELSE onden_uuid5('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', p_name) END
$$;

CREATE OR REPLACE FUNCTION workspaces_default_space() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO spaces (id, workspace_id, name, kind, is_default, capabilities)
  VALUES (onden_space_id('default-space/' || NEW.id), NEW.id, '共用', 'shared', true,
          '{"publish": false, "external_ai": true, "backup": true, "shared_seen": false}'::jsonb)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;

-- 127's function with one change: the personal space is made with its derived id, and a second maker (another transaction,
-- another device after a merge) ends with the same row instead of a second one.
CREATE OR REPLACE FUNCTION actors_sync_spaces() RETURNS trigger AS $$
DECLARE
  personal uuid;
  became_owner boolean := false;
BEGIN
  IF NEW.type = 'human' THEN
    UPDATE workspaces SET owner_actor_id = NEW.id WHERE id = NEW.workspace_id AND owner_actor_id IS NULL;
    became_owner := FOUND;
  END IF;
  IF became_owner THEN
    INSERT INTO space_members (space_id, actor_id, permission)
    SELECT s.id, NEW.id, 'edit' FROM spaces s WHERE s.workspace_id = NEW.workspace_id AND s.is_default
    ON CONFLICT (space_id, actor_id) DO NOTHING;
  END IF;
  IF NEW.type = 'human' AND NOT EXISTS (
       SELECT 1 FROM spaces WHERE owner_actor_id = NEW.id AND kind = 'personal' AND deleted_at IS NULL) THEN
    personal := onden_space_id('personal-space/' || NEW.workspace_id || '/' || NEW.id);
    INSERT INTO spaces (id, workspace_id, name, kind, owner_actor_id, capabilities)
    VALUES (personal, NEW.workspace_id, 'personal', 'personal', NEW.id,
            jsonb_build_object('publish', false, 'external_ai', false, 'shared_seen', false,
              'backup', COALESCE((SELECT owner_actor_id = NEW.id FROM workspaces WHERE id = NEW.workspace_id), false)))
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO space_members (space_id, actor_id, permission) VALUES (personal, NEW.id, 'edit')
    ON CONFLICT (space_id, actor_id) DO NOTHING;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. function_refs write stamps (S1 pattern: generic trigger; 199 pattern: config per key). Created BEFORE the rewrite below,
-- whose user-trigger switch-off then covers them too (the rewrite is not an edit).

CREATE OR REPLACE TRIGGER function_refs_sync_stamp_insert AFTER INSERT ON function_refs FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('function_refs', 'id', 'workspace_id', 'function=function_id,instance=instance,holder=holder_node_id,space=holder_space_id', '');
CREATE OR REPLACE TRIGGER function_refs_sync_stamp_update AFTER UPDATE ON function_refs FOR EACH ROW
  WHEN (OLD.function_id IS DISTINCT FROM NEW.function_id OR OLD.instance IS DISTINCT FROM NEW.instance
     OR OLD.holder_node_id IS DISTINCT FROM NEW.holder_node_id OR OLD.holder_space_id IS DISTINCT FROM NEW.holder_space_id)
  EXECUTE FUNCTION sync_stamp_trigger('function_refs', 'id', 'workspace_id', 'function=function_id,instance=instance,holder=holder_node_id,space=holder_space_id', '');
CREATE OR REPLACE TRIGGER function_refs_sync_stamp_delete AFTER DELETE ON function_refs FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('function_refs', 'id', 'workspace_id', 'function=function_id,instance=instance,holder=holder_node_id,space=holder_space_id', '');

CREATE OR REPLACE TRIGGER function_refs_config_stamp_insert AFTER INSERT ON function_refs FOR EACH ROW
  WHEN (NEW.config <> '{}'::jsonb)
  EXECUTE FUNCTION sync_stamp_json_trigger('function_refs.config', 'id', 'workspace_id', 'config', 'object', 'key:', '', '');
CREATE OR REPLACE TRIGGER function_refs_config_stamp_update AFTER UPDATE OF config ON function_refs FOR EACH ROW
  WHEN (OLD.config IS DISTINCT FROM NEW.config)
  EXECUTE FUNCTION sync_stamp_json_trigger('function_refs.config', 'id', 'workspace_id', 'config', 'object', 'key:', '', '');
CREATE OR REPLACE TRIGGER function_refs_config_stamp_delete AFTER DELETE ON function_refs FOR EACH ROW
  WHEN (OLD.config <> '{}'::jsonb)
  EXECUTE FUNCTION sync_stamp_json_trigger('function_refs.config', 'id', 'workspace_id', 'config', 'object', 'key:', '', '');

-- The old -> new id of every row this migration changed, kept so that history written before it still means something: events
-- are append-only and keep the old id, and restoring one (services/idRewrites.ts, read by eventRestore) follows it to the new one.
CREATE TABLE IF NOT EXISTS id_rewrites (
  old_id uuid PRIMARY KEY,
  new_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  rewritten_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS id_rewrites_workspace_idx ON id_rewrites (workspace_id);

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. The id rewrite.

DROP TABLE IF EXISTS pg_temp.m201_map;
CREATE TEMP TABLE m201_map ON COMMIT DROP AS
WITH
cand0 AS (
  SELECT 'capture tag' AS purpose, 'node' AS kind, t.workspace_id::text AS grp, t.workspace_id, t.id AS old_id,
         (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('module-tag/capture/' || t.workspace_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5) AS new_id
    FROM content_nodes t WHERE t.node_type = 'class_tag' AND t.deleted_at IS NULL AND t.tag_schema->>'module' = 'capture'
  UNION ALL
  SELECT 'skills tag', 'node', t.workspace_id::text, t.workspace_id, t.id,
         (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('module-tag/skills/' || t.workspace_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
    FROM content_nodes t WHERE t.node_type = 'class_tag' AND t.deleted_at IS NULL AND t.tag_schema->>'module' = 'skills'
  UNION ALL
  SELECT 'site settings tag', 'node', t.workspace_id::text, t.workspace_id, t.id,
         (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('reserved-tag/workspace-config/' || t.workspace_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
    FROM content_nodes t WHERE t.node_type = 'class_tag' AND t.deleted_at IS NULL AND t.reserved_key = 'workspace-config'
  UNION ALL
  SELECT 'page tag', 'node', t.workspace_id::text, t.workspace_id, t.id,
         (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('reserved-tag/page/' || t.workspace_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
    FROM content_nodes t WHERE t.node_type = 'class_tag' AND t.deleted_at IS NULL AND t.reserved_key = 'page'
  UNION ALL
  SELECT 'site settings note', 'node', n.workspace_id::text, n.workspace_id, n.id,
         (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('site-config-note/' || n.workspace_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
    FROM content_nodes n WHERE n.node_type = 'content' AND n.deleted_at IS NULL AND n.slug = '_workspace_config' AND n.source_type = 'system'
  UNION ALL
  SELECT 'system space', 'space', s.workspace_id::text, s.workspace_id, s.id,
         (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('system-space/' || s.workspace_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
    FROM spaces s WHERE s.kind = 'system' AND s.deleted_at IS NULL
  UNION ALL
  SELECT 'default space', 'space', s.workspace_id::text, s.workspace_id, s.id,
         (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('default-space/' || s.workspace_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
    FROM spaces s WHERE s.is_default
  UNION ALL
  SELECT 'personal space', 'space', s.workspace_id::text || '/' || s.owner_actor_id::text, s.workspace_id, s.id,
         (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47', '-', ''), 'hex') || convert_to('personal-space/' || s.workspace_id || '/' || s.owner_actor_id, 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
    FROM spaces s WHERE s.kind = 'personal' AND s.deleted_at IS NULL AND s.owner_actor_id IS NOT NULL
),
-- a space's tasks note has an id derived from the SPACE id derived from the SPACE id (@onden/markdown dayNoteIdName, migration 147): it follows the space. Day notes stay as they are (the app finds them by title)
judged0 AS (
  SELECT c.*, CASE WHEN count(*) OVER (PARTITION BY c.purpose, c.grp) > 1 THEN 'several_candidates'
                   WHEN c.old_id = c.new_id THEN 'already_derived'
                   WHEN c.kind = 'space' AND EXISTS (SELECT 1 FROM spaces x WHERE x.id = c.new_id) THEN 'new_id_taken'
                   WHEN c.kind = 'node' AND EXISTS (SELECT 1 FROM content_nodes x WHERE x.id = c.new_id) THEN 'new_id_taken'
                   ELSE 'rewrite' END AS verdict
    FROM cand0 c
),
cand AS (
  SELECT purpose, kind, grp, workspace_id, old_id, new_id FROM cand0
  UNION ALL
  SELECT 'tasks note', 'node', n.id::text, n.workspace_id, n.id,
         (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('6f0b7a52-3c1e-4d5a-9a3e-2b8f4c7d1e60', '-', ''), 'hex') || convert_to(j.new_id::text || '/任務', 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
    FROM judged0 j JOIN content_nodes n ON n.space_id = j.old_id
   WHERE j.kind = 'space' AND j.verdict = 'rewrite' AND n.id = (SELECT encode(set_byte(set_byte(h, 6, (get_byte(h, 6) & 15) | 80), 8, (get_byte(h, 8) & 63) | 128), 'hex')::uuid FROM (SELECT substring(public.digest(decode(replace('6f0b7a52-3c1e-4d5a-9a3e-2b8f4c7d1e60', '-', ''), 'hex') || convert_to(j.old_id::text || '/任務', 'UTF8'), 'sha1') FROM 1 FOR 16) AS h) AS u5)
),
judged AS (
  SELECT c.purpose, c.kind, c.grp, c.workspace_id, c.old_id, c.new_id,
         CASE WHEN count(*) OVER (PARTITION BY c.purpose, c.grp) > 1 THEN 'several_candidates'
              WHEN c.old_id = c.new_id THEN 'already_derived'
              WHEN c.kind = 'node' AND EXISTS (SELECT 1 FROM content_nodes x WHERE x.id = c.new_id) THEN 'new_id_taken'
              WHEN c.kind = 'space' AND EXISTS (SELECT 1 FROM spaces x WHERE x.id = c.new_id) THEN 'new_id_taken'
              ELSE 'rewrite' END AS verdict
    FROM cand c
)
SELECT * FROM judged;

CREATE OR REPLACE FUNCTION pg_temp.elem_type(p_tbl text, p_col text) RETURNS text LANGUAGE sql AS $$
  SELECT regexp_replace(format_type(a.atttypid, NULL), '\[\]$', '')
    FROM pg_attribute a WHERE a.attrelid = p_tbl::regclass AND a.attname = p_col
$$;

DO $m201$
DECLARE
  r record;
  fk record;
  o record;
  trg record;
  rewritten int;
  off_triggers text[] := '{}';
  made_deferrable text[] := '{}';
  item text;
  pos int;
  old_expr text;
  new_expr text;
BEGIN
  SELECT count(*) INTO rewritten FROM m201_map WHERE verdict = 'rewrite';
  FOR r IN SELECT purpose, verdict, count(*) AS c FROM m201_map WHERE verdict NOT IN ('rewrite', 'already_derived') GROUP BY 1, 2 LOOP
    RAISE NOTICE '201: % left untouched (%): % row(s), listed by the preview', r.purpose, r.verdict, r.c;
  END LOOP;
  IF rewritten = 0 THEN RETURN; END IF;
  RAISE NOTICE '201: % row(s) get a derived id', rewritten;

  -- The foreign keys that name a note or a space (the ON UPDATE CASCADE one, note_link_index, follows by itself).
  DROP TABLE IF EXISTS pg_temp.m201_fk;
  CREATE TEMP TABLE m201_fk ON COMMIT DROP AS
  SELECT c.conname, c.conrelid::regclass AS tbl, a.attname AS col, (c.confrelid = 'spaces'::regclass) AS to_space,
         c.condeferrable, c.conkey
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f' AND c.confrelid IN ('content_nodes'::regclass, 'spaces'::regclass) AND c.confupdtype <> 'c';
  IF EXISTS (SELECT 1 FROM m201_fk WHERE array_length(conkey, 1) > 1) THEN
    RAISE EXCEPTION '201: a composite foreign key to content_nodes or spaces exists; this migration does not know how to move it';
  END IF;

  -- The columns that hold the id because they point at one of the columns above (a key that includes it, at any depth):
  -- note_version_positions and note_version_events -> note_versions (note_id, unit, version_key). Migration 220 made them, after
  -- this one, so an upgrade finds none here; a rerun on today's schema (src/test/helpers/rerunMigration.ts) does, and without them
  -- the version rows of a rewritten tag or note moved and their positions failed the foreign key (issue #2006).
  DROP TABLE IF EXISTS pg_temp.m201_fk_via;
  CREATE TEMP TABLE m201_fk_via ON COMMIT DROP AS
  WITH RECURSIVE via(conname, tbl, attnum, to_space, condeferrable) AS (
    SELECT c.conname, c.conrelid::regclass, c.conkey[k.i], f.to_space, c.condeferrable
      FROM m201_fk f JOIN pg_constraint c ON c.contype = 'f' AND c.confrelid = f.tbl AND c.confupdtype <> 'c'
      CROSS JOIN LATERAL generate_subscripts(c.confkey, 1) AS k(i)
     WHERE c.confkey[k.i] = f.conkey[1]
    UNION
    SELECT c.conname, c.conrelid::regclass, c.conkey[k.i], v.to_space, c.condeferrable
      FROM via v JOIN pg_constraint c ON c.contype = 'f' AND c.confrelid = v.tbl AND c.confupdtype <> 'c'
      CROSS JOIN LATERAL generate_subscripts(c.confkey, 1) AS k(i)
     WHERE c.confkey[k.i] = v.attnum
  )
  SELECT v.conname, v.tbl, a.attname AS col, v.to_space, v.condeferrable
    FROM via v JOIN pg_attribute a ON a.attrelid = v.tbl AND a.attnum = v.attnum;

  -- The references that are not foreign keys: tbl, column, how it holds the id, what it names (node | space | any).
  DROP TABLE IF EXISTS pg_temp.m201_other;
  CREATE TEMP TABLE m201_other ON COMMIT DROP AS
  SELECT * FROM (VALUES
    ('agent_sessions', 'space_id', 'uuid', 'space', false),
    ('agent_sessions', 'skill_node_id', 'uuid', 'node', false),
    ('ai_edit_suggestions', 'space_id', 'uuid', 'space', false),
    ('ai_suggestions', 'target_id', 'uuid', 'node', false),
    ('backup_restore_jobs', 'space_id', 'uuid', 'space', false),
    ('dispatcher_pending', 'node_id', 'uuid', 'node', false),
    ('node_positions', 'sub_canvas_id', 'uuid', 'node', false),
    ('agent_sessions', 'scope_node_ids', 'array', 'node', false),
    ('agent_sessions', 'scope_tag_ids', 'array', 'node', false),
    ('block_nodes', 'detached_tags', 'array', 'node', false),
    ('rss_subscriptions', 'default_tag_ids', 'array', 'node', false),
    ('node_event_meta', 'node_id', 'text', 'node', false),
    ('node_attributes', 'value', 'text', 'node', false),
    ('content_nodes', 'tag_schema', 'json', 'any', true),
    ('content_nodes', 'collection_views', 'json', 'any', true),
    ('content_nodes', 'presentation', 'json', 'any', true),
    ('function_refs', 'config', 'json', 'any', true),
    ('actor_prefs', 'value', 'json', 'any', false),
    ('actor_module_settings', 'settings', 'json', 'any', false),
    ('ai_suggestions', 'payload', 'json', 'any', true)
  ) AS t(tbl, col, how, kind, by_workspace);

  FOR fk IN SELECT DISTINCT tbl, conname FROM (SELECT tbl, conname, condeferrable FROM m201_fk UNION ALL SELECT tbl, conname, condeferrable FROM m201_fk_via) x
             WHERE NOT condeferrable LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE', fk.tbl, fk.conname);
    made_deferrable := made_deferrable || (fk.tbl::text || '|' || fk.conname);
  END LOOP;
  SET CONSTRAINTS ALL DEFERRED;

  -- The user triggers of every table this writes go off (and only the ones that are on now): the rewrite is not an edit, so no
  -- stamp, no event and no membership bump comes from it.
  FOR trg IN
    SELECT g.tgname, g.tgrelid::regclass AS tbl FROM pg_trigger g
     WHERE NOT g.tgisinternal AND g.tgenabled = 'O'
       AND g.tgrelid IN (SELECT tbl FROM m201_fk UNION SELECT tbl FROM m201_fk_via
                         UNION SELECT 'content_nodes'::regclass UNION SELECT 'spaces'::regclass UNION SELECT 'sync_stamps'::regclass
                         UNION SELECT o2.tbl::regclass FROM m201_other o2)
  LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', trg.tbl, trg.tgname);
    off_triggers := off_triggers || (trg.tbl::text || '|' || trg.tgname);
  END LOOP;

  -- The rows themselves, then everything that names them.
  UPDATE content_nodes c SET id = m.new_id FROM m201_map m WHERE m.verdict = 'rewrite' AND m.kind = 'node' AND c.id = m.old_id;
  UPDATE spaces s SET id = m.new_id FROM m201_map m WHERE m.verdict = 'rewrite' AND m.kind = 'space' AND s.id = m.old_id;
  FOR fk IN SELECT tbl, col, to_space FROM m201_fk UNION ALL SELECT tbl, col, to_space FROM m201_fk_via LOOP
    EXECUTE format('UPDATE %s t SET %I = m.new_id FROM m201_map m WHERE m.verdict = ''rewrite'' AND m.kind = %L AND t.%I = m.old_id',
                   fk.tbl, fk.col, CASE WHEN fk.to_space THEN 'space' ELSE 'node' END, fk.col);
  END LOOP;

  FOR o IN SELECT * FROM m201_other LOOP
    IF o.how = 'uuid' THEN
      EXECUTE format('UPDATE %I t SET %I = m.new_id FROM m201_map m WHERE m.verdict = ''rewrite'' AND m.kind = %L AND t.%I = m.old_id', o.tbl, o.col, o.kind, o.col);
    ELSIF o.how = 'text' THEN
      EXECUTE format('UPDATE %I t SET %I = m.new_id::text FROM m201_map m WHERE m.verdict = ''rewrite'' AND m.kind = %L AND t.%I = m.old_id::text', o.tbl, o.col, o.kind, o.col);
    ELSE
      FOR r IN SELECT * FROM m201_map WHERE verdict = 'rewrite' LOOP
        IF o.how = 'array' AND r.kind = o.kind THEN
          EXECUTE format('UPDATE %I SET %I = array_replace(%I, %L::%s, %L::%s) WHERE %I @> ARRAY[%L::%s]',
                         o.tbl, o.col, o.col, r.old_id, pg_temp.elem_type(o.tbl, o.col), r.new_id, pg_temp.elem_type(o.tbl, o.col), o.col, r.old_id, pg_temp.elem_type(o.tbl, o.col));
        ELSIF o.how = 'json' THEN
          EXECUTE format('UPDATE %I SET %I = replace(%I::text, %L, %L)::jsonb WHERE %I::text LIKE %L%s',
                         o.tbl, o.col, o.col, r.old_id::text, r.new_id::text, o.col, '%' || r.old_id::text || '%',
                         CASE WHEN o.by_workspace THEN format(' AND workspace_id = %L', r.workspace_id) ELSE '' END);
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  -- Who last changed what: the stamps are kept under the row's key. A key holds one id, or two ('note/tag'): the first, then the second.
  FOR pos IN 1..2 LOOP
    old_expr := CASE pos WHEN 1 THEN 'left(src.row_key, 36)' ELSE 'CASE WHEN substr(src.row_key, 37, 1) = ''/'' THEN substr(src.row_key, 38, 36) END' END;
    new_expr := CASE pos WHEN 1 THEN 'm.new_id::text || substr(src.row_key, 37)' ELSE 'left(src.row_key, 37) || m.new_id::text || substr(src.row_key, 74)' END;
    -- a stamp already under the new key (a purged row of that id left a tombstone) gives way to the row's own history
    EXECUTE format('DELETE FROM sync_stamps tgt USING sync_stamps src, m201_map m
        WHERE m.verdict = ''rewrite'' AND src.workspace_id = m.workspace_id AND %s = m.old_id::text
          AND tgt.workspace_id = src.workspace_id AND tgt.table_name = src.table_name AND tgt.field = src.field
          AND tgt.row_key = %s AND tgt.row_key <> src.row_key', old_expr, new_expr);
    EXECUTE format('UPDATE sync_stamps src SET row_key = %s FROM m201_map m
        WHERE m.verdict = ''rewrite'' AND src.workspace_id = m.workspace_id AND %s = m.old_id::text', new_expr, old_expr);
  END LOOP;

  -- Everything is checked here, then the constraints and triggers go back as they were.
  SET CONSTRAINTS ALL IMMEDIATE;
  FOREACH item IN ARRAY made_deferrable LOOP
    EXECUTE format('ALTER TABLE %s ALTER CONSTRAINT %I NOT DEFERRABLE', split_part(item, '|', 1), split_part(item, '|', 2));
  END LOOP;
  FOREACH item IN ARRAY off_triggers LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER %I', split_part(item, '|', 1), split_part(item, '|', 2));
  END LOOP;

  INSERT INTO id_rewrites (old_id, new_id, workspace_id, purpose)
  SELECT old_id, new_id, workspace_id, purpose FROM m201_map WHERE verdict = 'rewrite' ON CONFLICT (old_id) DO NOTHING;

  -- Devices re-read what they may see (workspaces.membership_epoch, as a membership change does).
  UPDATE workspaces SET membership_epoch = membership_epoch + 1 WHERE id IN (SELECT workspace_id FROM m201_map WHERE verdict = 'rewrite');
END
$m201$;
