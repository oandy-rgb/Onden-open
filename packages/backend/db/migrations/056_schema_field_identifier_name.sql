-- One identifier convention for collection_schemas.fields entries: `name`.
--
-- TagPack import used to store a field's identifier under `key`, while the
-- schema editor PATCH writes `name`. Every read path — backend (collections
-- value typing, rollups, publish title pick) and all frontend consumers except
-- TagsPanel — reads `name` only, so a key-only field was invisible to them
-- (e.g. a featured field rendering "Empty" right after a behaviour cascade set
-- its value). The import route now normalizes at the write boundary; this
-- backfills rows written before that existed: name := COALESCE(name, key),
-- then drop `key`. Entries that never had `key` pass through untouched.
UPDATE collection_schemas
SET fields = (
  SELECT COALESCE(jsonb_agg(
    CASE
      WHEN jsonb_typeof(f) = 'object' AND f ? 'key' THEN
        (CASE
           WHEN NULLIF(f->>'name', '') IS NOT NULL THEN f
           ELSE jsonb_set(f, '{name}', f->'key')
         END) - 'key'
      ELSE f
    END
    ORDER BY ord), '[]'::jsonb)
  FROM jsonb_array_elements(fields) WITH ORDINALITY AS t(f, ord)
),
updated_at = now()
WHERE jsonb_typeof(fields) = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(fields) e
    WHERE jsonb_typeof(e) = 'object' AND e ? 'key'
  );
