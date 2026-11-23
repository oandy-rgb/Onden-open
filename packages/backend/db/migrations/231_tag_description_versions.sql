-- 231: a tag's description gets versions like a note's text (docs/architecture/proposals/history-replication-2026-11-22.md, batch 8: §9 row 8, §10 "另外決定").
-- Nothing leaves the node, no shape bump (SYNC_DATA_SHAPE_VERSION unchanged): batches 3-4 already carry any note_versions row, so tags need no transport change.
--
-- WHAT THIS CHANGES
--   note_version_in_scope        the one rule for "has a version list" now says: a note, a board or a TAG, not the system's own notes (it said: note or board).
--                                Every reader and writer that asks it (spine/noteVersions.ts hasVersionList, services/history/*) follows; no one repeats the rule.
--   the commit check             for a tag it counts a miss when its DESCRIPTION (content_nodes.markdown) changed without a version minted by the same write.
--                                Not on creation (a tag is made with an empty description and today's history starts at its first description save: a creation event
--                                with a body_hash does not exist for a tag) and not on a rename (a tag's name is written apart, services/tagIdentity.ts, as a
--                                TAG_UPDATED: today's list does not show a rename as a save and the new one does not either). A note's check is unchanged.
--   tag_versions_backfill(workspace)   the tags' old history as versions, the way migration 220 did it for notes (§8 steps 2-4), for the tags only: one `g:`
--                                version per kept save event of the description AND of the page's whiteboard (`board_ink`; a tag's page has one, and the
--                                scope change gives it `s:` versions from now on, so its old drawings need theirs), the events mapped to them, "restored from",
--                                a drawing a conflict set aside, a `b:` baseline for a description or drawing no version names (root only), one real sequence
--                                number (s0) for what was written. Notes are not touched. A second run writes nothing, with or without saves in between.
--
-- WHAT IS NOT WRITTEN (counted by the preview)
--   * a save whose text is gone from blobs (§4.4 point 2): the list already leaves it out (inner join);
--   * a save that repeats the previous save's title and text: it is mapped to the version it repeats;
--   * nothing for a tag that has never had its description saved and holds an empty one.
-- A workspace being joined when this runs gets nothing (§4.4 point 7); as for 220, BEFORE DEPLOYING check: SELECT count(*) FROM sync_join WHERE state = 'joining'; -- 0 expected
--
-- TIME AND LOCKS: one pass per workspace in this migration's transaction. Reads domain_events, blobs, content_nodes; writes note_versions, note_version_events,
-- note_version_positions, blobs (a baseline's text) and sync_clock.next_seq (one per workspace that got rows, under the workspace's event-append lock).
-- Idempotent: every insert is ON CONFLICT DO NOTHING; a sequence number is taken only when rows were added that have no position yet.
-- drill: no allowance needed; no note body or title is written.
--
-- THE PREVIEW'S PREMISE: its numbers equal what the pass writes only while no tag's save event is mapped to a version yet (the pass leaves a mapped event alone, so
-- that a second run writes nothing). On a database from before this migration that holds, because nothing mapped a tag's event (a tag had no version list).
-- Check it first; the answer must be 0:
--   SELECT count(*) FROM note_version_events ve JOIN content_nodes c ON c.id = ve.note_id WHERE c.node_type = 'class_tag';
--
-- PREVIEW (read-only; run on a production copy BEFORE upgrading; counts only, no ids, names or text). noteVersionsTags.integration.test.ts runs the block
-- between the markers on a copy from before this migration and checks the migration writes exactly these numbers.
-- preview:begin
-- BEGIN READ ONLY;
-- WITH ws AS (SELECT w.id FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = w.id AND j.state = 'joining')),
-- root AS (SELECT w.id FROM ws w WHERE NOT EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = w.id)),
-- scoped AS (SELECT n.id, n.workspace_id, n.title, n.markdown FROM content_nodes n JOIN ws ON ws.id = n.workspace_id
--             WHERE n.node_type = 'class_tag' AND n.source_type <> 'system'),
-- saves AS (SELECT e.id, e.created_at, n.id AS note_id, coalesce(e.body_hash, e.payload->>'body_hash') AS hash, e.payload->>'title' AS title,
--                  CASE e.event_type WHEN 'NODE_CREATED' THEN 'created' WHEN 'NODE_RESTORED' THEN 'restored' ELSE 'updated' END AS kind
--             FROM domain_events e JOIN scoped n ON n.id::text = e.target_id AND n.workspace_id = e.workspace_id
--            WHERE e.event_type IN ('NODE_CREATED', 'NODE_UPDATED', 'NODE_RESTORED') AND e.payload ? 'body_hash'),
-- kept AS (SELECT s.*, (s.hash IS DISTINCT FROM lag(s.hash) OVER w OR s.title IS DISTINCT FROM lag(s.title) OVER w) AS keep
--            FROM saves s WINDOW w AS (PARTITION BY s.note_id ORDER BY s.created_at, s.id)),
-- body_keys AS (SELECT 'g:' || encode(sha256(convert_to('onden version 1'
--                  || length(convert_to(k.note_id::text, 'UTF8')) || ':' || k.note_id::text || '4:body'
--                  || length(convert_to(k.kind, 'UTF8')) || ':' || k.kind
--                  || CASE WHEN k.hash IS NULL THEN '-' ELSE length(convert_to(k.hash, 'UTF8')) || ':' || k.hash END
--                  || CASE WHEN k.title IS NULL THEN '-' ELSE length(convert_to(k.title, 'UTF8')) || ':' || k.title END
--                  || '27:' || to_char(k.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'UTF8')), 'hex') AS key, k.note_id
--                 FROM kept k WHERE k.keep AND EXISTS (SELECT 1 FROM blobs b WHERE b.hash = k.hash)),
-- ink AS (SELECT e.id, e.created_at, n.id AS note_id,
--                CASE WHEN e.payload->>'key' = 'ink_data' AND EXISTS (SELECT 1 FROM board_ink_moves m WHERE m.node_id = n.id AND m.action = 'moved'
--                       AND m.restored_at IS NULL AND e.created_at < m.moved_at) THEN 'board_ink' ELSE e.payload->>'key' END AS unit,
--                CASE WHEN e.event_type = 'ATTRIBUTE_DELETED' THEN 'removed' WHEN jsonb_typeof(e.tx_meta->'prev_field_values') = 'object' THEN 'updated' ELSE 'created' END AS kind,
--                CASE WHEN e.event_type = 'ATTRIBUTE_DELETED' THEN NULL
--                     ELSE COALESCE(e.payload->>'value_ref', encode(sha256(convert_to(e.payload->>'value', 'UTF8')), 'hex')) END AS hash,
--                (e.event_type = 'ATTRIBUTE_SET' AND NOT e.payload ? 'value_ref' AND e.payload ? 'value') AS inline
--           FROM domain_events e JOIN scoped n ON n.id::text = e.target_id AND n.workspace_id = e.workspace_id
--          WHERE e.event_type IN ('ATTRIBUTE_SET', 'ATTRIBUTE_DELETED') AND e.payload->>'key' IN ('ink_data', 'board_ink', 'note_ink')),
-- ink_kept AS (SELECT i.*, (i.hash IS DISTINCT FROM lag(i.hash) OVER w OR i.kind = 'removed' OR lag(i.kind) OVER w = 'removed' OR lag(i.kind) OVER w IS NULL) AS keep
--                FROM ink i WINDOW w AS (PARTITION BY i.note_id, i.unit ORDER BY i.created_at, i.id)),
-- ink_keys AS (SELECT 'g:' || encode(sha256(convert_to('onden version 1'
--                  || length(convert_to(k.note_id::text, 'UTF8')) || ':' || k.note_id::text
--                  || length(convert_to(k.unit, 'UTF8')) || ':' || k.unit || length(convert_to(k.kind, 'UTF8')) || ':' || k.kind
--                  || CASE WHEN k.hash IS NULL THEN '-' ELSE length(convert_to(k.hash, 'UTF8')) || ':' || k.hash END
--                  || '-27:' || to_char(k.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'UTF8')), 'hex') AS key, k.note_id, k.unit, k.hash
--                FROM ink_kept k WHERE k.keep AND (k.hash IS NULL OR k.inline OR EXISTS (SELECT 1 FROM blobs b WHERE b.hash = k.hash)
--                                                  OR EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = k.note_id AND m.hash = k.hash))),
-- body_base AS (SELECT n.id FROM scoped n JOIN root ON root.id = n.workspace_id WHERE n.markdown <> ''
--                 AND NOT EXISTS (SELECT 1 FROM kept k WHERE k.note_id = n.id AND k.keep AND k.hash = encode(sha256(convert_to(n.markdown, 'UTF8')), 'hex')
--                                   AND EXISTS (SELECT 1 FROM blobs b WHERE b.hash = k.hash))),
-- ink_base AS (SELECT a.node_id FROM node_attributes a JOIN scoped n ON n.id = a.node_id JOIN root ON root.id = n.workspace_id
--               WHERE a.key IN ('ink_data', 'board_ink', 'note_ink') AND a.value <> ''
--                 AND NOT EXISTS (SELECT 1 FROM ink_keys k WHERE k.note_id = a.node_id AND k.unit = a.key AND k.hash = encode(sha256(convert_to(a.value, 'UTF8')), 'hex'))),
-- aside AS (SELECT DISTINCT n.id AS note_id, u.unit, e.payload->>'overridden_value_ref' AS hash
--             FROM domain_events e JOIN scoped n ON n.id::text = e.target_id AND n.workspace_id = e.workspace_id
--             CROSS JOIN LATERAL (SELECT CASE WHEN e.payload->>'key' = 'ink_data' AND EXISTS (SELECT 1 FROM board_ink_moves m WHERE m.node_id = n.id AND m.action = 'moved'
--                                       AND m.restored_at IS NULL AND e.created_at < m.moved_at) THEN 'board_ink' ELSE e.payload->>'key' END AS unit) u
--            WHERE e.event_type = 'ATTRIBUTE_CONFLICT' AND e.payload->>'key' IN ('ink_data', 'board_ink', 'note_ink') AND e.payload ? 'overridden_value_ref'
--              AND (EXISTS (SELECT 1 FROM blobs b WHERE b.hash = e.payload->>'overridden_value_ref')
--                   OR EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = n.id AND m.hash = e.payload->>'overridden_value_ref'))
--              AND NOT EXISTS (SELECT 1 FROM ink_keys k WHERE k.note_id = n.id AND k.unit = u.unit AND k.hash = e.payload->>'overridden_value_ref'))
-- SELECT (SELECT count(*) FROM scoped) AS tags,
--        (SELECT count(DISTINCT note_id) FROM saves) AS tags_with_description_saves,
--        (SELECT count(DISTINCT (note_id, key)) FROM body_keys) AS description_versions,
--        (SELECT count(*) FROM body_base) AS description_baselines,
--        (SELECT count(DISTINCT note_id) FROM ink) AS tags_with_drawing_saves,
--        (SELECT count(DISTINCT (note_id, unit, key)) FROM ink_keys) AS drawing_versions,
--        (SELECT count(*) FROM ink_base) AS drawing_baselines,
--        (SELECT count(*) FROM ink_kept k WHERE k.keep AND k.inline) AS drawing_inline_values,
--        (SELECT count(*) FROM ink_kept k WHERE k.keep AND NOT k.inline AND k.hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.hash = k.hash)
--            AND NOT EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = k.note_id AND m.hash = k.hash)) AS drawing_saves_without_value,
--        (SELECT count(*) FROM kept k WHERE NOT EXISTS (SELECT 1 FROM blobs b WHERE b.hash = k.hash)) AS description_saves_without_text,
--        (SELECT count(*) FROM aside) AS drawings_set_aside;
-- ROLLBACK;
-- preview:end
--
-- UNDO (before a later batch reads these rows): restore the rule in note_version_in_scope ('content', 'canvas') and the two content_nodes_have_version_* triggers of
-- migration 220; DELETE FROM note_versions v USING content_nodes c WHERE c.id = v.note_id AND c.node_type = 'class_tag' (positions and event maps cascade);
-- DROP FUNCTION tag_versions_backfill(uuid). (The sequence numbers taken stay taken: numbers have gaps anyway.)

-- The one rule: a note, a board or a tag, not the system's own notes (Site Config). §4.4 point 6 and §10.
CREATE OR REPLACE FUNCTION note_version_in_scope(p_node_type text, p_source_type text) RETURNS boolean AS $$
  SELECT p_node_type IN ('content', 'canvas', 'class_tag') AND p_source_type IS DISTINCT FROM 'system';
$$ LANGUAGE sql IMMUTABLE;

-- A tag is created with an empty description and has no creation save (only a TAG_CREATED event): no version is owed at its insert. Its description
-- is checked when it changes; its title (the tag's name, written apart as a TAG_UPDATED) is not a version of the description. A note: as before.
DROP TRIGGER IF EXISTS content_nodes_have_version_insert ON content_nodes;
CREATE CONSTRAINT TRIGGER content_nodes_have_version_insert AFTER INSERT ON content_nodes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (note_version_in_scope(NEW.node_type, NEW.source_type) AND NEW.node_type <> 'class_tag')
  EXECUTE FUNCTION note_version_check_body();
DROP TRIGGER IF EXISTS content_nodes_have_version_update ON content_nodes;
CREATE CONSTRAINT TRIGGER content_nodes_have_version_update AFTER UPDATE OF title, markdown ON content_nodes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD.markdown IS DISTINCT FROM NEW.markdown OR (OLD.title IS DISTINCT FROM NEW.title AND NEW.node_type <> 'class_tag'))
        AND note_version_in_scope(NEW.node_type, NEW.source_type))
  EXECUTE FUNCTION note_version_check_body();

-- The commit check of migration 220 (note_version_check_body), the same but for one thing: a tag's version is of its DESCRIPTION, so the tag's current
-- name is not compared (a description saved with a rename in one request names the name its event names; the rename itself is written apart).
CREATE OR REPLACE FUNCTION note_version_check_body() RETURNS trigger AS $$
DECLARE s jsonb; n record;
BEGIN
  IF note_version_exempt(NEW.workspace_id) IS NOT NULL THEN RETURN NULL; END IF;
  SELECT c.title, c.markdown, c.node_type, c.source_type INTO n FROM content_nodes c WHERE c.id = NEW.id;
  IF NOT FOUND OR NOT note_version_in_scope(n.node_type, n.source_type) THEN RETURN NULL; END IF;
  s := current_setting(sync_stamp_setting(NEW.workspace_id), true)::jsonb;
  IF EXISTS (SELECT 1 FROM note_version_positions p
               JOIN note_versions v ON v.note_id = p.note_id AND v.unit = p.unit AND v.version_key = p.version_key
               JOIN blobs b ON b.hash = v.content_hash
              WHERE p.workspace_id = NEW.workspace_id AND p.origin = s->>'origin' AND p.seq = (s->>'seq')::bigint
                AND p.note_id = NEW.id AND p.unit = 'body' AND v.version_key LIKE 's:%'
                AND (n.node_type = 'class_tag' OR v.title IS NOT DISTINCT FROM n.title) AND b.content = n.markdown) THEN RETURN NULL; END IF;
  PERFORM note_version_count_miss(NEW.workspace_id, 'body', NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- The old history of one workspace's tags as versions: migration 220's pass (note_versions_backfill) restricted to node_type 'class_tag', for the text AND for the
-- drawings (a tag's page has a whiteboard, `board_ink`: services/boardStore.ts, backupRestore.ts). Returns what it added. Called once per workspace below.
-- Safe to run again, with saves made in between: an event already mapped to a version (a later save minted its own `s:`) is left alone.
CREATE OR REPLACE FUNCTION tag_versions_backfill(p_ws uuid) RETURNS TABLE (versions bigint, baselines bigint, set_aside bigint, s0 bigint) AS $$
DECLARE
  v_node text;
  v_root boolean := NOT EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = p_ws);
  v_versions bigint := 0; v_baselines bigint := 0; v_aside bigint := 0; v_s0 bigint := NULL; n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = p_ws AND j.state = 'joining') THEN
    RETURN QUERY SELECT 0::bigint, 0::bigint, 0::bigint, NULL::bigint; RETURN;
  END IF;
  v_node := (SELECT node_id FROM sync_node WHERE singleton);
  IF v_node IS NULL THEN
    INSERT INTO sync_node (singleton, node_id) VALUES (true, gen_random_uuid()::text) ON CONFLICT (singleton) DO NOTHING;
    v_node := (SELECT node_id FROM sync_node WHERE singleton);
  END IF;

  -- an older drawing save with its value inline: its value is stored first, so it is a stored version like the others
  INSERT INTO blobs (hash, content, size_bytes)
  SELECT DISTINCT encode(sha256(convert_to(e.payload->>'value', 'UTF8')), 'hex'), e.payload->>'value', octet_length(e.payload->>'value')
    FROM domain_events e
   WHERE e.workspace_id = p_ws AND e.event_type = 'ATTRIBUTE_SET' AND e.payload->>'key' IN ('ink_data', 'board_ink', 'note_ink')
     AND NOT e.payload ? 'value_ref' AND e.payload ? 'value'
  ON CONFLICT (hash) DO NOTHING;

  CREATE TEMP TABLE IF NOT EXISTS tv_candidates (event_id bigint, created_at timestamptz, note_id uuid, unit text, kind text, hash text, title text,
    keep boolean, stored boolean, author_kind text, author_id uuid, source_name text, restored_event text, event_restored text) ON COMMIT DROP;
  TRUNCATE tv_candidates;
  INSERT INTO tv_candidates
  WITH scoped AS (SELECT c.id FROM content_nodes c WHERE c.workspace_id = p_ws AND (c.node_type = 'class_tag' AND note_version_in_scope(c.node_type, c.source_type))),
  ev AS (
    SELECT e.*, n.id AS note_id, a.type AS row_type, a.workspace_id AS row_ws, (e.tx_meta ? 'history_import') AS imported,
           COALESCE(e.tx_meta->'history_import'->>'actor_type', e.actor_type) AS eff_type
      FROM domain_events e JOIN scoped n ON n.id::text = e.target_id
      LEFT JOIN actors a ON a.id::text = e.actor_id
     WHERE e.workspace_id = p_ws
       AND ((e.event_type IN ('NODE_CREATED', 'NODE_UPDATED', 'NODE_RESTORED') AND e.payload ? 'body_hash')
         OR (e.event_type IN ('ATTRIBUTE_SET', 'ATTRIBUTE_DELETED') AND e.payload->>'key' IN ('ink_data', 'board_ink', 'note_ink')))),
  shaped AS (
    SELECT ev.id, ev.created_at, ev.note_id,
           CASE WHEN ev.event_type LIKE 'NODE_%' THEN 'body'
                WHEN ev.payload->>'key' = 'ink_data' AND EXISTS (SELECT 1 FROM board_ink_moves m WHERE m.node_id = ev.note_id AND m.action = 'moved'
                       AND m.restored_at IS NULL AND ev.created_at < m.moved_at) THEN 'board_ink'
                ELSE ev.payload->>'key' END AS unit,
           CASE ev.event_type WHEN 'NODE_CREATED' THEN 'created' WHEN 'NODE_RESTORED' THEN 'restored' WHEN 'NODE_UPDATED' THEN 'updated'
                WHEN 'ATTRIBUTE_DELETED' THEN 'removed'
                ELSE CASE WHEN jsonb_typeof(ev.tx_meta->'prev_field_values') = 'object' THEN 'updated' ELSE 'created' END END AS kind,
           CASE WHEN ev.event_type LIKE 'NODE_%' THEN COALESCE(ev.body_hash, ev.payload->>'body_hash')
                WHEN ev.event_type = 'ATTRIBUTE_DELETED' THEN NULL
                ELSE COALESCE(ev.payload->>'value_ref', encode(sha256(convert_to(ev.payload->>'value', 'UTF8')), 'hex')) END AS hash,
           CASE WHEN ev.event_type LIKE 'NODE_%' THEN ev.payload->>'title' END AS title,
           CASE WHEN NOT ev.imported AND ev.row_type = 'session' THEN 'session' WHEN ev.eff_type = 'ai_agent' THEN 'ai'
                WHEN ev.eff_type = 'system' THEN 'automatic' ELSE 'person' END AS author_kind,
           CASE WHEN NOT ev.imported AND ev.eff_type = 'user' AND ev.row_type = 'human' AND ev.row_ws = p_ws THEN ev.actor_id::uuid END AS author_id,
           CASE WHEN ev.imported THEN ev.tx_meta->'history_import'->>'actor_name' END AS source_name,
           CASE WHEN ev.event_type = 'NODE_RESTORED' THEN ev.payload->>'version_id' END AS restored_event,
           CASE WHEN ev.event_type <> 'NODE_RESTORED' THEN ev.tx_meta->>'restored_from' END AS event_restored
      FROM ev)
  SELECT s.id, s.created_at, s.note_id, s.unit, s.kind, s.hash, s.title,
         CASE WHEN s.unit = 'body'
              THEN s.hash IS DISTINCT FROM lag(s.hash) OVER w OR s.title IS DISTINCT FROM lag(s.title) OVER w
              ELSE s.hash IS DISTINCT FROM lag(s.hash) OVER w OR s.kind = 'removed' OR lag(s.kind) OVER w = 'removed' OR lag(s.kind) OVER w IS NULL END,
         CASE WHEN s.kind = 'removed' THEN true
              WHEN s.unit = 'body' THEN EXISTS (SELECT 1 FROM blobs b WHERE b.hash = s.hash)
              ELSE s.hash IS NOT NULL AND (EXISTS (SELECT 1 FROM blobs b WHERE b.hash = s.hash)
                                           OR EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = s.note_id AND m.hash = s.hash)) END,
         s.author_kind, s.author_id, s.source_name, s.restored_event, s.event_restored
    FROM shaped s WINDOW w AS (PARTITION BY s.note_id, s.unit ORDER BY s.created_at, s.id);
  ANALYZE tv_candidates;

  -- 2. (migration 220 §8 step 2, for tags) the saves as `g:` versions: kept and stored ones, ranked by (created_at, id); a key two saves share is one version, the earlier's.
  -- A repeat (not kept) belongs to the kept save before it: every save between the two repeats it, so they hold the same title and content.
  CREATE TEMP TABLE IF NOT EXISTS tv_ranked (event_id bigint, note_id uuid, unit text, kind text, hash text, title text, created_at timestamptz,
    keep boolean, stored boolean, author_kind text, author_id uuid, source_name text, ordinal bigint, grp bigint, key text,
    restored_event text, event_restored text, mapped boolean) ON COMMIT DROP;
  TRUNCATE tv_ranked;
  INSERT INTO tv_ranked
  SELECT c.event_id, c.note_id, c.unit, c.kind, c.hash, c.title, c.created_at, c.keep, c.stored, c.author_kind, c.author_id, c.source_name,
         row_number() OVER w, count(*) FILTER (WHERE c.keep) OVER w,
         note_version_legacy_key(c.note_id, c.unit, c.kind, c.hash, c.title, note_version_at(c.created_at)), c.restored_event, c.event_restored,
         EXISTS (SELECT 1 FROM note_version_events ve WHERE ve.event_id = c.event_id)
    FROM tv_candidates c WINDOW w AS (PARTITION BY c.note_id, c.unit ORDER BY c.created_at, c.event_id);
  ANALYZE tv_ranked; -- a temporary table has no statistics: without them the joins below are planned for one row
  WITH ins AS (
    INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, title, content_hash, at, ordinal, recorded_by, author_kind, author_id, source_name)
    SELECT DISTINCT ON (r.note_id, r.unit, r.key) p_ws, r.note_id, r.unit, r.key, r.kind, r.title, r.hash, note_version_at(r.created_at), r.ordinal, v_node,
           r.author_kind, r.author_id, r.source_name
      FROM tv_ranked r WHERE r.keep AND r.stored AND NOT r.mapped
     ORDER BY r.note_id, r.unit, r.key, r.ordinal
    ON CONFLICT DO NOTHING RETURNING 1)
  SELECT count(*) INTO v_versions FROM ins;

  -- every save event to the version it records: a kept one to its own, a repeat to its group's. An event that is already mapped (a save made after this
  -- migration, which minted its own `s:` version) is left alone, so a second pass writes nothing whatever was saved in between.
  INSERT INTO note_version_events (event_id, note_id, unit, version_key)
  SELECT c.event_id, c.note_id, c.unit, k.key FROM tv_ranked c
    JOIN tv_ranked k ON k.note_id = c.note_id AND k.unit = c.unit AND k.grp = c.grp AND k.keep AND k.stored
   WHERE NOT c.mapped
  ON CONFLICT DO NOTHING;

  -- 4.4 point 4: "restored from", as the local write path gives it (services/nodeUpdate.ts restoreNodeVersion, eventRestore/restore.ts): only the
  -- save that minted a version decides it (a repeat mints nothing, so it names nothing), the earliest such save when two share a key, never the
  -- version itself; and only from (created_at, id) orders, so every copy of the database gives the same answer whatever the rows' physical order.
  -- A version restore names the restored event (payload.version_id); an event undo names the undone EVENT, so it restored the version before it,
  -- when the content matches.
  UPDATE note_versions v SET restored_from = t.target
    FROM (SELECT DISTINCT ON (r.note_id, r.unit, r.key) r.note_id, r.unit, r.key, m.version_key AS target
            FROM tv_ranked r
            JOIN note_version_events m ON r.restored_event ~ '^\d{1,18}$' AND m.event_id = r.restored_event::bigint AND m.note_id = r.note_id AND m.unit = r.unit
           WHERE r.keep AND r.stored
           ORDER BY r.note_id, r.unit, r.key, r.ordinal) t
   WHERE v.note_id = t.note_id AND v.unit = t.unit AND v.version_key = t.key AND v.restored_from IS NULL AND v.version_key LIKE 'g:%' AND t.target <> t.key;
  UPDATE note_versions v SET restored_from = t.target
    FROM (SELECT DISTINCT ON (r.note_id, r.unit, r.key) r.note_id, r.unit, r.key, before.version_key AS target, before.content_hash AS target_hash
            FROM tv_ranked r
            JOIN domain_events undone ON r.event_restored ~ '^\d{1,18}$' AND undone.id = r.event_restored::bigint
            CROSS JOIN LATERAL (
              SELECT ve.version_key, pv.content_hash FROM note_version_events ve JOIN domain_events pe ON pe.id = ve.event_id
                JOIN note_versions pv ON pv.note_id = ve.note_id AND pv.unit = ve.unit AND pv.version_key = ve.version_key
               WHERE ve.note_id = r.note_id AND ve.unit = r.unit AND (pe.created_at, pe.id) < (undone.created_at, undone.id)
               ORDER BY pe.created_at DESC, pe.id DESC LIMIT 1) before
           WHERE r.keep AND r.stored
           ORDER BY r.note_id, r.unit, r.key, r.ordinal) t
   WHERE v.note_id = t.note_id AND v.unit = t.unit AND v.version_key = t.key AND v.restored_from IS NULL AND v.version_key LIKE 'g:%'
     AND t.target_hash IS NOT DISTINCT FROM v.content_hash AND t.target <> t.key;

  -- a drawing a conflict overrode that no version holds (see the header)
  WITH aside AS (
    SELECT DISTINCT ON (n.id, unit.u, e.payload->>'overridden_value_ref') e.id, e.created_at, n.id AS note_id, unit.u AS unit, e.payload->>'overridden_value_ref' AS hash
      FROM domain_events e JOIN content_nodes n ON n.id::text = e.target_id AND n.workspace_id = p_ws AND (n.node_type = 'class_tag' AND note_version_in_scope(n.node_type, n.source_type))
      CROSS JOIN LATERAL (SELECT CASE WHEN e.payload->>'key' = 'ink_data' AND EXISTS (SELECT 1 FROM board_ink_moves m WHERE m.node_id = n.id AND m.action = 'moved'
                                  AND m.restored_at IS NULL AND e.created_at < m.moved_at) THEN 'board_ink' ELSE e.payload->>'key' END AS u) unit
     WHERE e.workspace_id = p_ws AND e.event_type = 'ATTRIBUTE_CONFLICT' AND e.payload->>'key' IN ('ink_data', 'board_ink', 'note_ink')
       AND e.payload ? 'overridden_value_ref'
       AND (EXISTS (SELECT 1 FROM blobs b WHERE b.hash = e.payload->>'overridden_value_ref')
            OR EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = n.id AND m.hash = e.payload->>'overridden_value_ref'))
       AND NOT EXISTS (SELECT 1 FROM note_versions v WHERE v.note_id = n.id AND v.unit = unit.u AND v.content_hash = e.payload->>'overridden_value_ref')
     ORDER BY n.id, unit.u, e.payload->>'overridden_value_ref', e.created_at, e.id),
  ins AS (
    INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, content_hash, at, ordinal, recorded_by, author_kind)
    SELECT p_ws, a.note_id, a.unit, note_version_legacy_key(a.note_id, a.unit, 'set_aside', a.hash, NULL, note_version_at(a.created_at)), 'set_aside', a.hash,
           note_version_at(a.created_at), 0, v_node, 'person'
      FROM aside a ON CONFLICT DO NOTHING RETURNING 1)
  SELECT count(*) INTO v_aside FROM ins;

  -- 4. the root's baselines: content that no version names, not empty. Its text is stored in the same step (no write runs meanwhile).
  IF v_root THEN
    INSERT INTO blobs (hash, content, size_bytes)
    SELECT encode(sha256(convert_to(c.markdown, 'UTF8')), 'hex'), c.markdown, octet_length(c.markdown)
      FROM content_nodes c WHERE c.workspace_id = p_ws AND (c.node_type = 'class_tag' AND note_version_in_scope(c.node_type, c.source_type)) AND c.markdown <> ''
       AND NOT EXISTS (SELECT 1 FROM note_versions v WHERE v.note_id = c.id AND v.unit = 'body' AND v.content_hash = encode(sha256(convert_to(c.markdown, 'UTF8')), 'hex'))
    ON CONFLICT (hash) DO NOTHING;
    WITH ins AS (
      INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, title, content_hash, at, ordinal, recorded_by, author_kind)
      SELECT p_ws, c.id, 'body', note_version_baseline_key(c.id, 'body', h.hash), 'baseline', c.title, h.hash, note_version_at(c.updated_at), 0, v_node, 'automatic'
        FROM content_nodes c CROSS JOIN LATERAL (SELECT encode(sha256(convert_to(c.markdown, 'UTF8')), 'hex') AS hash) h
       WHERE c.workspace_id = p_ws AND (c.node_type = 'class_tag' AND note_version_in_scope(c.node_type, c.source_type)) AND c.markdown <> ''
         AND NOT EXISTS (SELECT 1 FROM note_versions v WHERE v.note_id = c.id AND v.unit = 'body' AND v.content_hash = h.hash)
      ON CONFLICT DO NOTHING RETURNING 1)
    SELECT count(*) INTO n FROM ins;
    v_baselines := n;
    -- the one-time hashing of each drawing that has no version (a drawing saved before 172 without an event, for example)
    CREATE TEMP TABLE IF NOT EXISTS tv_ink_base (node_id uuid, key text, hash text, updated_at timestamptz) ON COMMIT DROP;
    TRUNCATE tv_ink_base;
    INSERT INTO tv_ink_base
    SELECT a.node_id, a.key, encode(sha256(convert_to(a.value, 'UTF8')), 'hex'), a.updated_at
      FROM node_attributes a JOIN content_nodes c ON c.id = a.node_id AND (c.node_type = 'class_tag' AND note_version_in_scope(c.node_type, c.source_type))
     WHERE a.workspace_id = p_ws AND a.key IN ('ink_data', 'board_ink', 'note_ink') AND a.value <> '';
    DELETE FROM tv_ink_base i WHERE EXISTS (SELECT 1 FROM note_versions v WHERE v.note_id = i.node_id AND v.unit = i.key AND v.content_hash = i.hash);
    INSERT INTO blobs (hash, content, size_bytes)
    SELECT i.hash, a.value, octet_length(a.value) FROM tv_ink_base i JOIN node_attributes a ON a.node_id = i.node_id AND a.key = i.key
     WHERE NOT EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = i.node_id AND m.hash = i.hash)
    ON CONFLICT (hash) DO NOTHING;
    WITH ins AS (
      INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, content_hash, at, ordinal, recorded_by, author_kind)
      SELECT p_ws, i.node_id, i.key, note_version_baseline_key(i.node_id, i.key, i.hash), 'baseline', i.hash, note_version_at(i.updated_at), 0, v_node, 'automatic'
        FROM tv_ink_base i ON CONFLICT DO NOTHING RETURNING 1)
    SELECT count(*) INTO n FROM ins;
    v_baselines := v_baselines + n;
  END IF;

  -- 3. (the same) one real sequence number for what this pass wrote, only when it wrote something that has no position yet (a second run takes none)
  IF EXISTS (SELECT 1 FROM note_versions v JOIN content_nodes tg ON tg.id = v.note_id AND tg.node_type = 'class_tag' WHERE v.workspace_id = p_ws AND v.version_key NOT LIKE 's:%'
               AND NOT EXISTS (SELECT 1 FROM note_version_positions p WHERE p.note_id = v.note_id AND p.unit = v.unit AND p.version_key = v.version_key)) THEN
    SELECT c.next_seq INTO v_s0 FROM sync_lock_clock(p_ws) c;
    UPDATE sync_clock SET next_seq = v_s0 + 1 WHERE workspace_id = p_ws;
    INSERT INTO note_version_positions (workspace_id, note_id, unit, version_key, origin, seq)
    SELECT p_ws, v.note_id, v.unit, v.version_key, v_node, v_s0 FROM note_versions v JOIN content_nodes tg ON tg.id = v.note_id AND tg.node_type = 'class_tag'
     WHERE v.workspace_id = p_ws AND v.version_key NOT LIKE 's:%'
       AND NOT EXISTS (SELECT 1 FROM note_version_positions p WHERE p.note_id = v.note_id AND p.unit = v.unit AND p.version_key = v.version_key);
  END IF;
  RETURN QUERY SELECT v_versions, v_baselines, v_aside, v_s0;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE w record;
BEGIN
  FOR w IN SELECT id FROM workspaces ORDER BY id LOOP
    PERFORM tag_versions_backfill(w.id);
  END LOOP;
END $$;
