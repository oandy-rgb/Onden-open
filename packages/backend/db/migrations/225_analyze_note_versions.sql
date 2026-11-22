-- 225: the version tables get planner statistics right after migration 220 filled them (review of PR #1948, round 1, point 3). Changes no row and no schema.
--
-- WHY. History now reads note_versions / note_version_events (docs/architecture/history-api.md). A table that was never analyzed is planned on chance:
-- measured on a workspace of 10,000 saves, a day's list took 16 s with no statistics and 20 ms with them. A server's autovacuum analyzes within minutes;
-- a database without autovacuum (the browser's and the desktop's PGlite) never would. This analyzes them once, at upgrade. Later writes are kept
-- current by autovacuum, or on a node without it by spine/senderStatistics.ts' rule (services/history/storedVersions.ts calls it).
-- drill: no allowance needed; no note body or title is written.
ANALYZE note_versions;
ANALYZE note_version_events;
ANALYZE note_version_positions;
