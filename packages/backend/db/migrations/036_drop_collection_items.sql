-- A1 commit 1 — drop collection_items phantom table.
--
-- collection_items was schema-defined in earlier design but never written
-- to or read from in production code (audit 2026-06-05). The full
-- "collection item" concept is implemented as content_nodes tagged with a
-- class tag, with field values in node_attributes. Keeping the empty
-- phantom table around invites future devs to wonder what it's for and
-- potentially mis-route logic into it.
--
-- Per thesis "心智模型統一" — one concept, one place.
--
-- Verification (2026-06-05):
--   - SELECT COUNT(*) FROM collection_items: 0
--   - Only reference outside schema.sql: workspaceBoundary.test.ts (table
--     boundary check), updated alongside this migration.
--
-- Reversible: re-create from schema.sql if ever needed. No data is lost.

DROP INDEX IF EXISTS collection_items_schema_idx;
DROP TABLE IF EXISTS collection_items;
