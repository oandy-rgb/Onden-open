-- 132: which media files each publish snapshot carries, per note.
--
-- Before: an anonymous request for /api/media/<file> asked whether the served
-- site shows it by scanning the latest snapshot's whole payload (tens of MB of
-- jsonb, detoasted and lower-cased per row) once per image: ~185 ms each at 20k
-- notes (docs/research/review-2026-10-24/performance.md #5).
--
-- Now a publish records, in the transaction that inserts the snapshot, every
-- media id the snapshot's notes, collection rows and presentation name, and the
-- check is an index lookup (servedSiteShowsMedia). `kind` says where the
-- reference is: 'node' and 'item' rows name the carrying note or collection row
-- in owner_id; 'presentation' (the site settings: logo, favicon, chrome) has no
-- owner. Ids are stored lower-cased and matched whole (the media-id grammar,
-- @onden/markdown mediaRefs), where the scan matched a substring.
--
-- The backfill reads each existing snapshot once with a regex slightly looser
-- than the grammar (no look-behind in Postgres), so it can only add ids the
-- scan also matched.

CREATE TABLE snapshot_media (
  snapshot_id uuid NOT NULL REFERENCES publish_snapshots(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('node', 'item', 'presentation')),
  owner_id text NOT NULL,
  filename text NOT NULL,
  PRIMARY KEY (snapshot_id, kind, owner_id, filename)
);
CREATE INDEX snapshot_media_filename_idx ON snapshot_media (filename, snapshot_id);

INSERT INTO snapshot_media (snapshot_id, kind, owner_id, filename)
SELECT DISTINCT s.id, 'node', n->>'id', lower(m[1])
  FROM publish_snapshots s,
       jsonb_array_elements(coalesce(s.payload->'nodes', '[]'::jsonb)) n,
       regexp_matches(n::text, '/api/media/([A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)', 'g') m
 WHERE n->>'id' IS NOT NULL
UNION
SELECT DISTINCT s.id, 'item', i->>'id', lower(m[1])
  FROM publish_snapshots s,
       jsonb_array_elements(coalesce(s.payload->'collections', '[]'::jsonb)) c,
       jsonb_array_elements(coalesce(c->'items', '[]'::jsonb)) i,
       regexp_matches(i::text, '/api/media/([A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)', 'g') m
 WHERE i->>'id' IS NOT NULL
UNION
SELECT DISTINCT s.id, 'presentation', '', lower(m[1])
  FROM publish_snapshots s,
       regexp_matches(coalesce(s.payload->'presentation', '{}'::jsonb)::text, '/api/media/([A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?)', 'g') m;
