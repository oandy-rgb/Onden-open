// History as the server sends it: the workspace feed, the deleted list, and a note or the workspace as of an instant.
// Pure types: the app imports them with `import type`, so nothing here may run.

import type { ChangeSummary } from "@onden/markdown";

/** Body of POST /api/nodes/:id/versions/:versionId/restore. `restore_title: false` brings back the text only;
 *  absent (an old client) = true, the title comes back too. */
export type RestoreVersionRequest = { restore_title?: boolean };

export type ActivityDay = { date: string; you: number; agents: number };

export type DeletedNote = { id: string; title: string; deleted_at: string; space_id: string | null; blank: boolean };

/** GET /api/history/deleted: a page of the deleted list, newest first. `older_cursor` is sent back as `before` for the
 *  next, older page; null when nothing older is left. Nothing is deleted by age. */
export type DeletedNotesPage = { notes: DeletedNote[]; older_cursor: string | null };

export type DeletedNoteBody = { id: string; title: string; markdown: string; deleted_at: string };

export type NoteStatus = "same" | "changed" | "deleted_since" | "created_since";

export type NoteAt = {
  id: string;
  status: NoteStatus;
  title_then: string;
  markdown_then: string | null;
  title_now: string;
  markdown_now: string;
  deleted: boolean;
};

export type RewindResult = {
  /** null when nothing was written (everything already as at T, or nothing allowed). */
  rewind_id: string | null;
  restored: string[];
  undeleted: string[];
  deleted: string[];
  /** Asked for, but no longer (or never) in that group at T: changed again meanwhile, or not in this space. */
  stale: string[];
  /** Asked for, but the caller may not write them. */
  unwritable: string[];
  /** Asked for, but deleting them would take an older note with them, or the write was refused. */
  skipped: string[];
};

export type RewindUndoResult = {
  /** Notes now as before the rewind (including those already so). */
  undone: string[];
  /** Notes whose overlapping lines went to the inbox. Also in `undone`. */
  conflicts: string[];
  /** Notes left as they are because they were edited after the rewind (a restored-from-trash note). */
  kept: string[];
  /** Not in this rewind, unreadable to the caller, not writable, or nothing to go back to. */
  skipped: string[];
};

/** Who edited: a person or an AI by name; a temporary session of this server by its kind alone (no name: the screen words it). */
type HistoryActor = { name: string; kind: "human" | "agent" } | { name: null; kind: "session" };

/** What a day did to one note's text: the body before the day's first save (empty for a new note) against the body
 *  after its last. `sample` is the first changed paragraph, markers stripped, at most 120 characters; `sample_kind` says
 *  which text it is: new text for added/changed, the old text for removed. */
export type DayNoteChange = ChangeSummary & {
  sample: string | null;
  sample_kind: "added" | "changed" | "removed" | null;
};

/** What a day drew and erased on one drawing of a note; the two event ids name the drawings before and after. */
export type DayInkChange = { added: number; erased: number; before_event: string | null; after_event: string };

/** One edit of one of a note's drawings (its handwriting page or its whiteboard's pen layer): a run of saves by one actor. */
export type InkEdit = DayInkChange & { id: string; changed_at: string; actor_name: string | null; actor_kind: "human" | "agent" | "system" | "session"; saves: number };

export type DayNote = {
  id: string;
  title: string;
  /** The space the note lives in (null: not in any space). */
  space_id: string | null;
  edits: number;
  first_at: string;
  last_at: string;
  actors: HistoryActor[];
  created: boolean;
  /** null when either body is no longer stored. */
  change: DayNoteChange | null;
  /** What the day drew and erased on the note's handwriting page; null when it did not change it. */
  ink: DayInkChange | null;
  /** The same for the note's whiteboard pen layer. */
  board_ink: DayInkChange | null;
};

/** One agent's run of writes in a day, with the notes it touched (paragraph counts). */
export type DayAgentRun = {
  run_id: string;
  agent_name: string;
  started_at: string;
  summary: string;
  notes: Array<{ id: string; title: string; space_id: string | null; added: number; changed: number; removed: number;
    /** The run made this note: there is no earlier text, so an undo leaves it alone. */
    created?: boolean }>;
  undone: boolean;
};

/** A rewind in the feed. `to` is the instant it went back to, `at` when it was done. */
export type DayRewind = {
  rewind_id: string;
  to: string;
  at: string;
  /** "" for a session (then `actor_kind` is 'session') and for someone this server no longer knows (then the kind its event recorded). */
  actor_name: string;
  actor_kind: "human" | "agent" | "session";
  notes: Array<{ id: string; title: string; space_id: string | null; kind: "restore" | "undelete" | "delete" }>;
  undone: boolean;
};

/** 「系統整理」: one pass of the system over notes' text that no person edited (moving old paragraph marks out of the
 *  text, or back). One row per pass, never a row per note; the notes are the ones the reader may read. */
export type DayTidy = {
  /** Which pass (a conversion_batch of the events): the one row of the day for it. */
  batch: string;
  at: string;
  kind: "marks_moved_out" | "marks_written_back";
  notes: Array<{ id: string; title: string; space_id: string | null }>;
};

/** One day of the feed: only days with a change are sent. `end_at` is the day's last instant on the workspace clock
 *  (time zone and day start hour), so 「那天的樣子」 looks back to the boundary the day's list was cut with. */
export type FeedDay = {
  date: string;
  end_at: string;
  /** The day's newest notes, a page of them: `notes_total` is how many the day has in all, `edits_total` their edits. */
  notes: DayNote[];
  notes_total: number;
  edits_total: number;
  agent_runs: DayAgentRun[];
  rewinds: DayRewind[];
  system_tidies: DayTidy[];
};

export type Feed = {
  days: FeedDay[];
  /** The local day of the latest body save before the window, or null when there is none: where the next, older page
   *  ends. A hint, not a promise: that save may belong to an edit that ends inside the window, so the page it leads to
   *  can come back empty (and then names a further day). */
  earlier_day: string | null;
};

/** A page of one day's notes (GET /api/history/day/notes). */
export type DayNotes = { notes: DayNote[]; notes_total: number; edits_total: number };

/** Paragraph numbers, then → now. */
type AtChange = ChangeSummary;

/** A note that differs from now (those that are the same are only counted). */
export type AtNote = {
  id: string;
  title_then: string;
  title_now: string;
  space_id: string | null;
  status: Exclude<NoteStatus, "same">;
  /** Only for `changed` notes, and only the first few. */
  change: AtChange | null;
  /** In 最近刪除 now; only a rewind asks for the notes that are (the feed's preview never lists them). */
  trashed_now?: true;
  /** Already in 最近刪除 at T; listed with status `same`, again only for a rewind. */
  trashed_then?: true;
};

export type WorkspaceAt = {
  at: string;
  counts: Record<NoteStatus, number> & { total: number };
  /** Everything that differs from now; notes that are the same are only counted. */
  notes: AtNote[];
};
