-- Repair node_attributes.value_type for values of schema fields (D21).
--
-- Until D21 each writer chose value_type with its own rule: a date edited in a
-- collection table was stored as 'text', a rating set from the editor or a
-- boolean/rating field default as 'text'. Collection sorts and range filters
-- read typed values only from rows typed 'number' / 'date', so those values
-- were missing from date sorts and filters. Writes now take the type from the
-- governing schema field (services/attributeChange.ts, @onden/markdown
-- attributeValue); this brings stored rows to the same rule:
--   * the governing field is the one the schema tags on the node declare under
--     the key; when they disagree on the storage type the key is free-form and
--     the row is left alone (attributeValue.governingField, fieldForKey);
--   * the first such field in tag order (created_at, id, field position)
--     decides validity — a rating's scale;
--   * an empty value, and a value the field refuses, is 'text'; a valid one
--     gets the field's storage type (rating → number, boolean → bool,
--     relation → node_ref); numbers use attributeValue.NUMBER_PATTERN and
--     dates attributeValue.isCalendarDate, mirrored below.
-- Any other row typed 'date' or 'number' whose value the rule would not type
-- so (a free-form "2026-02-30" typed date, " 5 " typed number) becomes 'text':
-- the range filter casts every value_type='date' row to timestamptz, so after
-- this a stored date is always castable (new writes keep it so).
-- Imported notes: their re-import baseline used to hash value_type. The type
-- each retyped row had before is kept in `_import_retyped` ({key: old type},
-- first repair wins) so services/importIdentity.ts can still reproduce the
-- old stamp; the next stamp drops it.
-- Values, source and updated_at stay, so no conflict or sync noise; devices'
-- local copies pick up the type with their next full load. Undo types both
-- sides by the same rule before comparing (services/eventRestore/attributes.ts),
-- so history written before this repair still undoes on schema-field keys.
-- Idempotent: a second run finds no row whose type differs.

CREATE FUNCTION pg_temp.d21_is_calendar_date(v text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  m text[];
BEGIN
  m := regexp_match(v, '^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]+)?)?(?:Z|[+-]([0-9]{2}):?([0-9]{2}))?)?$');
  IF m IS NULL THEN RETURN false; END IF;
  -- The app's calendar check (JS Date.UTC) maps years 0–99 to 19xx, so it
  -- refuses them; so does this.
  IF m[1]::int < 100 THEN RETURN false; END IF;
  PERFORM make_date(m[1]::int, m[2]::int, m[3]::int); -- raises on 2026-02-30
  IF m[4] IS NOT NULL AND (m[4]::int > 23 OR m[5]::int > 59 OR coalesce(m[6]::int, 0) > 59) THEN RETURN false; END IF;
  -- Postgres casts a zone displacement only up to ±15:59.
  IF m[7] IS NOT NULL AND (m[7]::int > 15 OR m[8]::int > 59) THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END $$;

CREATE FUNCTION pg_temp.d21_rating_ok(v text, max_json jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  top numeric := 5;
  n numeric;
BEGIN
  IF v !~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN false; END IF;
  n := v::numeric;
  IF jsonb_typeof(max_json) = 'number' AND (max_json #>> '{}')::numeric > 0 THEN top := (max_json #>> '{}')::numeric; END IF;
  RETURN n = trunc(n) AND n >= 0 AND n <= top;
END $$;

CREATE TEMP TABLE d21_retype ON COMMIT DROP AS
WITH governing AS (
  SELECT na.id, na.value, f.field, f.field->>'type' AS field_type,
         CASE f.field->>'type'
           WHEN 'number' THEN 'number' WHEN 'rating' THEN 'number'
           WHEN 'boolean' THEN 'bool' WHEN 'date' THEN 'date'
           WHEN 'relation' THEN 'node_ref' ELSE 'text'
         END AS storage,
         row_number() OVER (PARTITION BY na.id ORDER BY t.created_at, t.id, f.ord) AS pos
    FROM node_attributes na
    JOIN node_tags nt ON nt.node_id = na.node_id
    JOIN content_nodes t ON t.id = nt.tag_id
     AND t.node_type = 'class_tag' AND t.deleted_at IS NULL AND t.tag_schema IS NOT NULL
     AND t.workspace_id = na.workspace_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(t.tag_schema->'fields') = 'array' THEN t.tag_schema->'fields' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS f(field, ord)
   WHERE f.field->>'name' = na.key
),
decided AS (
  SELECT g.id, g.value, g.field, g.field_type, g.storage
    FROM governing g
   WHERE g.pos = 1
     AND NOT EXISTS (SELECT 1 FROM governing o WHERE o.id = g.id AND o.storage <> g.storage)
),
governed AS (
  SELECT id,
         CASE
           WHEN value = '' THEN 'text'
           WHEN storage = 'text' THEN 'text'
           WHEN field_type = 'number'   AND value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN 'number'
           WHEN field_type = 'rating'   AND pg_temp.d21_rating_ok(value, field->'max') THEN 'number'
           WHEN field_type = 'boolean'  AND value IN ('true', 'false') THEN 'bool'
           WHEN field_type = 'date'     AND pg_temp.d21_is_calendar_date(value) THEN 'date'
           WHEN field_type = 'relation' THEN 'node_ref'
           ELSE 'text'
         END AS value_type
    FROM decided
),
uncastable AS (
  SELECT na.id, 'text' AS value_type
    FROM node_attributes na
   WHERE NOT EXISTS (SELECT 1 FROM governed g WHERE g.id = na.id)
     AND ((na.value_type = 'date' AND NOT pg_temp.d21_is_calendar_date(na.value))
       OR (na.value_type = 'number' AND na.value !~ '^-?[0-9]+(\.[0-9]+)?$'))
)
SELECT na.id, na.workspace_id, na.node_id, na.key, na.value_type AS old_type, t.value_type AS new_type
  FROM (SELECT * FROM governed UNION ALL SELECT * FROM uncastable) t
  JOIN node_attributes na ON na.id = t.id
 WHERE na.value_type <> t.value_type;

-- The old types of an imported note's retyped rows (see above).
INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
SELECT r.workspace_id, r.node_id, '_import_retyped', jsonb_object_agg(r.key, r.old_type)::text, 'text', false, 'derived'
  FROM d21_retype r
 WHERE EXISTS (SELECT 1 FROM node_attributes b WHERE b.node_id = r.node_id AND b.key = '_import_baseline')
 GROUP BY r.workspace_id, r.node_id
ON CONFLICT (node_id, key) DO UPDATE
  SET value = ((EXCLUDED.value)::jsonb || (node_attributes.value)::jsonb)::text;

UPDATE node_attributes na
   SET value_type = r.new_type
  FROM d21_retype r
 WHERE na.id = r.id;

DROP FUNCTION pg_temp.d21_rating_ok(text, jsonb);
DROP FUNCTION pg_temp.d21_is_calendar_date(text);
DROP TABLE d21_retype;
