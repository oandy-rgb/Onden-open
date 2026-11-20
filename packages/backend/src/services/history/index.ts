// The history domain's one entry. Code outside services/history/ imports from
// here only; the files behind it may import each other directly.
//
//   noteVersions   one note's version list (GET /api/nodes/:id/versions)
//   inkChanges     what handwriting saves drew and erased (GET /api/nodes/:id/ink-edits, /ink-change)
//   activity       edits per day, a day's (or many days') notes and agent runs, recently deleted (routes/history.ts)
//   agentRunUndo   undo/redo of an agent run
//   pointInTime    the notes as they were at an instant (GET /api/history/at)
//   rewind         put them back to that instant, and undo that (POST /api/history/rewind)

export { bodyEventSql, editEventSql, inkEventSql, lastBodyHashBeforeSql, lastContentEdits, saveOnDaySql, versionActorTypeSql } from "./bodyEvents.js";
export { actorKindOf, listNoteVersions } from "./noteVersions.js";
export { recentVersions } from "./recentVersions.js";
export { inkChangeValues, listInkEdits, restoreInkVersion } from "./inkChanges.js";
export type { ActorKind, ChangeSummary } from "./noteVersions.js";
export { activityByDay, PLACEHOLDER_TITLES, agentRunsOn, deletedNoteBody, DELETED_PAGE_DEFAULT, feedByDay, FEED_NOTES_PER_DAY, isDeletedCursor, notesEditedOn, notesEditedPage, recentlyDeleted, rewindsOn, type DeletedWindow } from "./activity.js";
export { AgentRunError, redoAgentRun, undoAgentRun, type RunRevertResult } from "./agentRunUndo.js";
export { noteAt, workspaceAt } from "./pointInTime.js";
export { RewindError, rewindWorkspace, rewindsBetween, undoRewind } from "./rewind.js";
