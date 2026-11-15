ALTER TABLE collection_schemas
  ADD COLUMN IF NOT EXISTS views jsonb NOT NULL DEFAULT '{}';
