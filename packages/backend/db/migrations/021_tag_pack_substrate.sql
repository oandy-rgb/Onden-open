-- TagPack substrate: package-manager-style metadata on collection_schemas.
--
-- description  — short user-facing text shown on hover / detail
-- version      — semver string; stamped at export time, displayed on import.
--                We don't yet do upgrade migrations (Tier 3). Just track.
-- dependencies — slug list of other tags this one composes with. Apply-time
--                check warns but doesn't block; the install endpoint validates
--                at import-time.
--
-- All idempotent — defaults backfill existing rows without touching their
-- semantics.

ALTER TABLE collection_schemas
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS version text NOT NULL DEFAULT '1.0.0',
  ADD COLUMN IF NOT EXISTS dependencies text[] NOT NULL DEFAULT '{}';

-- Backfill descriptive text on the 4 builtins seeded in 020 so they don't
-- start life with empty descriptions. Idempotent UPDATE — only writes when
-- the field is still empty so admins can override without re-running.

UPDATE collection_schemas SET description = 'A person — contact, role, notes.'
  WHERE slug = 'person' AND description = '';
UPDATE collection_schemas SET description = 'A book — author, status, reading log. State transitions auto-fill timestamps.'
  WHERE slug = 'book' AND description = '';
UPDATE collection_schemas SET description = 'A project — status state machine, priority, owner. Notifies on ship.'
  WHERE slug = 'project' AND description = '';
UPDATE collection_schemas SET description = 'A meeting — auto-dated, attendees, summary, action items.'
  WHERE slug = 'meeting' AND description = '';
UPDATE collection_schemas SET description = 'A task — status, due date, priority. Hides itself when status=done.'
  WHERE slug = 'task' AND description = '';
UPDATE collection_schemas SET description = 'A page on the published site — layout, sidebar ratio, slug override.'
  WHERE slug = 'page' AND description = '';
UPDATE collection_schemas SET description = 'Archive marker — hides the node from active views when applied.'
  WHERE slug = 'archive' AND description = '';
