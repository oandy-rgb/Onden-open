-- Sync-protocol §7 step 1 (architecture-debt #1): attribute PROVENANCE.
--
-- node_attributes.source already exists (008) with CHECK ('explicit','derived')
-- and was extended to add 'frontmatter' (029). The sync protocol §2 fixes the
-- canonical vocabulary to the INPUT RAIL that wrote the attribute:
--
--   ui          — explicit edits via the attributes panel / inline-props UI.
--   markdown    — body-inline attrs (#key=value, key:: value, [key:: value]).
--   frontmatter — YAML frontmatter block at the top of the body.
--   dispatcher  — agent / tag-behaviour automation (the dispatcher rail).
--
-- This extends the CHECK to a SUPERSET that accepts both the new canonical
-- values AND the legacy ones, so:
--   * existing rows ('explicit','derived','frontmatter') stay valid — no data
--     rewrite, no down-migration needed (reversible-in-spirit: drop back to the
--     029 constraint and the only invalid rows would be NEW 'ui'/'markdown'/
--     'dispatcher' writes, which a revert would also stop producing).
--   * the column DEFAULT stays 'explicit' so any unspecified write is unchanged.
--
-- Legacy → canonical mapping (priority is equal, see spine/attributeSource.ts):
--   explicit ≡ ui,  derived ≡ markdown.
--
-- No backfill: old rows keep their legacy label; the application reads both
-- vocabularies via SOURCE_PRIORITY (legacy aliases included), so the tie-break
-- merge ranks them identically.

ALTER TABLE node_attributes
  DROP CONSTRAINT IF EXISTS node_attributes_source_check;

ALTER TABLE node_attributes
  ADD CONSTRAINT node_attributes_source_check
    CHECK (source IN (
      -- canonical (sync-protocol §2)
      'ui', 'markdown', 'frontmatter', 'dispatcher',
      -- legacy (008 / 029) — kept valid for existing rows
      'explicit', 'derived'
    ));
