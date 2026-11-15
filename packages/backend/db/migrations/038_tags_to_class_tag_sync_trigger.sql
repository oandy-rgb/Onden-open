-- A1 step 3 — keep content_nodes shadow row in sync with tags.
--
-- After migration 037, the 11 existing tags have shadow rows in
-- content_nodes (same UUID, node_type='class_tag'). But subsequent
-- writes to tags (INSERT for new chain segments via L1 resolveOrCreate,
-- UPDATE for rename/recolor, DELETE for removal) would leave the
-- shadow stale unless we sync.
--
-- This trigger maintains the invariant: for every tags row T there
-- exists a content_nodes row N where N.id = T.id and N.node_type =
-- 'class_tag', with N.title=T.name, N.tag_color=T.color,
-- N.tag_schema_id=T.schema_id, N.parent_id=T.parent_id.
--
-- The trigger is INTENTIONALLY temporary. Subsequent commits rewrite
-- tag-write code paths to write to content_nodes directly (skipping
-- tags). Once nothing writes to tags, the trigger has nothing to
-- mirror; we drop the trigger + the tags table together.

CREATE OR REPLACE FUNCTION sync_tag_to_class_tag_node() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO content_nodes (
      id, workspace_id, source_type, node_type, title, slug, markdown,
      parent_id, tag_color, tag_schema_id, sort_order, created_at, updated_at
    ) VALUES (
      NEW.id, NEW.workspace_id, 'manual', 'class_tag', NEW.name,
      'tag-' || regexp_replace(lower(NEW.name), '[^a-z0-9-]+', '-', 'g'),
      '', NEW.parent_id, NEW.color, NEW.schema_id, 0, NEW.created_at, NEW.created_at
    )
    ON CONFLICT (id) DO NOTHING;  -- shadow may already exist
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE content_nodes SET
      title         = NEW.name,
      slug          = 'tag-' || regexp_replace(lower(NEW.name), '[^a-z0-9-]+', '-', 'g'),
      tag_color     = NEW.color,
      tag_schema_id = NEW.schema_id,
      parent_id     = NEW.parent_id,
      updated_at    = now()
    WHERE id = NEW.id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    -- Soft-delete the shadow (ER substrate). Mirrors what `DELETE /api/nodes/:id`
    -- does — never actually DROP the row.
    UPDATE content_nodes SET deleted_at = now()
     WHERE id = OLD.id AND deleted_at IS NULL;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tags_to_class_tag_sync_aiud
  AFTER INSERT OR UPDATE OR DELETE ON tags
  FOR EACH ROW EXECUTE FUNCTION sync_tag_to_class_tag_node();

COMMENT ON FUNCTION sync_tag_to_class_tag_node IS
  'A1 L3-A: temporary sync trigger. Keeps content_nodes shadow in step with tags during the consumer-rewrite transition. Will be DROPped when tag writes have moved to content_nodes directly.';
