-- 179: decide the ambiguous notes of migration 172 that have text: they are boards.
--
-- Migration 172 could not tell a board layer from a handwriting page when a note had a
-- whiteboard tab and every stroke lay on the page, so it copied the page to `board_ink`,
-- left `ink_data`, and recorded action 'copied' for a person to decide. Nobody could: the
-- app has no place for it. Meanwhile the note's content tab, seeing `ink_data`, shows the
-- handwriting page in place of the note's text. The owner reported it on 2026-11-07
-- (a day note whose text was covered) and decided: every such note with text is a board.
-- A handwriting page has no text, so text on the note is what settles it.
--
-- For a 'copied' row with no decision, not undone, whose note has text, `ink_data` is
-- REMOVED and the drawing stays in `board_ink`. Before the row goes:
--   - strokes and shapes drawn on the content tab since 172 (`ink_data` no longer has the
--     value 172 copied) are added to `board_ink` by id, with their erasures. Nothing a
--     person drew goes: an erasure of a stroke both sides have stays the board's.
--
-- Left as they are, undecided:
--   - a note with no text (172's 'handwriting' and 'unknown' pages);
--   - a page with text boxes or pictures on it (`page_text`, `page_images`): it was used
--     as a handwriting page, and a board's pen layer cannot show them;
--   - a note with a `pdf_url`, an `ink_data` or `board_ink` that is no longer a single page.
--
-- The row becomes action 'moved', decision 'board', moved_at now, so what is true of a
-- move is true of it: its saves until now read as the board's in history (bodyEvents.ts),
-- and scripts/restoreBoardInk.sql renames `board_ink` back to `ink_data` instead of
-- deleting what is now the only copy.
--
-- Not touched: the text and updated_at of any note, domain_events, blobs. `board_ink`
-- gets a new updated_at only when strokes were added to it. A device that is offline
-- keeps its local copy of `ink_data` until it reads the server again.
--
-- The drawing is safe because the row removed is a copy or was just added to `board_ink`,
-- so the notes with a drawing stay the same; the bytes go down by the duplicate.
-- drill: allows ink_data_rows, ink_bytes, attributes
-- Idempotent: a decided row is not picked again.

-- A text that may not be JSON → jsonb, or NULL. Dropped again at the end.
CREATE OR REPLACE FUNCTION board_ink_try_jsonb(t text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN t::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END $$;

-- `field` of a drawing as an array: [] when it is missing or something else.
CREATE OR REPLACE FUNCTION board_ink_items(doc jsonb, field text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(doc->field) = 'array' THEN doc->field ELSE '[]'::jsonb END
$$;

-- The items of `field` in `ink` that `board` does not have, by id, in their order.
CREATE OR REPLACE FUNCTION board_ink_missing(board jsonb, ink jsonb, field text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(i.item ORDER BY i.at), '[]'::jsonb)
    FROM jsonb_array_elements(board_ink_items(ink, field)) WITH ORDINALITY i(item, at)
   WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(board_ink_items(board, field)) b(item)
                      WHERE b.item->>'id' = i.item->>'id')
$$;

-- `board` plus what only `ink` has: strokes with their erasures, and shapes.
CREATE OR REPLACE FUNCTION board_ink_union(board jsonb, ink jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT board
         || jsonb_build_object(
              'strokes', board_ink_items(board, 'strokes') || strokes.added,
              'erased', CASE WHEN jsonb_typeof(board->'erased') = 'object' THEN board->'erased' ELSE '{}'::jsonb END || erased.added)
         || CASE WHEN shapes.added = '[]'::jsonb THEN '{}'::jsonb
                 ELSE jsonb_build_object('shapes', board_ink_items(board, 'shapes') || shapes.added) END
    FROM (SELECT board_ink_missing(board, ink, 'strokes') AS added) strokes,
         (SELECT board_ink_missing(board, ink, 'shapes') AS added) shapes,
         LATERAL (
           SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb) AS added
             FROM jsonb_each(CASE WHEN jsonb_typeof(ink->'erased') = 'object' THEN ink->'erased' ELSE '{}'::jsonb END) e
            WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(strokes.added) s(item) WHERE s.item->>'id' = e.key)
         ) erased
$$;

WITH picked AS (
  SELECT m.node_id, ink.id AS ink_attr_id, board.id AS board_attr_id,
         board_ink_try_jsonb(ink.value) AS ink, board_ink_try_jsonb(board.value) AS board,
         encode(sha256(convert_to(ink.value, 'UTF8')), 'hex') <> m.value_hash AS drawn_since
    FROM board_ink_moves m
    JOIN content_nodes n ON n.id = m.node_id
    JOIN node_attributes ink ON ink.node_id = m.node_id AND ink.key = 'ink_data'
    JOIN node_attributes board ON board.node_id = m.node_id AND board.key = 'board_ink'
   WHERE m.action = 'copied' AND m.decision IS NULL AND m.restored_at IS NULL
     AND btrim(n.markdown) <> ''
     AND NOT EXISTS (SELECT 1 FROM node_attributes p WHERE p.node_id = m.node_id AND p.key = 'pdf_url' AND p.value <> '')
     -- Anything but an empty list on the handwriting page counts as something on it.
     AND NOT EXISTS (SELECT 1 FROM node_attributes l
                      WHERE l.node_id = m.node_id AND l.key IN ('page_text', 'page_images')
                        AND COALESCE(board_ink_try_jsonb(l.value)#>ARRAY['pages', 'page', CASE l.key WHEN 'page_text' THEN 'boxes' ELSE 'images' END],
                                     '[]'::jsonb) <> '[]'::jsonb)
), pages AS (
  SELECT * FROM picked p
   WHERE jsonb_typeof(p.ink->'strokes') = 'array' AND jsonb_typeof(p.ink->'pages') IS DISTINCT FROM 'object'
     AND jsonb_typeof(p.board->'strokes') = 'array' AND jsonb_typeof(p.board->'pages') IS DISTINCT FROM 'object'
), joined AS (
  UPDATE node_attributes a SET value = u.value::text, updated_at = now()
    FROM (SELECT board_attr_id, board, board_ink_union(board, ink) AS value FROM pages WHERE drawn_since) u
   WHERE a.id = u.board_attr_id AND u.value <> u.board
), removed AS (
  DELETE FROM node_attributes a USING pages p WHERE a.id = p.ink_attr_id
  RETURNING a.node_id
)
UPDATE board_ink_moves m
   SET action = 'moved', decision = 'board', decided_at = now(), moved_at = now()
  FROM removed r
 WHERE m.node_id = r.node_id;

DROP FUNCTION board_ink_union(jsonb, jsonb);
DROP FUNCTION board_ink_missing(jsonb, jsonb, text);
DROP FUNCTION board_ink_items(jsonb, text);
DROP FUNCTION board_ink_try_jsonb(text);
