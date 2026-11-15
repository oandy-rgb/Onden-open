-- F3-rethink — revert migration 042.
--
-- Per thesis 心智模型統一: a base is NOT a separate kind of node. Any note
-- can carry view definitions in its frontmatter or in a fenced
-- `\`\`\`onden-base\`\`\`` block. The substrate should not enforce a second
-- entity for what is really "markdown body that happens to describe a view".
--
-- This drops the 'base' value from the node_type CHECK. No data migration
-- is required because no user has authored a node_type='base' row yet —
-- 042 shipped + 043 added the column on top, but Onden's UI never wrote
-- to it; the only base-shaped content is the inline-yaml OndenBaseBlock
-- which uses a fenced code block in a regular content node.

ALTER TABLE content_nodes
  DROP CONSTRAINT content_nodes_node_type_check;
ALTER TABLE content_nodes
  ADD CONSTRAINT content_nodes_node_type_check
  CHECK (node_type IN ('content', 'class_tag'));

COMMENT ON CONSTRAINT content_nodes_node_type_check ON content_nodes IS
  'F3-rethink (044): allowed kinds. content=regular note (may carry a view '
  'definition in its body); class_tag=tag-as-node (migration 037). The 042 '
  'addition of base was rolled back — bases are presentational, not a '
  'distinct entity.';
