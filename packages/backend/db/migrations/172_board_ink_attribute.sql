-- 172: the whiteboard's pen layer gets its own attribute, `board_ink`.
--
-- Since migration 138 a whiteboard is a view of a note, and its pen layer was saved
-- in the note's `ink_data` attribute — the same attribute that makes the note's
-- "content" tab a handwriting page (a PDF's envelope lives there too). So drawing
-- on a note's whiteboard turned its content into a handwriting page, and strokes
-- drawn on a handwriting page showed up on the whiteboard. From now on the app
-- saves the board's layer in `board_ink` (same single-page format, same codec,
-- same merging write) and `ink_data` is only a handwriting page or a PDF.
--
-- This migration moves the strokes that belong to a whiteboard. Per note that has
-- an `ink_data` that is a single page (a PDF envelope is skipped; so is a note with
-- a `pdf_url`, an unreadable value, a page without strokes, and a note that already
-- has a `board_ink` or a row in board_ink_moves — which is why a second run does
-- nothing):
--
--   1. CERTAIN — the note is in canvas_note_conversions (it was a board when
--      migration 138 ran): its `ink_data` row is renamed to `board_ink` (same row,
--      same id, same value, same updated_at). Its content tab goes back to text.
--      board_ink_moves records action 'moved'.
--   2. OFF THE PAGE — the note has a whiteboard tab (collection_views holds a layout
--      "canvas"), is not in 1, and a stroke point lies left of 0, above 0 or right of
--      the page width. A handwriting page cannot hold such a point; only the
--      unbounded board can. Moved like 1 (renamed in place), action 'moved',
--      reason 'outside_page'. (Production 2026-11-02: four notes, all of them
--      boards; the owner confirmed.)
--   2b. AMBIGUOUS — the note has a whiteboard tab, is not in 1 or 2, so every point
--      lies on the page. Nothing can tell for sure whether its page is a
--      handwriting page or a board layer (both were saved by the same call), so
--      the page is COPIED to a new `board_ink` row and `ink_data` is left alone.
--      board_ink_moves records action 'copied' with the evidence in `signals` and
--      what it points to in `suggested`:
--        has_text           the note has Markdown text (a handwriting page has none)
--        outside_page       a stroke point lies left of 0, right of the page width
--                           or above 0 (a board is unbounded; a page is not)
--        born_handwriting   the first ink_data write came with the note's creation
--                           (NODE_CREATED is its cause: "new handwritten note",
--                           an imported drawing) or was an empty page (a note turned
--                           into a handwriting page)
--        no_events          no ink_data write is in domain_events
--      (outside_page never reaches 2b: it is case 2.)
--      suggested = 'board' when has_text and not born_handwriting;
--                  'handwriting' when born_handwriting and not has_text;
--                  otherwise 'unknown'. A person decides later (below).
--   3. Every other `ink_data` stays: a note without a whiteboard tab is a handwriting
--      page or a PDF. Pages with no strokes are not copied (nothing to lose).
--
-- Not touched: updated_at of any note (and of any attribute row), domain_events,
-- blobs, tags, links, cards, views. The ink history of a moved board stays under
-- the key `ink_data` in the event log (its old saves still read as they were saved).
--
-- Deciding an ambiguous note afterwards (then set decision/decided_at on its row):
--   it is a board:        DELETE FROM node_attributes WHERE node_id = :id AND key = 'ink_data';
--   it is a handwriting:  DELETE FROM node_attributes WHERE node_id = :id AND key = 'board_ink';
--
-- Undo — packages/backend/scripts/restoreBoardInk.sql (psql -1): a 'moved' row goes
-- back to `ink_data` (with the strokes drawn on the board since) unless the note has
-- an `ink_data` again; a 'copied' row's `board_ink` is deleted if it is still the
-- copy made here (a board drawn on since keeps its strokes: reported, not deleted).
--
-- The restore drill compares: ink_pages_notes stays equal (no note lost its drawing),
-- ink_bytes does not go down; the number of ink_data / board_ink rows changes on
-- purpose.
-- drill: allows ink_data_rows, board_ink_rows, attributes
-- Idempotent: see above.

CREATE TABLE IF NOT EXISTS board_ink_moves (
  node_id                uuid PRIMARY KEY REFERENCES content_nodes(id) ON DELETE CASCADE,
  workspace_id           uuid NOT NULL,
  action                 text NOT NULL CHECK (action IN ('moved', 'copied')),
  -- 'canvas_note_conversion' (certain), 'outside_page' (strokes off the page: a board) or 'ambiguous'.
  reason                 text NOT NULL CHECK (reason IN ('canvas_note_conversion', 'outside_page', 'ambiguous')),
  -- What the evidence points to: 'board', 'handwriting' or 'unknown'.
  suggested              text NOT NULL CHECK (suggested IN ('board', 'handwriting', 'unknown')),
  signals                jsonb NOT NULL,
  -- The node_attributes row now holding `board_ink`: the renamed row ('moved') or the new copy ('copied').
  board_ink_attribute_id uuid NOT NULL,
  -- SHA-256 (hex) of the value at migration time: the copy is deleted on undo only while it still has this value.
  value_hash             text NOT NULL,
  moved_at               timestamptz NOT NULL DEFAULT now(),
  -- A person's decision for an ambiguous note ('board' | 'handwriting'); NULL while undecided.
  decision               text CHECK (decision IN ('board', 'handwriting')),
  decided_at             timestamptz,
  restored_at            timestamptz
);
COMMENT ON TABLE board_ink_moves IS
  'Notes whose ink_data held a whiteboard pen layer before migration 172 gave the layer its own attribute board_ink: moved (certain) or copied (ambiguous). Kept so the move can be undone (scripts/restoreBoardInk.sql) and the ambiguous ones decided.';

-- A text that may not be JSON → jsonb, or NULL. Dropped again at the end.
CREATE OR REPLACE FUNCTION board_ink_try_jsonb(t text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN t::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

WITH pages AS (
  -- Every ink_data that is a single page with at least one stroke, not a PDF's.
  SELECT a.id AS attr_id, a.workspace_id, a.node_id, a.value, a.source, a.updated_at AS attr_updated_at,
         board_ink_try_jsonb(a.value) AS j, n.markdown,
         EXISTS (SELECT 1 FROM canvas_note_conversions c WHERE c.node_id = a.node_id) AS converted,
         EXISTS (SELECT 1 FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(n.collection_views) = 'array' THEN n.collection_views ELSE '[]'::jsonb END) v
                  WHERE v->>'layout' = 'canvas') AS has_board_tab
    FROM node_attributes a
    JOIN content_nodes n ON n.id = a.node_id
   WHERE a.key = 'ink_data'
     AND NOT EXISTS (SELECT 1 FROM node_attributes p WHERE p.node_id = a.node_id AND p.key = 'pdf_url' AND p.value <> '')
     AND NOT EXISTS (SELECT 1 FROM node_attributes b WHERE b.node_id = a.node_id AND b.key = 'board_ink')
     AND NOT EXISTS (SELECT 1 FROM board_ink_moves m WHERE m.node_id = a.node_id)
), single AS (
  SELECT * FROM pages p
   WHERE jsonb_typeof(p.j) = 'object'
     AND jsonb_typeof(p.j->'strokes') = 'array'
     AND jsonb_typeof(p.j->'pages') IS DISTINCT FROM 'object'
     AND jsonb_array_length(p.j->'strokes') > 0
     AND (p.converted OR p.has_board_tab)
), evidence AS (
  -- Evidence for the ambiguous ones only (the point scan is the expensive part).
  SELECT s.*,
         (btrim(s.markdown) <> '') AS has_text,
         EXISTS (
           SELECT 1
             FROM jsonb_array_elements(s.j->'strokes') st,
                  jsonb_array_elements(CASE WHEN jsonb_typeof(st->'points') = 'array' THEN st->'points' ELSE '[]'::jsonb END) pt
            WHERE (CASE WHEN jsonb_typeof(pt->0) = 'number' THEN (pt->>0)::float8 END) < 0
               OR (CASE WHEN jsonb_typeof(pt->1) = 'number' THEN (pt->>1)::float8 END) < 0
               OR (CASE WHEN jsonb_typeof(pt->0) = 'number' THEN (pt->>0)::float8 END)
                  > (CASE WHEN jsonb_typeof(s.j#>'{page,width}') = 'number' THEN (s.j#>>'{page,width}')::float8 ELSE 1000 END)
         ) AS outside_page,
         f.id AS first_event_id,
         COALESCE(
           EXISTS (SELECT 1 FROM domain_events c WHERE c.id = f.triggered_by_event_id
                    AND c.event_type = 'NODE_CREATED' AND c.target_id = s.node_id::text),
           false)
         OR COALESCE(jsonb_typeof(board_ink_try_jsonb(f.v)->'strokes') = 'array'
                     AND jsonb_array_length(board_ink_try_jsonb(f.v)->'strokes') = 0, false) AS born_handwriting
    FROM single s
    LEFT JOIN LATERAL (
      SELECT e.id, e.triggered_by_event_id, COALESCE(b.content, e.payload->>'value') AS v
        FROM domain_events e
        LEFT JOIN blobs b ON b.hash = e.payload->>'value_ref'
       WHERE e.workspace_id = s.workspace_id AND e.target_id = s.node_id::text
         AND e.event_type = 'ATTRIBUTE_SET' AND e.payload->>'key' = 'ink_data'
       ORDER BY e.id LIMIT 1
    ) f ON true
   WHERE NOT s.converted
), plan AS (
  SELECT attr_id, workspace_id, node_id, value, source, attr_updated_at,
         'moved'::text AS action, 'canvas_note_conversion'::text AS reason, 'board'::text AS suggested,
         jsonb_build_object('converted_in_138', true) AS signals,
         gen_random_uuid() AS new_attr_id
    FROM single WHERE converted
  UNION ALL
  SELECT attr_id, workspace_id, node_id, value, source, attr_updated_at,
         CASE WHEN outside_page THEN 'moved' ELSE 'copied' END,
         CASE WHEN outside_page THEN 'outside_page' ELSE 'ambiguous' END,
         CASE WHEN outside_page THEN 'board'
              WHEN has_text AND NOT born_handwriting THEN 'board'
              WHEN born_handwriting AND NOT has_text THEN 'handwriting'
              ELSE 'unknown' END,
         jsonb_build_object('has_text', has_text, 'outside_page', outside_page,
                            'born_handwriting', born_handwriting, 'no_events', first_event_id IS NULL),
         gen_random_uuid()
    FROM evidence
), renamed AS (
  UPDATE node_attributes a SET key = 'board_ink'
    FROM plan p WHERE a.id = p.attr_id AND p.action = 'moved'
  RETURNING a.id
), copied AS (
  INSERT INTO node_attributes (id, workspace_id, node_id, key, value, is_inheritable, value_type, source, updated_at)
  SELECT p.new_attr_id, p.workspace_id, p.node_id, 'board_ink', p.value, false, 'text', p.source, p.attr_updated_at
    FROM plan p WHERE p.action = 'copied'
  RETURNING id
)
INSERT INTO board_ink_moves (node_id, workspace_id, action, reason, suggested, signals, board_ink_attribute_id, value_hash)
SELECT p.node_id, p.workspace_id, p.action, p.reason, p.suggested, p.signals,
       CASE WHEN p.action = 'moved' THEN p.attr_id ELSE p.new_attr_id END,
       encode(sha256(convert_to(p.value, 'UTF8')), 'hex')
  FROM plan p
 WHERE (p.action = 'moved' AND EXISTS (SELECT 1 FROM renamed r WHERE r.id = p.attr_id))
    OR (p.action = 'copied' AND EXISTS (SELECT 1 FROM copied c WHERE c.id = p.new_attr_id))
ON CONFLICT (node_id) DO NOTHING;

DROP FUNCTION board_ink_try_jsonb(text);
