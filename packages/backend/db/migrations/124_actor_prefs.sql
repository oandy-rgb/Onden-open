-- 124_actor_prefs.sql
--
-- A person's own preferences that follow them to every device they sign in
-- on (services/actorPrefs.ts): first the navigation layout, 「釘到導覽列」
-- (frontend lib/navLayout). Not shared knowledge and not an event: one row per
-- person and key, last write wins. Each key's shape is checked by the
-- service; the browser keeps a copy for offline use (lib/navLayoutStore).
--
-- The rows go with the person (ON DELETE CASCADE from actors).
CREATE TABLE IF NOT EXISTS actor_prefs (
  actor_id uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, key)
);
