-- F3.1 — extend content_nodes.node_type to include 'base'.
--
-- A `base` node holds an Obsidian-Bases-shaped YAML document in its
-- markdown body: filters + formulas + properties + views. The body is
-- parsed by lib/basesParser.ts (F3.2) and rendered by views/ layout
-- components (F3.3). Embedding via ![[name.base#view]] is wired in F3.4.
--
-- Like class_tag (migration 037), 'base' is a regular content_nodes row:
-- ER series / class_tag scope cascade / event audit / restore all "just
-- work" because the substrate doesn't special-case the kind. The YAML
-- body sits in `markdown` (no new column) so backup, restore, search,
-- and version history all see the base definition as plain text.
--
-- Reference: project_obsidian_bases_pattern (Obsidian 1.9 spec).

ALTER TABLE content_nodes
  DROP CONSTRAINT content_nodes_node_type_check;
ALTER TABLE content_nodes
  ADD CONSTRAINT content_nodes_node_type_check
  CHECK (node_type IN ('content', 'class_tag', 'base'));

COMMENT ON CONSTRAINT content_nodes_node_type_check ON content_nodes IS
  'F3.1 (042): allowed kinds. content=regular note; class_tag=tag-as-node '
  '(migration 037); base=Obsidian-Bases YAML view definition.';
