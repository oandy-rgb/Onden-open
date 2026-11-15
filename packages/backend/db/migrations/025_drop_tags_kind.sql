-- Drop tags.kind.
--
-- The column previously held 'content' (plain label tag) vs 'supertag'
-- (tag that owns a schema + policy + behaviour). The distinction is fully
-- carried by `schema_id IS NOT NULL` — there is no row where kind and
-- schema_id disagree, and no code path that needs both to decide.
--
-- Dropping it removes one piece of duplicated state and one source of
-- the "supertag" terminology the substrate doesn't owe Tana. Callers
-- that used `WHERE kind = 'supertag'` now use `WHERE schema_id IS NOT NULL`.
-- Application code interprets a tag as "a class" when it carries a schema
-- and as "a label" when it doesn't.

ALTER TABLE tags DROP COLUMN IF EXISTS kind;
