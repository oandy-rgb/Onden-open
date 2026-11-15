-- F3.6 — class_tag default_base_embed substrate.
--
-- When a class_tag carries this field, applying the tag to a node should
-- automatically wikilink-embed the referenced base into the tagged
-- node's body (consumer-driven, not enforced by the DB — the column is
-- just a slot the dispatcher / UI reads when expanding a tag).
--
-- This is one of the 5 attribute-grammar primitives from
-- project_dispatch_model: "Sub-tree template" via Tana's Default Content.
-- The base's `this`-aware filters (file.hasLink(this), file.hasTag(this))
-- combined with this auto-embed gives subtree-scoped views for free —
-- the user tags a node #project, and a project-dashboard base pops in.
--
-- The column is text (UUID reference to a base node). NULL means no
-- default — most class_tags don't need one and shouldn't carry the
-- coupling. A future commit can promote to a proper FK; today the soft
-- reference matches how class_tag_ids on regular nodes work.

ALTER TABLE content_nodes
  ADD COLUMN default_base_embed text;

COMMENT ON COLUMN content_nodes.default_base_embed IS
  'F3.6 (043): for node_type=class_tag rows, the node_id of a base whose '
  'view should be auto-embedded when the tag is applied to a node. NULL '
  'for everything else.';
