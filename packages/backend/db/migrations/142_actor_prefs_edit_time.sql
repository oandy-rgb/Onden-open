-- 142: account preferences remember when the person made the edit, so the
-- later edit wins even when an older one reaches the server afterwards
-- (a phone that edited offline) — services/actorPrefs.ts.
--
--   edited_at   the client clock time of the edit that wrote `value` (NULL: the
--               writer did not say, i.e. an older frontend)
--   order_key   for "only moves forward" keys (a time, a day): the number the
--               value is ordered by, so a write can be refused in one statement
--   value       may be NULL: a reset keeps its row (a tombstone) so an older
--               edit arriving later cannot bring the value back
--
-- No row is rewritten except the order_key backfill below.
ALTER TABLE actor_prefs ADD COLUMN IF NOT EXISTS edited_at timestamptz;
ALTER TABLE actor_prefs ADD COLUMN IF NOT EXISTS order_key double precision;
ALTER TABLE actor_prefs ALTER COLUMN value DROP NOT NULL;

UPDATE actor_prefs SET order_key = extract(epoch FROM (value ->> 'date')::date) * 1000
 WHERE key = 'journalShutdown' AND order_key IS NULL AND (value ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$';
UPDATE actor_prefs SET order_key = extract(epoch FROM (value #>> '{}')::timestamptz) * 1000
 WHERE key = 'rssLastVisit' AND order_key IS NULL AND (value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$';
