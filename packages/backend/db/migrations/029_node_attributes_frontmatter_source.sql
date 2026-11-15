-- W2 P5: extend node_attributes.source CHECK to accept 'frontmatter'.
--
-- Before this migration:
--   source ∈ ('explicit', 'derived')
--     - 'explicit'  : set via /api/nodes/:id/attributes PUT
--     - 'derived'   : extracted from markdown body via extractAttributes
--                     (#key=value, key:: value, [key:: value])
--
-- After this migration:
--   source ∈ ('explicit', 'derived', 'frontmatter')
--     - 'frontmatter' : extracted from YAML frontmatter block at the top of
--                       the markdown body (between `---` fences). Distinct
--                       from 'derived' because frontmatter is the
--                       file-level / note-level metadata convention, vs
--                       body-inline `key:: value` which is paragraph-level.
--
-- Reason for distinct source: when a user edits the frontmatter directly
-- in the editor (W2 P5 UI), the save flow needs to know which existing
-- attributes came from where so it can replace just the frontmatter slice
-- without touching #key=value or key:: value pulled from the body.
--
-- Reference: project_obsidian_markdown_block_pattern memory — Obsidian's
-- own model treats frontmatter (file-level) and inline attrs (Dataview,
-- block-level) as parallel but distinct sources.

ALTER TABLE node_attributes
  DROP CONSTRAINT IF EXISTS node_attributes_source_check;

ALTER TABLE node_attributes
  ADD CONSTRAINT node_attributes_source_check
    CHECK (source IN ('explicit', 'derived', 'frontmatter'));
