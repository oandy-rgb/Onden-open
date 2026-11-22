-- 220: a note's versions get an identity that is the same on every node (docs/architecture/proposals/history-replication-2026-11-22.md, batch 1:
-- §2.2, §2.3, §2.5, §4.1, §4.4, §6, §7, §8; review of PR #1935, round 2, points 1-9). Nothing leaves the node yet: no snapshot layer, no bundle
-- item, no reader reads these tables (that is batches 2-4). SYNC_DATA_SHAPE_VERSION is unchanged.
--
-- WHAT THIS ADDS
--   note_versions            one row per version of a note's body (unit 'body': title + text) or of one of its drawings (unit = the attribute key
--                            ink_data / board_ink / note_ink). Identity and description only; the content stays in blobs / ink_manifests,
--                            named by content_hash. Written once by the node that mints it, never changed (syncClasses.json: separate).
--   note_version_positions   where a version travels from (origin, seq): a set, only grows (§2.5). Not part of the identity.
--   note_version_events      THIS node's map from its own domain_events to the version each records (node-local: event ids are this node's).
--   note_version_legacy_key / note_version_baseline_key   the one encoding of a `g:` / `b:` key (§4.4 point 9; spine/noteVersions.ts is the JS twin,
--                            versionKeys.integration.test.ts compares the two).
--   note_versions_content_stored   deferred: at COMMIT, every `s:` / `b:` version names content that is stored, or the transaction fails (point 1).
--   content_nodes_have_version_* / node_attributes_ink_have_version_*   deferred: at COMMIT, a local root write that changed a note's title or
--                            text, or a drawing, without minting its version in the same transaction is counted
--                            in sync_clock.version_misses (counted, not refused, in this batch: see that column).
--   domain_events_link_version   deferred: a save event is mapped to the version it records (note_version_events); an unchanged save to the one it repeats.
--
-- WHO MINTS
--   s:<origin>:<seq>:<ordinal>  a local write, by spine/noteVersions.ts recordVersion, after the caller stored the content (putBlob / putInkChunks on
--                               their own connection, as today). No trigger stores content and no SQL hashes a drawing (review round 2, point 1).
--   g:<sha256 …>                every save this node has recorded (its events), minted once here; later a backup's carried history (spine/importedHistory.ts).
--   b:<sha256 …>                the root of a workspace only (no sync_join row for it): a note or drawing whose current content no version names.
-- Skipped on purpose: a snapshot join and a merge (sync_import_active), the shell and data migrations (the transaction setting onden.no_versions,
-- db.ts migrate()), a write outside the roots (a stamp marked `bypass`, already counted in sync_clock.writes_without_mutate), tags (class_tag)
-- and system notes (source_type 'system', Site Config). A workspace being joined when this runs gets nothing (it is a joining node, §4.4 point 7).
-- Such a join, cancelled later, leaves the empty shell again (spine/stampedImport.ts cancelJoin removes everything the snapshot wrote), so
-- there is no history left to backfill; finished, it is a joined workspace whose history its source holds. BEFORE DEPLOYING, the operator
-- checks no join is open: SELECT count(*) FROM sync_join WHERE state = 'joining';  -- 0 expected (review of PR #1938, round 1, point 11)
--
-- AN OLDER DRAWING SAVE carries its value inline (payload.value, before value_ref existed): the pass stores that value in blobs (as the
-- baselines' text) and mints it like any other; the preview counts them (ink_inline_values).
--
-- WHAT IS NOT MINTED (counted by the preview)
--   * a save whose text is gone from blobs (§4.4 point 2): the version list already leaves it out (inner join); a drawing's save likewise
--     (drawing_saves_without_value);
--   * a save that repeats the previous save's title and text (the version list's `keep`): it is mapped to the version it repeats;
--   * a drawing's ATTRIBUTE_CONFLICT: the overridden drawing is the unit's previous value, which already has its version (the save that wrote it,
--     or the baseline below). Minting it again would give one content and history two identities (review round 1, point 1). It is minted as
--     `set_aside` only when no version of that drawing holds it.
--   * a pre-172 `ink_data` save is filed under the unit the board_ink_moves table gives it NOW (§2.3): undoing a 172 move later does not move
--     those versions back.
--
-- TIME AND LOCKS: one pass per workspace in this migration's transaction (migrate(): statement_timeout 0). It reads domain_events, blobs,
-- ink_manifests, content_nodes, node_attributes and writes only the three new tables, blobs (baselines' text) and sync_clock.next_seq (one per
-- workspace that got rows; under the workspace's event-append lock). Measured on 15,000 events: noteVersionsMigration.integration.test.ts.
-- Idempotent: every insert is ON CONFLICT DO NOTHING; a sequence number is taken only when rows were added that have no position yet.
-- NOT in this batch: the "deleted together" groups of §7 (trash_groups). Nothing reads them before batch 5, the review leaves them open to the
-- owner's question 7, and the event chain they are built from is append-only, so batch 5 builds them from the same facts.
-- drill: no allowance needed; no note body or title is written.
--
-- PREVIEW (read-only; run on a production copy BEFORE upgrading to see what this migration will write; counts only, no ids or text).
-- noteVersionsMigration.integration.test.ts runs the block between the markers on an old copy and checks that the migration writes exactly
-- these numbers. The key expressions are those of note_version_legacy_key / note_version_baseline_key, written out (the functions do not exist yet).
-- preview:begin
-- BEGIN READ ONLY;
-- WITH ws AS (SELECT w.id FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = w.id AND j.state = 'joining')),
-- root AS (SELECT w.id FROM ws w WHERE NOT EXISTS (SELECT 1 FROM sync_join j WHERE j.workspace_id = w.id)),
-- scoped AS (SELECT n.id, n.workspace_id, n.title, n.markdown FROM content_nodes n JOIN ws ON ws.id = n.workspace_id
--             WHERE n.node_type IN ('content', 'canvas') AND n.source_type <> 'system'),
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
--                 AND NOT EXISTS (SELECT 1 FROM ink_keys k WHERE k.note_id = a.node_id AND k.unit = a.key AND k.hash = encode(sha256(convert_to(a.value, 'UTF8')), 'hex')))
-- SELECT (SELECT count(DISTINCT (note_id, key)) FROM body_keys) AS body_versions,
--        (SELECT count(DISTINCT (note_id, unit, key)) FROM ink_keys) AS ink_versions,
--        (SELECT count(*) FROM body_base) AS body_baselines,
--        (SELECT count(*) FROM ink_base) AS ink_baselines,
--        (SELECT count(*) FROM ink_kept k WHERE k.keep AND k.inline) AS ink_inline_values,
--        (SELECT count(*) FROM ink_kept k WHERE k.keep AND NOT k.inline AND k.hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.hash = k.hash)
--            AND NOT EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = k.note_id AND m.hash = k.hash)) AS drawing_saves_without_value,
--        (SELECT count(*) FROM kept k WHERE NOT EXISTS (SELECT 1 FROM blobs b WHERE b.hash = k.hash)) AS saves_without_text;
-- ROLLBACK;
-- preview:end
-- (Ink set-aside versions are not in the preview: they need the versions above to exist first; the migration reports them as `set_aside`.)
--
-- UNDO (before any later batch reads these tables): DROP TRIGGER content_nodes_have_version_insert, content_nodes_have_version_update ON content_nodes;
-- DROP TRIGGER node_attributes_ink_have_version_insert, node_attributes_ink_have_version_update, node_attributes_ink_have_version_delete ON node_attributes; DROP TRIGGER domain_events_link_version
-- ON domain_events; DROP TRIGGER note_versions_content_stored ON note_versions; DROP TABLE note_version_events, note_version_positions, note_versions; ALTER TABLE sync_clock DROP COLUMN version_misses; DROP FUNCTION note_version_*;
-- (the sequence numbers taken stay taken: numbers have gaps anyway).

CREATE TABLE IF NOT EXISTS note_versions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- A note deleted for good takes its versions with it on every node (§6): the cascade, like ink_chunks.
  note_id uuid NOT NULL REFERENCES content_nodes(id) ON DELETE CASCADE,
  unit text NOT NULL CHECK (unit IN ('body', 'ink_data', 'board_ink', 'note_ink')),
  version_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('created', 'updated', 'restored', 'merged', 'baseline', 'set_aside', 'removed')),
  title text,
  -- body: blobs.hash; drawing: sha256 of the whole value (blobs, or ink_manifests of this note); NULL for a removed drawing.
  content_hash text,
  -- the time the minting node recorded, UTC microseconds `YYYY-MM-DDTHH:MM:SS.ffffffZ` (spine/importedHistory.ts IMPORTED_AT).
  at text NOT NULL,
  clock_wall bigint,
  clock_counter integer,
  -- the order inside one instant: s: its place among the transaction's writes of this unit; g: the event's rank by (created_at, id) (§4.4 point 3).
  ordinal integer NOT NULL,
  -- this node's record, not the identity (§2.5): the node that minted or first received it.
  recorded_by text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('person', 'ai', 'automatic', 'session', 'merge')),
  author_id uuid,
  restored_from text,
  source_name text,
  PRIMARY KEY (note_id, unit, version_key),
  CHECK (content_hash IS NOT NULL OR kind = 'removed')
);
CREATE INDEX IF NOT EXISTS note_versions_workspace_idx ON note_versions (workspace_id);
-- the cleanup asks "does any version name this content" (services/maintenance/prune.ts, services/purgedContent.ts deleteUnreferencedBlobs)
CREATE INDEX IF NOT EXISTS note_versions_content_idx ON note_versions (content_hash);

CREATE TABLE IF NOT EXISTS note_version_positions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id uuid NOT NULL,
  unit text NOT NULL,
  version_key text NOT NULL,
  origin text NOT NULL,
  seq bigint NOT NULL,
  PRIMARY KEY (note_id, unit, version_key, origin, seq),
  FOREIGN KEY (note_id, unit, version_key) REFERENCES note_versions (note_id, unit, version_key) ON DELETE CASCADE
);
-- a transaction's own versions (recordVersion's ordinal, the commit check) and, later, a bundle's range per origin
CREATE INDEX IF NOT EXISTS note_version_positions_at_idx ON note_version_positions (workspace_id, origin, seq);
-- one note's versions of one transaction (recordVersion's ordinal, the commit checks, the event map): found by note first, so a transaction
-- that writes thousands of notes looks up each in constant time instead of scanning all its own positions (review of PR #1938 round 1, point 4)
CREATE INDEX IF NOT EXISTS note_version_positions_note_idx ON note_version_positions (note_id, unit, origin, seq);

CREATE TABLE IF NOT EXISTS note_version_events (
  event_id bigint PRIMARY KEY REFERENCES domain_events(id) ON DELETE CASCADE,
  note_id uuid NOT NULL,
  unit text NOT NULL,
  version_key text NOT NULL,
  FOREIGN KEY (note_id, unit, version_key) REFERENCES note_versions (note_id, unit, version_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS note_version_events_version_idx ON note_version_events (note_id, unit, version_key);

-- This node's count of local root writes that changed a note's title or text, or a drawing, and minted no version (the commit check below).
-- Counted, not refused, in batch 1: existing tests write notes with raw SQL inside stamped root writes, and they stay as they are (PR
-- description); every production write path mints, and the tests assert the count stays 0 for them. Next to writes_without_mutate, the same
-- kind of visible exception (sync_clock is node-local); the server log names the note (a WARNING).
ALTER TABLE sync_clock ADD COLUMN IF NOT EXISTS version_misses bigint NOT NULL DEFAULT 0;

-- The one encoding of a field in a key (§4.4 point 9): `<UTF-8 bytes>:<text>`, a missing value `-`.
CREATE OR REPLACE FUNCTION note_version_field(p text) RETURNS text AS $$
  SELECT CASE WHEN p IS NULL THEN '-' ELSE octet_length(p)::text || ':' || p END;
$$ LANGUAGE sql IMMUTABLE;

-- The UTC microsecond text a version's `at` is (IMPORTED_AT).
CREATE OR REPLACE FUNCTION note_version_at(p timestamptz) RETURNS text AS $$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$ LANGUAGE sql IMMUTABLE;

-- g: a version this node recorded as an event (or carried in from a backup), from what it is: note, unit, kind, content, title, time.
CREATE OR REPLACE FUNCTION note_version_legacy_key(p_note uuid, p_unit text, p_kind text, p_hash text, p_title text, p_at text) RETURNS text AS $$
  SELECT 'g:' || encode(sha256(convert_to('onden version 1' || note_version_field(p_note::text) || note_version_field(p_unit) || note_version_field(p_kind)
    || note_version_field(p_hash) || note_version_field(p_title) || note_version_field(p_at), 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- b: the content a note or drawing holds that no version names (the root's baseline); not its time (§4.3: a restored copy of the root mints the same key).
CREATE OR REPLACE FUNCTION note_version_baseline_key(p_note uuid, p_unit text, p_hash text) RETURNS text AS $$
  SELECT 'b:' || encode(sha256(convert_to('onden baseline 1' || note_version_field(p_note::text) || note_version_field(p_unit) || note_version_field(p_hash), 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- Whether the commit check and the minting stand aside in this transaction for `p_ws` (one rule for both: §4.4 points 5, 6, 11).
--   'off'      the shell, a seed or a data migration said so (onden.no_versions);
--   'import'   a snapshot join or a merge is writing what it received (sync_import_active);
--   'bypass'   the transaction's stamp was made by a trigger for a write outside the roots (writes_without_mutate counts it), or there is none;
--   NULL       an ordinary local root write: its versions are checked.
CREATE OR REPLACE FUNCTION note_version_exempt(p_ws uuid) RETURNS text AS $$
DECLARE s jsonb;
BEGIN
  IF COALESCE(current_setting('onden.no_versions', true), '') = 'on' THEN RETURN 'off'; END IF;
  IF sync_import_active(p_ws) THEN RETURN 'import'; END IF;
  s := NULLIF(current_setting(sync_stamp_setting(p_ws), true), '')::jsonb;
  IF s IS NULL OR s ? 'bypass' THEN RETURN 'bypass'; END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- Notes that have a version list: notes and boards, not tags and not the system's own notes (Site Config). §4.4 point 6.
CREATE OR REPLACE FUNCTION note_version_in_scope(p_node_type text, p_source_type text) RETURNS boolean AS $$
  SELECT p_node_type IN ('content', 'canvas') AND p_source_type IS DISTINCT FROM 'system';
$$ LANGUAGE sql IMMUTABLE;

-- The version an event undo puts back (§4.4 point 4, the rule the backfill below applies to old undos): the last version of the unit that
-- this node's map records for an event before the undone one, when it holds `p_hash`; NULL otherwise. spine/noteVersions.ts versionBeforeEvent.
CREATE OR REPLACE FUNCTION note_version_before_event(p_note uuid, p_unit text, p_undone bigint, p_hash text) RETURNS text AS $$
  SELECT CASE WHEN b.content_hash IS NOT DISTINCT FROM p_hash THEN b.version_key END
    FROM (SELECT ve.version_key, v.content_hash FROM note_version_events ve
            JOIN domain_events pe ON pe.id = ve.event_id
            JOIN note_versions v ON v.note_id = ve.note_id AND v.unit = ve.unit AND v.version_key = ve.version_key
            JOIN domain_events undone ON undone.id = p_undone
           WHERE ve.note_id = p_note AND ve.unit = p_unit AND (pe.created_at, pe.id) < (undone.created_at, undone.id)
           ORDER BY pe.created_at DESC, pe.id DESC LIMIT 1) b;
$$ LANGUAGE sql STABLE;

-- A write that minted no version, counted (see sync_clock.version_misses).
CREATE OR REPLACE FUNCTION note_version_count_miss(p_ws uuid, p_unit text, p_note uuid) RETURNS void AS $$
BEGIN
  UPDATE sync_clock SET version_misses = version_misses + 1 WHERE workspace_id = p_ws;
  RAISE WARNING 'note_version_missing: a write changed % of note % without minting its version (spine/noteVersions.ts recordVersion)', p_unit, p_note;
END;
$$ LANGUAGE plpgsql;

-- At COMMIT (review round 2, point 1): a version this node minted (s:) or a root's baseline (b:) names content that is stored: a body in
-- blobs, a drawing in blobs or this note's ink_manifests. Refused otherwise: the transaction fails as a whole. A received version may come
-- before its content (batches 3-4), so a join or merge stands aside.
CREATE OR REPLACE FUNCTION note_version_check_content() RETURNS trigger AS $$
BEGIN
  IF note_version_exempt(NEW.workspace_id) = 'import' THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM blobs b WHERE b.hash = NEW.content_hash)
     OR (NEW.unit <> 'body' AND EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = NEW.note_id AND m.hash = NEW.content_hash)) THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'note_version_content_missing: a version names content that is not stored (spine/noteVersions.ts: store it first, then recordVersion)'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

-- At COMMIT: the note's title and text as they are now were minted as a version by this transaction, and that text is stored.
-- The text is compared with the stored blob, not hashed again.
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
                AND v.title IS NOT DISTINCT FROM n.title AND b.content = n.markdown) THEN RETURN NULL; END IF;
  PERFORM note_version_count_miss(NEW.workspace_id, 'body', NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- At COMMIT: a drawing this transaction changed has a version minted by it, of that unit, whose content is stored (a removal: a `removed`
-- version). The value itself is not hashed (a drawing is up to 30 MB): the version names the hash its writer computed.
CREATE OR REPLACE FUNCTION note_version_check_ink() RETURNS trigger AS $$
DECLARE s jsonb; r record; n record; gone boolean := TG_OP = 'DELETE';
BEGIN
  IF gone THEN r := OLD; ELSE r := NEW; END IF;
  IF note_version_exempt(r.workspace_id) IS NOT NULL THEN RETURN NULL; END IF;
  SELECT c.node_type, c.source_type INTO n FROM content_nodes c WHERE c.id = r.node_id;
  IF NOT FOUND OR NOT note_version_in_scope(n.node_type, n.source_type) THEN RETURN NULL; END IF;
  -- the drawing as it is at commit: written again later in the transaction, or removed after a write
  gone := NOT EXISTS (SELECT 1 FROM node_attributes a WHERE a.node_id = r.node_id AND a.key = r.key);
  s := current_setting(sync_stamp_setting(r.workspace_id), true)::jsonb;
  IF EXISTS (SELECT 1 FROM note_version_positions p
               JOIN note_versions v ON v.note_id = p.note_id AND v.unit = p.unit AND v.version_key = p.version_key
              WHERE p.workspace_id = r.workspace_id AND p.origin = s->>'origin' AND p.seq = (s->>'seq')::bigint
                AND p.note_id = r.node_id AND p.unit = r.key AND v.version_key LIKE 's:%'
                AND CASE WHEN gone THEN v.kind = 'removed'
                         ELSE v.kind <> 'removed' AND (EXISTS (SELECT 1 FROM blobs b WHERE b.hash = v.content_hash)
                                                      OR EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = r.node_id AND m.hash = v.content_hash)) END)
  THEN RETURN NULL; END IF;
  PERFORM note_version_count_miss(r.workspace_id, r.key, r.node_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- At COMMIT: a save event is mapped to the version it recorded (this node's own map, §4.4 point 4). A version of this transaction with the
-- event's content first (in ordinal order: two saves of one note in one transaction map to their own); else, a save that changed nothing,
-- the latest version with that content. A writer that mapped its event itself (spine/importedHistory.ts) is left alone.
CREATE OR REPLACE FUNCTION note_version_link_event() RETURNS trigger AS $$
DECLARE v_unit text; v_hash text; v_note uuid; s jsonb; v_key text;
BEGIN
  IF note_version_exempt(NEW.workspace_id) IN ('off', 'import') THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM note_version_events WHERE event_id = NEW.id) THEN RETURN NULL; END IF;
  IF NEW.target_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
  v_note := NEW.target_id::uuid;
  IF NEW.event_type IN ('ATTRIBUTE_SET', 'ATTRIBUTE_DELETED') THEN
    v_unit := NEW.payload->>'key';
    v_hash := CASE WHEN NEW.event_type = 'ATTRIBUTE_DELETED' THEN NULL ELSE NEW.payload->>'value_ref' END;
  ELSE
    v_unit := 'body';
    v_hash := COALESCE(NEW.body_hash, NEW.payload->>'body_hash');
  END IF;
  s := NULLIF(current_setting(sync_stamp_setting(NEW.workspace_id), true), '')::jsonb;
  SELECT v.version_key INTO v_key FROM note_version_positions p
    JOIN note_versions v ON v.note_id = p.note_id AND v.unit = p.unit AND v.version_key = p.version_key
   WHERE s IS NOT NULL AND p.workspace_id = NEW.workspace_id AND p.origin = s->>'origin' AND p.seq = (s->>'seq')::bigint
     AND p.note_id = v_note AND p.unit = v_unit AND v.content_hash IS NOT DISTINCT FROM v_hash AND v.kind <> 'set_aside'
     AND NOT EXISTS (SELECT 1 FROM note_version_events x WHERE x.note_id = v.note_id AND x.unit = v.unit AND x.version_key = v.version_key)
   ORDER BY v.ordinal LIMIT 1;
  IF v_key IS NULL THEN
    SELECT v.version_key INTO v_key FROM note_versions v
     WHERE v.note_id = v_note AND v.unit = v_unit AND v.content_hash IS NOT DISTINCT FROM v_hash AND v.kind <> 'set_aside'
     ORDER BY COALESCE(v.clock_wall, 0) DESC, v.at DESC, v.ordinal DESC LIMIT 1;
  END IF;
  IF v_key IS NOT NULL THEN
    INSERT INTO note_version_events (event_id, note_id, unit, version_key) VALUES (NEW.id, v_note, v_unit, v_key) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS content_nodes_have_version_insert ON content_nodes;
CREATE CONSTRAINT TRIGGER content_nodes_have_version_insert AFTER INSERT ON content_nodes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (note_version_in_scope(NEW.node_type, NEW.source_type))
  EXECUTE FUNCTION note_version_check_body();
DROP TRIGGER IF EXISTS content_nodes_have_version_update ON content_nodes;
CREATE CONSTRAINT TRIGGER content_nodes_have_version_update AFTER UPDATE OF title, markdown ON content_nodes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((OLD.title IS DISTINCT FROM NEW.title OR OLD.markdown IS DISTINCT FROM NEW.markdown) AND note_version_in_scope(NEW.node_type, NEW.source_type))
  EXECUTE FUNCTION note_version_check_body();
DROP TRIGGER IF EXISTS node_attributes_ink_have_version_insert ON node_attributes;
CREATE CONSTRAINT TRIGGER node_attributes_ink_have_version_insert AFTER INSERT ON node_attributes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.key IN ('ink_data', 'board_ink', 'note_ink'))
  EXECUTE FUNCTION note_version_check_ink();
-- a write that puts back the value it found (a merge that kept the stored drawing) changes nothing: compared as bytes, never hashed
DROP TRIGGER IF EXISTS node_attributes_ink_have_version_update ON node_attributes;
CREATE CONSTRAINT TRIGGER node_attributes_ink_have_version_update AFTER UPDATE OF value ON node_attributes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.key IN ('ink_data', 'board_ink', 'note_ink') AND OLD.value IS DISTINCT FROM NEW.value)
  EXECUTE FUNCTION note_version_check_ink();
DROP TRIGGER IF EXISTS node_attributes_ink_have_version_delete ON node_attributes;
CREATE CONSTRAINT TRIGGER node_attributes_ink_have_version_delete AFTER DELETE ON node_attributes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.key IN ('ink_data', 'board_ink', 'note_ink'))
  EXECUTE FUNCTION note_version_check_ink();
DROP TRIGGER IF EXISTS note_versions_content_stored ON note_versions;
CREATE CONSTRAINT TRIGGER note_versions_content_stored AFTER INSERT ON note_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.content_hash IS NOT NULL AND (NEW.version_key LIKE 's:%' OR NEW.version_key LIKE 'b:%'))
  EXECUTE FUNCTION note_version_check_content();
DROP TRIGGER IF EXISTS domain_events_link_version ON domain_events;
CREATE CONSTRAINT TRIGGER domain_events_link_version AFTER INSERT ON domain_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN ((NEW.event_type IN ('NODE_CREATED', 'NODE_UPDATED', 'NODE_RESTORED') AND NEW.payload ? 'body_hash')
     OR (NEW.event_type IN ('ATTRIBUTE_SET', 'ATTRIBUTE_DELETED') AND NEW.payload->>'key' IN ('ink_data', 'board_ink', 'note_ink')))
  EXECUTE FUNCTION note_version_link_event();

-- The old history of one workspace as versions (§8 steps 2-4; step 5, the trash groups, is batch 5's). Returns what it added. Called once per workspace below; safe to call again.
CREATE OR REPLACE FUNCTION note_versions_backfill(p_ws uuid) RETURNS TABLE (versions bigint, baselines bigint, set_aside bigint, s0 bigint) AS $$
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

  CREATE TEMP TABLE IF NOT EXISTS nv_candidates (event_id bigint, created_at timestamptz, note_id uuid, unit text, kind text, hash text, title text,
    keep boolean, stored boolean, author_kind text, author_id uuid, source_name text, restored_event text, event_restored text) ON COMMIT DROP;
  TRUNCATE nv_candidates;
  INSERT INTO nv_candidates
  WITH scoped AS (SELECT c.id FROM content_nodes c WHERE c.workspace_id = p_ws AND note_version_in_scope(c.node_type, c.source_type)),
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
  ANALYZE nv_candidates;

  -- 2. the saves as `g:` versions: kept and stored ones, ranked by (created_at, id); a key two saves share is one version, the earlier's.
  -- A repeat (not kept) belongs to the kept save before it: every save between the two repeats it, so they hold the same title and content.
  CREATE TEMP TABLE IF NOT EXISTS nv_ranked (event_id bigint, note_id uuid, unit text, kind text, hash text, title text, created_at timestamptz,
    keep boolean, stored boolean, author_kind text, author_id uuid, source_name text, ordinal bigint, grp bigint, key text,
    restored_event text, event_restored text) ON COMMIT DROP;
  TRUNCATE nv_ranked;
  INSERT INTO nv_ranked
  SELECT c.event_id, c.note_id, c.unit, c.kind, c.hash, c.title, c.created_at, c.keep, c.stored, c.author_kind, c.author_id, c.source_name,
         row_number() OVER w, count(*) FILTER (WHERE c.keep) OVER w,
         note_version_legacy_key(c.note_id, c.unit, c.kind, c.hash, c.title, note_version_at(c.created_at)), c.restored_event, c.event_restored
    FROM nv_candidates c WINDOW w AS (PARTITION BY c.note_id, c.unit ORDER BY c.created_at, c.event_id);
  ANALYZE nv_ranked; -- a temporary table has no statistics: without them the joins below are planned for one row
  WITH ins AS (
    INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, title, content_hash, at, ordinal, recorded_by, author_kind, author_id, source_name)
    SELECT DISTINCT ON (r.note_id, r.unit, r.key) p_ws, r.note_id, r.unit, r.key, r.kind, r.title, r.hash, note_version_at(r.created_at), r.ordinal, v_node,
           r.author_kind, r.author_id, r.source_name
      FROM nv_ranked r WHERE r.keep AND r.stored
     ORDER BY r.note_id, r.unit, r.key, r.ordinal
    ON CONFLICT DO NOTHING RETURNING 1)
  SELECT count(*) INTO v_versions FROM ins;

  -- every save event to the version it records: a kept one to its own, a repeat to its group's
  INSERT INTO note_version_events (event_id, note_id, unit, version_key)
  SELECT c.event_id, c.note_id, c.unit, k.key FROM nv_ranked c
    JOIN nv_ranked k ON k.note_id = c.note_id AND k.unit = c.unit AND k.grp = c.grp AND k.keep AND k.stored
  ON CONFLICT DO NOTHING;

  -- 4.4 point 4: "restored from", as the local write path gives it (services/nodeUpdate.ts restoreNodeVersion, eventRestore/restore.ts): only the
  -- save that minted a version decides it (a repeat mints nothing, so it names nothing), the earliest such save when two share a key, never the
  -- version itself; and only from (created_at, id) orders, so every copy of the database gives the same answer whatever the rows' physical order.
  -- A version restore names the restored event (payload.version_id); an event undo names the undone EVENT, so it restored the version before it,
  -- when the content matches.
  UPDATE note_versions v SET restored_from = t.target
    FROM (SELECT DISTINCT ON (r.note_id, r.unit, r.key) r.note_id, r.unit, r.key, m.version_key AS target
            FROM nv_ranked r
            JOIN note_version_events m ON r.restored_event ~ '^\d{1,18}$' AND m.event_id = r.restored_event::bigint AND m.note_id = r.note_id AND m.unit = r.unit
           WHERE r.keep AND r.stored
           ORDER BY r.note_id, r.unit, r.key, r.ordinal) t
   WHERE v.note_id = t.note_id AND v.unit = t.unit AND v.version_key = t.key AND v.restored_from IS NULL AND v.version_key LIKE 'g:%' AND t.target <> t.key;
  UPDATE note_versions v SET restored_from = t.target
    FROM (SELECT DISTINCT ON (r.note_id, r.unit, r.key) r.note_id, r.unit, r.key, before.version_key AS target, before.content_hash AS target_hash
            FROM nv_ranked r
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
      FROM domain_events e JOIN content_nodes n ON n.id::text = e.target_id AND n.workspace_id = p_ws AND note_version_in_scope(n.node_type, n.source_type)
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
      FROM content_nodes c WHERE c.workspace_id = p_ws AND note_version_in_scope(c.node_type, c.source_type) AND c.markdown <> ''
       AND NOT EXISTS (SELECT 1 FROM note_versions v WHERE v.note_id = c.id AND v.unit = 'body' AND v.content_hash = encode(sha256(convert_to(c.markdown, 'UTF8')), 'hex'))
    ON CONFLICT (hash) DO NOTHING;
    WITH ins AS (
      INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, title, content_hash, at, ordinal, recorded_by, author_kind)
      SELECT p_ws, c.id, 'body', note_version_baseline_key(c.id, 'body', h.hash), 'baseline', c.title, h.hash, note_version_at(c.updated_at), 0, v_node, 'automatic'
        FROM content_nodes c CROSS JOIN LATERAL (SELECT encode(sha256(convert_to(c.markdown, 'UTF8')), 'hex') AS hash) h
       WHERE c.workspace_id = p_ws AND note_version_in_scope(c.node_type, c.source_type) AND c.markdown <> ''
         AND NOT EXISTS (SELECT 1 FROM note_versions v WHERE v.note_id = c.id AND v.unit = 'body' AND v.content_hash = h.hash)
      ON CONFLICT DO NOTHING RETURNING 1)
    SELECT count(*) INTO n FROM ins;
    v_baselines := n;
    -- the one-time hashing of each drawing that has no version (a drawing saved before 172 without an event, for example)
    CREATE TEMP TABLE IF NOT EXISTS nv_ink_base (node_id uuid, key text, hash text, updated_at timestamptz) ON COMMIT DROP;
    TRUNCATE nv_ink_base;
    INSERT INTO nv_ink_base
    SELECT a.node_id, a.key, encode(sha256(convert_to(a.value, 'UTF8')), 'hex'), a.updated_at
      FROM node_attributes a JOIN content_nodes c ON c.id = a.node_id AND note_version_in_scope(c.node_type, c.source_type)
     WHERE a.workspace_id = p_ws AND a.key IN ('ink_data', 'board_ink', 'note_ink') AND a.value <> '';
    DELETE FROM nv_ink_base i WHERE EXISTS (SELECT 1 FROM note_versions v WHERE v.note_id = i.node_id AND v.unit = i.key AND v.content_hash = i.hash);
    INSERT INTO blobs (hash, content, size_bytes)
    SELECT i.hash, a.value, octet_length(a.value) FROM nv_ink_base i JOIN node_attributes a ON a.node_id = i.node_id AND a.key = i.key
     WHERE NOT EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = i.node_id AND m.hash = i.hash)
    ON CONFLICT (hash) DO NOTHING;
    WITH ins AS (
      INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, content_hash, at, ordinal, recorded_by, author_kind)
      SELECT p_ws, i.node_id, i.key, note_version_baseline_key(i.node_id, i.key, i.hash), 'baseline', i.hash, note_version_at(i.updated_at), 0, v_node, 'automatic'
        FROM nv_ink_base i ON CONFLICT DO NOTHING RETURNING 1)
    SELECT count(*) INTO n FROM ins;
    v_baselines := v_baselines + n;
  END IF;

  -- 3. one real sequence number for what this pass wrote, only when it wrote something that has no position yet (a second run takes none)
  IF EXISTS (SELECT 1 FROM note_versions v WHERE v.workspace_id = p_ws AND v.version_key NOT LIKE 's:%'
               AND NOT EXISTS (SELECT 1 FROM note_version_positions p WHERE p.note_id = v.note_id AND p.unit = v.unit AND p.version_key = v.version_key)) THEN
    SELECT c.next_seq INTO v_s0 FROM sync_lock_clock(p_ws) c;
    UPDATE sync_clock SET next_seq = v_s0 + 1 WHERE workspace_id = p_ws;
    INSERT INTO note_version_positions (workspace_id, note_id, unit, version_key, origin, seq)
    SELECT p_ws, v.note_id, v.unit, v.version_key, v_node, v_s0 FROM note_versions v
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
    PERFORM note_versions_backfill(w.id);
  END LOOP;
END $$;
