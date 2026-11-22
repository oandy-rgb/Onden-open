// A test that moves saves back in time edits `domain_events.created_at`; the History readers read the versions those saves recorded
// (note_versions.at, services/history/storedVersions.ts), so the versions follow. Run ALIGN_VERSION_TIMES_SQL after such an UPDATE: every
// version this node mapped to an event takes that event's time (the earliest event, as the version's `at` is its first save's).
// The logical clock is left alone: it keeps the order the saves were made in, whatever time a test gives them.
export const ALIGN_VERSION_TIMES_SQL = `
  UPDATE note_versions v SET at = note_version_at(m.created_at)
    FROM (SELECT ve.note_id, ve.unit, ve.version_key, min(e.created_at) AS created_at
            FROM note_version_events ve JOIN domain_events e ON e.id = ve.event_id GROUP BY 1, 2, 3) m
   WHERE v.note_id = m.note_id AND v.unit = m.unit AND v.version_key = m.version_key AND v.at <> note_version_at(m.created_at)`;
