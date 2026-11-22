// Restoring from a backup file: how it runs and what it reports.
// Pure types: the app imports them with `import type`, so nothing here may run.

export type RestoreMode = "empty" | "merge" | "workspace";

/** "Put everything under one new note" (merge mode only): the way a session written on a borrowed computer arrives.
 *  `id` makes the parent the same note on every import of the same session: a second import finds it and adds to it. */
export type RestoreParentNote = { title: string; id?: string };

export type RestoreReport = {
  event_id: string;
  created: number;
  /** A note of this session whose text was written further since an earlier import: the earlier one was updated in place
   *  (only when nobody edited it here since; otherwise a copy is added as always). Only with a parent note. */
  superseded: number;
  /** The note everything landed under (a parent note was asked for); null otherwise. */
  parent_note_id: string | null;
  copies: number;
  unchanged: number;
  in_history: number;
  deleted_again: number;
  tags_created: number;
  attachments_written: number;
  /** Tasks brought back (host-note tasks, line tasks and standalone ones; they are also counted in created / copies). */
  tasks: number;
  /** Saved views brought back (of notes and of tags the restore made). */
  views: number;
  /** What the backup held and the restore left out, one by one (a tag the restorer may not apply, a value
   *  its field refuses, a task whose note is gone, an attachment that was too large or unreadable); the rest of the
   *  restore went through. The restore screen lists every non-zero count in words. */
  skipped: {
    tags: number; attributes: number; links: number; positions: number; tag_settings: number;
    /** Tasks whose note is not here (deleted, unreadable or not writable): there is nowhere to put them. */
    tasks: number;
    /** Old tag automation (on_apply, on_remove, on_attribute_change rules) a backed-up tag still carried: the feature
     *  is gone, so the rules are not brought back; counted per rule. */
    tag_automation: number;
    /** Saved views that could not be written (an unknown kind, a name the note already had, a refused write). */
    views: number;
    /** Functions a tag provides (with their settings) that could not be put back: the tag's definition is the owner's, or the tag is not here. */
    functions: number;
    /** Sidebar shortcuts to a note that could not be put back (one already there, or a refused write). Absent in a report written by a
     *  server from before shortcuts were in backups. */
    pointers?: number;
    /** Attachments over the size a file of its type may have. */
    attachments_too_large: number;
    /** Attachments of a type that is not allowed, or whose bytes are damaged. */
    attachments_unreadable: number;
    /** Attachments missing from the disk that the restorer may not refill (another person's upload). */
    attachments_not_yours: number;
  };
  /** A workspace move (mode "workspace"): what was made and carried, and what needs the person; null otherwise. */
  moved: null | {
    spaces_created: number;
    /** Shared spaces that had other people; their members are not rebuilt. */
    need_reinvite: string[];
    carried: { review: number; focus: number; rss: number; prefs: number; moduleSettings: number; modules: boolean; site: boolean };
    cleared: { notes: number; tags: number };
    not_moved: string[];
    /** The backup held version history (format 3): how much came along, and the titles of notes whose history did not
     *  (a damaged version, text that does not match its hash); null when the backup held none. */
    history: null | { notes: number; versions: number; failed: string[] };
  };
};

/** How much version history a backup holds or would add (the manifest's `history`, GET /api/backup/history-size, a workspace move's preview). `bytes` is the size of the versions' text, before the zip compresses it. */
export type BackupHistoryInfo = { notes: number; versions: number; bytes: number };

/** What a backup file says about itself (`.onden/manifest.json`): what the server writes today, and so what it sends back
 *  after an upload. A file from an older version may lack newer keys; the app reads those through its own
 *  BackupManifestAsRead (lib/data/backupRestore.ts), which the server's reader does not normalise (services/backupFile.ts). */
export type BackupManifest = {
  format: "onden-backup";
  version: number;
  created_at: string;
  workspace_id: string;
  created_by: { id: string; name: string };
  counts: {
    notes: number;
    deleted_notes: number;
    tags: number;
    tasks: number;
    canvases: number;
    drawings: number;
    attachments: number;
    spaces: number;
  };
  /** Format 3 only: the version history section (`.onden/history/<note id>.jsonl`). Absent = none, and the version is 2. */
  history?: BackupHistoryInfo;
};

/** What a workspace move would make, bring and clear (mode "workspace"). */
export type RestoreMovePreview = {
  spaces: Array<{ name: string; kind: "personal" | "shared"; notes: number; had_others: boolean }>;
  /** What comes along besides the notes; only kinds with something in them. */
  carries: Array<{ kind: "progress" | "focus_records" | "feeds" | "settings" | "features" | "site"; count: number }>;
  clears: { notes: number; tags: number };
  /** Version history the backup holds, which the move carries; null when it has none. */
  history: BackupHistoryInfo | null;
  /** Said after a move, listed here so the person knows before. */
  not_moved: string[];
};

/** What a restore would do, before it runs (GET /api/backup/restore/:id/preview). */
export type RestorePreview = {
  mode: RestoreMode;
  target: { id: string; name: string; kind: string; notes: number };
  manifest: BackupManifest;
  /** The file has history files (counted from its entries, not the manifest's claim). */
  holds_history: boolean;
  /** null when the restore may run; otherwise why not. */
  refusal: null | "target_not_empty" | "workspace_not_new" | "not_workspace_owner";
  /** The parent note everything lands under, when one was asked for; `exists`: the same session's parent is already here. */
  new_parent: null | { title: string; exists: boolean };
  counts: {
    notes_new: number;
    notes_new_deleted: number;
    notes_unchanged: number;
    notes_conflict: number;
    /** A note of the session updated in place. */
    notes_updated: number;
    notes_in_history: number;
    /** Notes that took a new id because their own is taken (in the trash, in another workspace, or a note the restorer cannot read): restored as the backup had them. */
    notes_new_id: number;
    /** Notes whose id is a live note the restorer can read here: added next to it as a second copy, kept off the website. */
    notes_second_copy: number;
    tasks: number;
    tags_existing: number;
    tags_new: number;
    attachments_new: number;
    attachments_existing: number;
  };
  /** Same id, different content: the current note stays, a copy is added. */
  conflicts: Array<{ id: string; title: string }>;
  /** Added beside a current note of the same title under the same parent. */
  title_clashes: Array<{ id: string; title: string }>;
  /** A sample of the notes that will be added. */
  new_notes: Array<{ id: string; title: string; deleted: boolean }>;
  /** A workspace move: the spaces made again, what is carried and cleared. */
  move: RestoreMovePreview | null;
};

type RestoreJobPhase = "queued" | "reading" | "attachments" | "tags" | "notes" | "history" | "links" | "positions" | "deleted" | "done";

/** What GET /api/backup/restore/jobs/:id answers. */
export type RestoreJob = {
  id: string;
  upload_id: string;
  space_id: string;
  mode: RestoreMode;
  status: "running" | "done" | "failed";
  phase: RestoreJobPhase;
  done: number;
  total: number;
  /** The BACKUP_RESTORED event, once it committed. */
  event_id: string | null;
  /** Why it failed: a refusal's code (target_not_empty, insufficient_storage …), "interrupted", or "restore_failed". */
  error: string | null;
  error_status: number | null;
  /** A failure after a commit: the committed part was undone (its notes are in History). false with an event_id: undo it from History. */
  rolled_back: boolean;
  result: RestoreReport | null;
  /** A failed job that may be started again from its upload: nothing committed, the upload is still there, and it was not already restored. */
  retryable: boolean;
  created_at: string;
  updated_at: string;
};
