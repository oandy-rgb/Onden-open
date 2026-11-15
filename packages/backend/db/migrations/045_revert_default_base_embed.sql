-- F3-rethink — revert migration 043.
--
-- The `default_base_embed` column referenced a base node by id. With B-path
-- (bases are not a separate entity), there is no "default base to auto-embed"
-- — a class_tag's default content is just regular markdown, which can itself
-- include a fenced onden-base block if a tag wants to seed a view.
--
-- Column had no consumers in the shipping codebase; safe to drop.

ALTER TABLE content_nodes
  DROP COLUMN IF EXISTS default_base_embed;
