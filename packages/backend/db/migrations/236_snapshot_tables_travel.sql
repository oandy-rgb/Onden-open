-- 236: six tables a snapshot carried with genesis stamps only now get write stamps and travel by change bundle (own-node transport, batch 5; proposal
-- docs/architecture/proposals/own-node-transport-2026-11-22.md §2.11 and §4.3 N2). Before, a row written on any node after a join never reached another
-- (no trigger, and genesis stamps never leave: spine/stampedBundle.ts), so two nodes differed in silence, table by table (§4.2 item 15).
--
-- EACH TABLE: its units, its key, what two nodes that both wrote do (the merge core: the later write wins, the other stays a head a person sees), its natural keys
-- and its received check are in spine/stampedMerge/dbUnits.ts UNIT_SOURCES; the tests are test/snapshotTablesTravel.integration.test.ts.
--   ai_edit_suggestions        key id; only the row (`*`): a suggestion does not change once made. The snapshot carried only those still waiting; now every one (a
--                              decision must reach the node that holds the suggestion), and still not the AI session or the event that made it (this node's own).
--   ai_edit_suggestion_items   key id; two units per item: `decision` = the status a write gave it, who and when (written_*), and `accepted` = when and by whom it
--                              was accepted, written once. The shown status is `accepted` whenever an acceptance is there (the owner's decision of 2026-11-23: an
--                              accepted suggestion is in the note, so no later rejection made elsewhere turns it back). Gets workspace_id (from its suggestion).
--   actor_prefs                key (person, key); one unit per key: the value with its forward order, edit time and the time it was stored (services/actorPrefs.ts
--                              writes them together; carried, so the row is the same on every node). Gets workspace_id (from the person).
--   review_states              key id: a new column, derived from (card, person) (onden_uuid5 of migration 201, name `review-state/<card>/<person>`), so two nodes
--                              that each grade a card first make one row. One unit, `progress` = the state, the step before it and when: a review is one write,
--                              and merging the parts would make a schedule nobody had.
--   focus_sessions             key id; one unit, `session` = task, start, end, sentence and when it was last changed (a record is one thing; its task is
--                              emptied when the task goes).
--                              Two records of one person both running (made on two nodes): both stay (decision 4.4, rules/focus.ts); the unique index that
--                              allowed one is replaced by the same check on local writes only (focus_sessions_one_running), so the write path refuses a
--                              second as before and a merge can keep the other node's.
--   block_link_bindings        key (note, link text); the row and `anchor`: a binding is a person's confirmation (services/blockLinks.ts), replicated, never
--                              worked out (anchors proposal 5.3 question 4, answered with the owner's decision 10 of the transport proposal, 2026-11-22).
-- Not here: rss_seen (its rows hang on an article each node fetches for itself, rss_staging, derived: a mark that arrives before its article is not made, and
-- nothing makes it when the article comes; a later batch) and actors (migration 237: written only on the centre).
--
-- WHAT A SINGLE SERVER SEES: nothing changes in what it shows or refuses. It writes stamps for these rows from now on (as for every stamped table), the three
-- new workspace_id columns and the review id are filled once from what the rows already say, and the second running focus record is refused by a trigger
-- under the workspace event lock instead of the index (the write path asks first and answers 409 focus_running either way). Existing rows get genesis stamps
-- (sync_genesis_pass, the same constants on every node), so a node that joined from a snapshot holds the same stamps without an exchange.
--
-- Rolling back: restore the pre-upgrade backup (migrations only go forward). In place: DROP the triggers and functions this file adds, the columns
-- actor_prefs.workspace_id, ai_edit_suggestion_items.workspace_id and review_states.id, run migration 215's sync_stamp_may_keep_value again, CREATE UNIQUE INDEX
-- focus_sessions_one_running_uq ON focus_sessions (actor_id) WHERE ended_at IS NULL (fails if a merge left two running: end one first), and DELETE FROM
-- sync_stamps WHERE table_name IN (the six labels); nothing else reads them.
-- drill: no allowance needed. This migration writes no title or body: three id columns of three tables, the written copies of each suggestion item's decision, and
-- genesis stamps.
--
-- Read-only preview for the production database (SELECT only; works with default_transaction_read_only = on; counts only):
--
--   SELECT 'ai_edit_suggestions rows that get a genesis stamp' AS part, count(*)::bigint AS n FROM ai_edit_suggestions
--   UNION ALL SELECT 'ai_edit_suggestion_items rows that get workspace_id, the copy of their decision and a genesis stamp', count(*) FROM ai_edit_suggestion_items
--   UNION ALL SELECT '... of which accepted (they get their acceptance; what every reader shows does not change)', count(*) FROM ai_edit_suggestion_items WHERE status = 'accepted'
--   UNION ALL SELECT 'actor_prefs rows that get workspace_id and a genesis stamp', count(*) FROM actor_prefs
--   UNION ALL SELECT 'actor_prefs rows whose person is not there (expected 0: the foreign key cascades)', count(*) FROM actor_prefs p WHERE NOT EXISTS (SELECT 1 FROM actors a WHERE a.id = p.actor_id)
--   UNION ALL SELECT 'review_states rows that get an id and a genesis stamp', count(*) FROM review_states
--   UNION ALL SELECT 'focus_sessions rows that get a genesis stamp', count(*) FROM focus_sessions
--   UNION ALL SELECT 'people with more than one running focus record (expected 0: the index allowed one)', count(*) FROM (SELECT actor_id FROM focus_sessions WHERE ended_at IS NULL GROUP BY actor_id HAVING count(*) > 1) x
--   UNION ALL SELECT 'block_link_bindings rows that get a genesis stamp', count(*) FROM block_link_bindings
--   UNION ALL SELECT 'notes whose slug or text this migration changes (must be 0)', 0
--   ;

-- 1. the columns a stamp files a row under, and the review id --------------------------------------------------------------------------------------------
ALTER TABLE ai_edit_suggestion_items ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
UPDATE ai_edit_suggestion_items i SET workspace_id = s.workspace_id FROM ai_edit_suggestions s WHERE s.id = i.suggestion_id AND i.workspace_id IS NULL;
ALTER TABLE ai_edit_suggestion_items ALTER COLUMN workspace_id SET NOT NULL;
CREATE OR REPLACE FUNCTION ai_edit_suggestion_items_workspace() RETURNS trigger AS $$
BEGIN
  IF NEW.workspace_id IS NULL THEN SELECT s.workspace_id INTO NEW.workspace_id FROM ai_edit_suggestions s WHERE s.id = NEW.suggestion_id; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER ai_edit_suggestion_items_workspace BEFORE INSERT ON ai_edit_suggestion_items FOR EACH ROW EXECUTE FUNCTION ai_edit_suggestion_items_workspace();

-- An accepted suggestion stays accepted (the owner's decision of 2026-11-23, PR #1992): its text is in the note, so the state says so, whatever another node decided
-- without seeing the acceptance. The decision a write made is the unit `decision` (written_status, written_decided_by, written_decided_at); the acceptance is a unit of its
-- own, `accepted` (accepted, accepted_at, accepted_by), written once, by the write that accepts; what every reader uses (status, decided_by, decided_at) is the acceptance when there
-- is one, else the written decision (ai_edit_suggestion_items_settle; a node that takes a bundle settles the items it bears on, stampedMerge/dbUnits.ts `expand`). On
-- the node that writes, the shown columns are what the write path wrote and the written ones copy them (ai_edit_suggestion_items_written), so a single server sees no
-- change. The written ids are ids as a stamp keeps them (no foreign key: the shown decided_by keeps it and is emptied when its actor goes).
ALTER TABLE ai_edit_suggestion_items ADD COLUMN IF NOT EXISTS written_status text;
ALTER TABLE ai_edit_suggestion_items ADD COLUMN IF NOT EXISTS written_decided_by uuid;
ALTER TABLE ai_edit_suggestion_items ADD COLUMN IF NOT EXISTS written_decided_at timestamptz;
ALTER TABLE ai_edit_suggestion_items ADD COLUMN IF NOT EXISTS accepted boolean NOT NULL DEFAULT false;
ALTER TABLE ai_edit_suggestion_items ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE ai_edit_suggestion_items ADD COLUMN IF NOT EXISTS accepted_by uuid;
UPDATE ai_edit_suggestion_items SET written_status = status, written_decided_by = decided_by, written_decided_at = decided_at,
       accepted = (status = 'accepted'), accepted_at = CASE WHEN status = 'accepted' THEN decided_at END, accepted_by = CASE WHEN status = 'accepted' THEN decided_by END
 WHERE written_status IS NULL;
ALTER TABLE ai_edit_suggestion_items ALTER COLUMN written_status SET NOT NULL;
ALTER TABLE ai_edit_suggestion_items DROP CONSTRAINT IF EXISTS ai_edit_suggestion_items_written_status_check;
ALTER TABLE ai_edit_suggestion_items ADD CONSTRAINT ai_edit_suggestion_items_written_status_check
  CHECK (written_status IN ('pending', 'accepted', 'rejected', 'stale', 'void', 'replaced'));
CREATE OR REPLACE FUNCTION ai_edit_suggestion_items_written() RETURNS trigger AS $$
BEGIN
  IF sync_import_active(NEW.workspace_id) OR current_setting('onden.decision_settle', true) = 'on' THEN RETURN NEW; END IF;
  NEW.written_status := NEW.status; NEW.written_decided_by := NEW.decided_by; NEW.written_decided_at := NEW.decided_at;
  IF NEW.status = 'accepted' AND NOT NEW.accepted THEN NEW.accepted := true; NEW.accepted_at := NEW.decided_at; NEW.accepted_by := NEW.decided_by; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER ai_edit_suggestion_items_written BEFORE INSERT OR UPDATE OF status, decided_by, decided_at ON ai_edit_suggestion_items FOR EACH ROW
  EXECUTE FUNCTION ai_edit_suggestion_items_written();
-- the shown decision of the items given, from their units: accepted when an acceptance is there, else the written decision (an id of an actor not here is shown as none)
CREATE OR REPLACE FUNCTION ai_edit_suggestion_items_settle(p_ws uuid, p_ids uuid[]) RETURNS void AS $$
BEGIN
  PERFORM set_config('onden.decision_settle', 'on', true);
  UPDATE ai_edit_suggestion_items i SET status = v.status, decided_by = v.by, decided_at = v.at
    FROM (SELECT x.id,
                 CASE WHEN x.accepted THEN 'accepted' ELSE x.written_status END AS status,
                 (SELECT a.id FROM actors a WHERE a.id = CASE WHEN x.accepted THEN x.accepted_by ELSE x.written_decided_by END) AS by,
                 CASE WHEN x.accepted THEN x.accepted_at ELSE x.written_decided_at END AS at
            FROM ai_edit_suggestion_items x WHERE x.workspace_id = p_ws AND x.id = ANY(p_ids)) v
   WHERE i.id = v.id AND (i.status, i.decided_by, i.decided_at) IS DISTINCT FROM (v.status, v.by, v.at);
  PERFORM set_config('onden.decision_settle', '', true);
END;
$$ LANGUAGE plpgsql;

ALTER TABLE actor_prefs ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
UPDATE actor_prefs p SET workspace_id = a.workspace_id FROM actors a WHERE a.id = p.actor_id AND p.workspace_id IS NULL;
ALTER TABLE actor_prefs ALTER COLUMN workspace_id SET NOT NULL;
CREATE OR REPLACE FUNCTION actor_prefs_workspace() RETURNS trigger AS $$
BEGIN
  IF NEW.workspace_id IS NULL THEN SELECT a.workspace_id INTO NEW.workspace_id FROM actors a WHERE a.id = NEW.actor_id; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER actor_prefs_workspace BEFORE INSERT ON actor_prefs FOR EACH ROW EXECUTE FUNCTION actor_prefs_workspace();

-- the id of a person's progress on a card: the same on every node that makes it (namespace and name: packages/markdown sharedContract.ts DERIVED_ID_NAMESPACE)
CREATE OR REPLACE FUNCTION review_state_id(p_card uuid, p_actor text) RETURNS uuid AS $$
  SELECT onden_uuid5('c3a1f0d2-7b64-4e19-8d35-5a0e9b2f6c47'::uuid, 'review-state/' || p_card::text || '/' || p_actor);
$$ LANGUAGE sql IMMUTABLE;
ALTER TABLE review_states ADD COLUMN IF NOT EXISTS id uuid;
UPDATE review_states SET id = review_state_id(COALESCE(node_id, block_id), actor_id) WHERE id IS NULL;
ALTER TABLE review_states ALTER COLUMN id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_states_pkey' AND conrelid = 'review_states'::regclass) THEN
    ALTER TABLE review_states ADD CONSTRAINT review_states_pkey PRIMARY KEY (id);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION review_states_id() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS NULL THEN NEW.id := review_state_id(COALESCE(NEW.node_id, NEW.block_id), NEW.actor_id); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER review_states_id BEFORE INSERT ON review_states FOR EACH ROW EXECUTE FUNCTION review_states_id();

-- 2. one running focus record per person, on the write path only ---------------------------------------------------------------------------------------
DROP INDEX IF EXISTS focus_sessions_one_running_uq;
CREATE INDEX IF NOT EXISTS focus_sessions_running_idx ON focus_sessions (actor_id) WHERE ended_at IS NULL;
-- the write path (modules/tasks/focus.ts) asks first under the workspace event lock and answers 409 focus_running; this is the line behind it, as the index was
-- (the same SQLSTATE). A merge keeps what the other node made (decision 4.4: both stay; rules/focus.ts shows the earlier one ended when the next began).
CREATE OR REPLACE FUNCTION focus_sessions_one_running() RETURNS trigger AS $$
BEGIN
  IF sync_import_active(NEW.workspace_id) THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM focus_sessions f WHERE f.actor_id = NEW.actor_id AND f.ended_at IS NULL AND f.id <> NEW.id) THEN
    RAISE EXCEPTION 'a person has one running focus record' USING ERRCODE = 'unique_violation', CONSTRAINT = 'focus_sessions_one_running';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER focus_sessions_one_running BEFORE INSERT OR UPDATE OF ended_at, actor_id ON focus_sessions FOR EACH ROW
  WHEN (NEW.ended_at IS NULL) EXECUTE FUNCTION focus_sessions_one_running();

-- 3. where a stamp may keep the id a foreign key emptied (215): the two new units that hold one --------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_stamp_may_keep_value(p_label text, p_field text) RETURNS boolean AS $$
  SELECT p_label IN ('block_anchors', 'block_nodes', 'note_anchor_places')
      OR (p_label, p_field) IN (('content_nodes', 'parent'), ('spaces', 'owner'), ('rss_subscriptions', 'auto_tag'), ('rss_subscriptions', 'default_parent'),
                                ('focus_sessions', 'session'));
$$ LANGUAGE sql IMMUTABLE;

-- 4. the stamp triggers ---------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE TRIGGER ai_edit_suggestions_sync_stamp_insert AFTER INSERT ON ai_edit_suggestions FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('ai_edit_suggestions', 'id', 'workspace_id', '', '');
CREATE OR REPLACE TRIGGER ai_edit_suggestions_sync_stamp_delete AFTER DELETE ON ai_edit_suggestions FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('ai_edit_suggestions', 'id', 'workspace_id', '', '');

CREATE OR REPLACE TRIGGER ai_edit_suggestion_items_sync_stamp_insert AFTER INSERT ON ai_edit_suggestion_items FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('ai_edit_suggestion_items', 'id', 'workspace_id', 'decision=written_status+written_decided_by+written_decided_at,accepted=accepted+accepted_at+accepted_by', '');
CREATE OR REPLACE TRIGGER ai_edit_suggestion_items_sync_stamp_update AFTER UPDATE ON ai_edit_suggestion_items FOR EACH ROW
  WHEN (OLD.written_status IS DISTINCT FROM NEW.written_status OR OLD.written_decided_by IS DISTINCT FROM NEW.written_decided_by OR OLD.written_decided_at IS DISTINCT FROM NEW.written_decided_at
     OR OLD.accepted IS DISTINCT FROM NEW.accepted OR OLD.accepted_at IS DISTINCT FROM NEW.accepted_at OR OLD.accepted_by IS DISTINCT FROM NEW.accepted_by)
  EXECUTE FUNCTION sync_stamp_trigger('ai_edit_suggestion_items', 'id', 'workspace_id', 'decision=written_status+written_decided_by+written_decided_at,accepted=accepted+accepted_at+accepted_by', '');
CREATE OR REPLACE TRIGGER ai_edit_suggestion_items_sync_stamp_delete AFTER DELETE ON ai_edit_suggestion_items FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('ai_edit_suggestion_items', 'id', 'workspace_id', 'decision=written_status+written_decided_by+written_decided_at,accepted=accepted+accepted_at+accepted_by', '');

CREATE OR REPLACE TRIGGER actor_prefs_sync_stamp_insert AFTER INSERT ON actor_prefs FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('actor_prefs', 'actor_id,key', 'workspace_id', 'value=value+order_key+edited_at+updated_at', '');
CREATE OR REPLACE TRIGGER actor_prefs_sync_stamp_update AFTER UPDATE ON actor_prefs FOR EACH ROW
  WHEN (OLD.value IS DISTINCT FROM NEW.value OR OLD.order_key IS DISTINCT FROM NEW.order_key OR OLD.edited_at IS DISTINCT FROM NEW.edited_at OR OLD.updated_at IS DISTINCT FROM NEW.updated_at)
  EXECUTE FUNCTION sync_stamp_trigger('actor_prefs', 'actor_id,key', 'workspace_id', 'value=value+order_key+edited_at+updated_at', '');
CREATE OR REPLACE TRIGGER actor_prefs_sync_stamp_delete AFTER DELETE ON actor_prefs FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('actor_prefs', 'actor_id,key', 'workspace_id', 'value=value+order_key+edited_at+updated_at', '');

CREATE OR REPLACE TRIGGER review_states_sync_stamp_insert AFTER INSERT ON review_states FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('review_states', 'id', 'workspace_id', 'progress=state+previous_state+updated_at', '');
CREATE OR REPLACE TRIGGER review_states_sync_stamp_update AFTER UPDATE ON review_states FOR EACH ROW
  WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.previous_state IS DISTINCT FROM NEW.previous_state OR OLD.updated_at IS DISTINCT FROM NEW.updated_at)
  EXECUTE FUNCTION sync_stamp_trigger('review_states', 'id', 'workspace_id', 'progress=state+previous_state+updated_at', '');
CREATE OR REPLACE TRIGGER review_states_sync_stamp_delete AFTER DELETE ON review_states FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('review_states', 'id', 'workspace_id', 'progress=state+previous_state+updated_at', '');

CREATE OR REPLACE TRIGGER focus_sessions_sync_stamp_insert AFTER INSERT ON focus_sessions FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('focus_sessions', 'id', 'workspace_id', 'session=task_id+started_at+ended_at+note+updated_at', '');
CREATE OR REPLACE TRIGGER focus_sessions_sync_stamp_update AFTER UPDATE ON focus_sessions FOR EACH ROW
  WHEN (OLD.task_id IS DISTINCT FROM NEW.task_id OR OLD.started_at IS DISTINCT FROM NEW.started_at OR OLD.ended_at IS DISTINCT FROM NEW.ended_at OR OLD.note IS DISTINCT FROM NEW.note
     OR OLD.updated_at IS DISTINCT FROM NEW.updated_at)
  EXECUTE FUNCTION sync_stamp_trigger('focus_sessions', 'id', 'workspace_id', 'session=task_id+started_at+ended_at+note+updated_at', '');
CREATE OR REPLACE TRIGGER focus_sessions_sync_stamp_delete AFTER DELETE ON focus_sessions FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('focus_sessions', 'id', 'workspace_id', 'session=task_id+started_at+ended_at+note+updated_at', '');
CREATE OR REPLACE TRIGGER focus_sessions_keep_emptied_id AFTER UPDATE OF task_id ON focus_sessions FOR EACH ROW
  WHEN (OLD.task_id IS NOT NULL AND NEW.task_id IS NULL)
  EXECUTE FUNCTION sync_keep_emptied_id('focus_sessions', 'id', 'workspace_id', '', 'session:task_id:task_id+started_at+ended_at+note+updated_at:content_nodes:id');

CREATE OR REPLACE TRIGGER block_link_bindings_sync_stamp_insert AFTER INSERT ON block_link_bindings FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('block_link_bindings', 'note_id,link_text', 'workspace_id', 'anchor=anchor_id', '');
CREATE OR REPLACE TRIGGER block_link_bindings_sync_stamp_update AFTER UPDATE ON block_link_bindings FOR EACH ROW
  WHEN (OLD.anchor_id IS DISTINCT FROM NEW.anchor_id)
  EXECUTE FUNCTION sync_stamp_trigger('block_link_bindings', 'note_id,link_text', 'workspace_id', 'anchor=anchor_id', '');
CREATE OR REPLACE TRIGGER block_link_bindings_sync_stamp_delete AFTER DELETE ON block_link_bindings FOR EACH ROW
  EXECUTE FUNCTION sync_stamp_trigger('block_link_bindings', 'note_id,link_text', 'workspace_id', 'anchor=anchor_id', '');

-- 5. the rows already there: genesis stamps, the same on every node (migration 202's pass reads the triggers above)
SELECT * FROM sync_genesis_pass();
