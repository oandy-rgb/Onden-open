-- 195: function references batch 3, review (docs/architecture/proposals/function-refs-b3-2026-11-12.md §4 item 3 and §7,
-- docs/architecture/proposals/tag-as-scope-2026-11-13.md, docs/architecture/proposals/review-strengthen-2026-11-13.md).
--
-- A review card is now a note or a paragraph (block node) that carries its own shared function reference (function_refs,
-- function_id 'review'); a tag no longer turns its notes into cards.
--
--   1. function_refs gets a third holder: holder_block_id (a block node). Exactly one holder per row; the unique index covers all three.
--   2. Every note (node_type 'content', live, hidden or in the trash: a trashed card comes back with its note) and every
--      block node that was a card gets its own 'review' reference. "Was a card" = it was a direct member (node_tags /
--      block_node_tags) of a tag that provided review: the review module's tag, a tag that extended it, a tag with the legacy
--      switch. A tag counts as providing review exactly as the review service read it: a live tag holding a 'review' reference
--      whose settings source (config.source_tag_id), if any, is a live tag. Notes that were cards ONLY because of such a tag
--      are cards themselves now, so nobody loses a card; their per-person schedules (review_states) are not touched.
--      A tag in the trash that held review is not a provider (the service read live tags only): its notes were not cards, so they
--      get no reference; the NOTICE counts them.
--   3. Tag-level review is removed: the 'review' references held by tags and the legacy behaviour.modules.review switch are
--      deleted. The tags keep their notes, fields, names, colours and members. Each tag whose reference or switch was deleted
--      gets a TAG_MODULES_MIGRATED event, so a client holding an older sync cursor re-reads it.
--   Not touched: review_states (every person's schedule), actor_module_settings and the tags' behaviour.review settings
--   (the daily limits), node_tags / block_node_tags rows, tag nodes (migration 196 decides about the module tags), note text.
--   The `{review}` / `{複習}` words in paragraph text stay as they are; the review service now reads them as the review word.
--
-- Deletes data: only the 'review' references of tags and the legacy switch of step 3 (both are what the removed feature was).
-- Safe to re-run: step 2 inserts with ON CONFLICT DO NOTHING; after step 3 no tag provides review, so a re-run finds no provider
-- tag, inserts nothing more and prints zeros.
-- Rolling back to an older backend: it reads review cards from tags, which step 3 removed, so no card would show; go back by
-- restoring the pre-upgrade backup (migrations only go forward; docs/agents/migrations.md).
--
-- Read-only preview for the live database (counts only; run before upgrading):
--   WITH providers AS (
--     SELECT DISTINCT r.holder_node_id AS id FROM function_refs r
--       JOIN content_nodes t ON t.id = r.holder_node_id AND t.node_type = 'class_tag' AND t.deleted_at IS NULL
--      WHERE r.function_id = 'review' AND r.instance = ''
--        AND (NOT (r.config ? 'source_tag_id') OR EXISTS (SELECT 1 FROM content_nodes s
--              WHERE s.id::text = r.config->>'source_tag_id' AND s.node_type = 'class_tag' AND s.deleted_at IS NULL)))
--   SELECT (SELECT count(*) FROM providers) AS provider_tags,
--          (SELECT count(DISTINCT nt.node_id) FROM node_tags nt JOIN providers p ON p.id = nt.tag_id
--             JOIN content_nodes n ON n.id = nt.node_id AND n.node_type = 'content') AS note_cards,
--          (SELECT count(DISTINCT bt.block_node_id) FROM block_node_tags bt JOIN providers p ON p.id = bt.tag_id) AS block_cards,
--          (SELECT count(*) FROM review_states) AS schedules_kept;

ALTER TABLE function_refs ADD COLUMN IF NOT EXISTS holder_block_id uuid REFERENCES block_nodes(id) ON DELETE CASCADE;
ALTER TABLE function_refs DROP CONSTRAINT IF EXISTS function_refs_one_holder;
ALTER TABLE function_refs ADD CONSTRAINT function_refs_one_holder
  CHECK (num_nonnulls(holder_node_id, holder_space_id, holder_block_id) = 1);
DROP INDEX IF EXISTS function_refs_holder_unique;
CREATE UNIQUE INDEX function_refs_holder_unique
  ON function_refs (COALESCE(holder_node_id, holder_space_id, holder_block_id), function_id, instance);
CREATE INDEX IF NOT EXISTS function_refs_holder_block_idx ON function_refs (holder_block_id) WHERE holder_block_id IS NOT NULL;

DO $$
DECLARE
  provider_count integer;
  only_by_tag text;
  note_refs integer;
  block_refs integer;
  removed_refs integer;
  removed_switches integer;
  module_tags text;
  trashed_tags integer; trashed_notes integer; trashed_blocks integer;
BEGIN
  CREATE TEMP TABLE m195_providers ON COMMIT DROP AS
    SELECT DISTINCT r.holder_node_id AS id, t.workspace_id, (t.tag_schema->>'module' = 'review') AS is_module_tag
      FROM function_refs r
      JOIN content_nodes t ON t.id = r.holder_node_id AND t.node_type = 'class_tag' AND t.deleted_at IS NULL
     WHERE r.function_id = 'review' AND r.instance = ''
       AND (NOT (r.config ? 'source_tag_id') OR EXISTS (
             SELECT 1 FROM content_nodes s
              WHERE s.id::text = r.config->>'source_tag_id' AND s.node_type = 'class_tag' AND s.deleted_at IS NULL));
  SELECT count(*) INTO provider_count FROM m195_providers;

  -- Tags that are not the module's tag but made notes cards: listed, with how many notes they alone made cards.
  SELECT string_agg(p.id::text || ' (' || c.n || ' notes)', ', ' ORDER BY p.id) INTO only_by_tag
    FROM m195_providers p
    JOIN LATERAL (SELECT count(*) AS n FROM node_tags nt JOIN content_nodes x ON x.id = nt.node_id AND x.node_type = 'content'
                   WHERE nt.tag_id = p.id) c ON c.n > 0
   WHERE NOT p.is_module_tag;
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO module_tags FROM m195_providers WHERE is_module_tag;

  -- Tags in the trash that held a review reference: the review service read live tags only, so their notes were not cards and do not
  -- become cards now. Their reference is deleted below with the others; a tag restored from the trash no longer makes cards (no tag does).
  SELECT count(DISTINCT t.id), count(DISTINCT nt.node_id) FILTER (WHERE n.node_type = 'content'), count(DISTINCT bt.block_node_id)
    INTO trashed_tags, trashed_notes, trashed_blocks
    FROM function_refs r
    JOIN content_nodes t ON t.id = r.holder_node_id AND t.node_type = 'class_tag' AND t.deleted_at IS NOT NULL
    LEFT JOIN node_tags nt ON nt.tag_id = t.id LEFT JOIN content_nodes n ON n.id = nt.node_id
    LEFT JOIN block_node_tags bt ON bt.tag_id = t.id
   WHERE r.function_id = 'review' AND r.instance = '';

  WITH ins AS (
    INSERT INTO function_refs (workspace_id, function_id, holder_node_id)
    SELECT DISTINCT n.workspace_id, 'review', n.id
      FROM node_tags nt
      JOIN m195_providers p ON p.id = nt.tag_id
      JOIN content_nodes n ON n.id = nt.node_id AND n.node_type = 'content'
    ON CONFLICT DO NOTHING
    RETURNING 1
  ) SELECT count(*) INTO note_refs FROM ins;

  WITH ins AS (
    INSERT INTO function_refs (workspace_id, function_id, holder_block_id)
    SELECT DISTINCT b.workspace_id, 'review', b.id
      FROM block_node_tags bt
      JOIN m195_providers p ON p.id = bt.tag_id
      JOIN block_nodes b ON b.id = bt.block_node_id
    ON CONFLICT DO NOTHING
    RETURNING 1
  ) SELECT count(*) INTO block_refs FROM ins;

  -- Tag level goes: the references, and the legacy switch still stored in tag_schema.behaviour.modules.review.
  CREATE TEMP TABLE m195_touched ON COMMIT DROP AS
    SELECT DISTINCT t.id, t.workspace_id FROM content_nodes t
     WHERE t.node_type = 'class_tag' AND t.deleted_at IS NULL
       AND (EXISTS (SELECT 1 FROM function_refs r WHERE r.holder_node_id = t.id AND r.function_id = 'review' AND r.instance = '')
            OR (jsonb_typeof(t.tag_schema->'behaviour'->'modules') = 'object' AND (t.tag_schema->'behaviour'->'modules') ? 'review'));

  DELETE FROM function_refs r USING content_nodes t
   WHERE r.function_id = 'review' AND r.instance = '' AND t.id = r.holder_node_id AND t.node_type = 'class_tag';
  GET DIAGNOSTICS removed_refs = ROW_COUNT;

  WITH cleared AS (
    UPDATE content_nodes
       SET tag_schema = jsonb_set(tag_schema, '{behaviour,modules}', (tag_schema->'behaviour'->'modules') - 'review'),
           updated_at = now()
     WHERE node_type = 'class_tag'
       AND jsonb_typeof(tag_schema->'behaviour'->'modules') = 'object' AND (tag_schema->'behaviour'->'modules') ? 'review'
    RETURNING 1
  ) SELECT count(*) INTO removed_switches FROM cleared;

  UPDATE content_nodes t SET updated_at = now() FROM m195_touched m WHERE m.id = t.id;
  INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
  SELECT workspace_id, 'system', 'migration:195', 'TAG_MODULES_MIGRATED', 'tag', id::text,
         jsonb_build_object('migration', '195_review_into_function_refs'),
         jsonb_build_object('ui_context', 'migration.review_into_function_refs')
    FROM m195_touched;

  RAISE NOTICE '[195] review: % tag(s) provided review (module tag(s): %)', provider_count, COALESCE(module_tags, 'none');
  RAISE NOTICE '[195] review: tags other than the module tag that made notes cards (tag id, notes): %', COALESCE(only_by_tag, 'none');
  RAISE NOTICE '[195] review: % tag(s) in the trash held review; their % note(s) and % paragraph(s) were not cards before and are not now',
    trashed_tags, trashed_notes, trashed_blocks;
  RAISE NOTICE '[195] review: % note(s) and % paragraph(s) given their own review reference; % tag review reference(s) and % legacy switch(es) removed',
    note_refs, block_refs, removed_refs, removed_switches;
END $$;

-- New rows were added in bulk: tell the planner (as migration 191 does).
ANALYZE function_refs;
