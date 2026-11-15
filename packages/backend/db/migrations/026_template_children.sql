-- Sub-tree template substrate: a class-tag's schema can declare children
-- to be created when the tag is applied to a node.
--
-- Pattern: each slot is `{ title, body?, child_class_tag_slug? }`.
--   • title is required — becomes the child node's title.
--   • body is optional — becomes the child node's initial markdown.
--   • child_class_tag_slug is optional — if set, that tag is applied to the
--     spawned child, which may itself trigger another expansion (depth
--     limited to avoid cycles).
--
-- Idempotency: spawned children carry an `_tpl_origin` attribute holding the
-- marker "<parent_node_id>:<applied_tag_slug>:<slot_idx>". Re-applying the
-- same tag scans the parent's direct children for a matching marker and
-- skips slots whose children still exist (renamed or edited is fine — the
-- marker is what matters). Removing the tag does NOT delete the children;
-- their data is the user's now.
--
-- Lineage: this is the Godot scene-tree / Tana Default Content / Minsky
-- frame default-slot pattern. See memory project_dispatch_model.md for the
-- five-primitive framework this fills.

ALTER TABLE collection_schemas
  ADD COLUMN IF NOT EXISTS template_children jsonb NOT NULL DEFAULT '[]';
