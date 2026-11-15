-- 137: the workspace's own calendar clock (docs/agents/deploy.md, localDay.ts).
--
--   time_zone        IANA name the owner chose (Settings › Time). NULL = never
--                    chosen: the server uses ONDEN_TIMEZONE, then UTC, as before.
--   day_start_hour   0–6; the hour a day begins at. 4 means 02:00 still counts
--                    as the day before. 0 is a plain calendar day.
--
-- No existing date, due date, diary title or event is rewritten: only where
-- "today" falls changes, and only when the owner changes these.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS time_zone text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS day_start_hour smallint NOT NULL DEFAULT 0;
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_day_start_hour_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_day_start_hour_check CHECK (day_start_hour BETWEEN 0 AND 6);
