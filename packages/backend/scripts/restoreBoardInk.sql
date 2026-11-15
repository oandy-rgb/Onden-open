-- Undo migration 172 (docs/architecture/ink-attributes.md): put the whiteboard pen
-- layers it moved back under `ink_data`, and remove the copies it made.
--
--   psql "$DATABASE_URL" -1 -f packages/backend/scripts/restoreBoardInk.sql
--
-- Only rows of board_ink_moves with restored_at IS NULL are touched.
--   * 'moved': the `board_ink` row is renamed back to `ink_data` — with the strokes
--     drawn on the board since — unless the note has an `ink_data` row again (an app
--     from before 172 wrote one); then nothing changes and the id is listed below.
--   * 'copied': the `board_ink` copy is deleted while its value is still the one
--     copied (same SHA-256). A board drawn on since keeps its `board_ink` (listed below).
--     The `ink_data` the migration left alone is never touched.
-- updated_at of notes and attributes and domain_events are not touched. Run it with
-- the app stopped, or after deploying a backend from before 172.
-- Prints the ids it restored (kept_node_id: the ones it left, and why).

WITH todo AS (
  SELECT m.node_id, m.action, m.value_hash, m.board_ink_attribute_id
    FROM board_ink_moves m
   WHERE m.restored_at IS NULL
     FOR UPDATE OF m
), moved_back AS (
  UPDATE node_attributes a SET key = 'ink_data'
    FROM todo t
   WHERE t.action = 'moved' AND a.id = t.board_ink_attribute_id AND a.key = 'board_ink'
     AND NOT EXISTS (SELECT 1 FROM node_attributes o WHERE o.node_id = a.node_id AND o.key = 'ink_data')
  RETURNING a.node_id
), copy_removed AS (
  DELETE FROM node_attributes a
   USING todo t
   WHERE t.action = 'copied' AND a.id = t.board_ink_attribute_id AND a.key = 'board_ink'
     AND encode(sha256(convert_to(a.value, 'UTF8')), 'hex') = t.value_hash
  RETURNING a.node_id
), done AS (
  UPDATE board_ink_moves m SET restored_at = now()
   WHERE m.node_id IN (SELECT node_id FROM moved_back UNION SELECT node_id FROM copy_removed)
  RETURNING m.node_id
)
SELECT t.node_id AS restored_node_id, NULL::text AS kept_reason FROM todo t WHERE t.node_id IN (SELECT node_id FROM done)
UNION ALL
SELECT t.node_id, CASE WHEN t.action = 'moved' THEN 'ink_data exists again' ELSE 'board drawn on since' END
  FROM todo t WHERE t.node_id NOT IN (SELECT node_id FROM done);
