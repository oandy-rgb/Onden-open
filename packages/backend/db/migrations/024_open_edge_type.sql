-- Lift the CHECK constraint on node_edges.edge_type.
--
-- The original three values (knowledge_link, suggested_link, nav_link) made
-- sense when node_edges only carried wikilinks. The substrate is now growing
-- into a typed-edge graph where every relation between nodes — tree parent,
-- canvas membership, highlight-source, clone-of, you name it — lives on this
-- one table differentiated by `edge_type`. A CHECK constraint requires a
-- migration for every new relation we invent; we don't want that friction.
--
-- The application layer interprets edge_type via a documented taxonomy (see
-- schema.sql header). Unknown types are intentionally tolerated so plugin /
-- TagPack authors can add their own without core changes.
--
-- See the substrate vision in project_onden_vision.md (memory) — "tree /
-- graph / tag / canvas are all view projections on one note model" — typed
-- edges are the substrate that makes that statement load-bearing.

ALTER TABLE node_edges DROP CONSTRAINT IF EXISTS node_edges_edge_type_check;
