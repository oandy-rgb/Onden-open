// The messages between the page and the browser app's worker (the backend running in a Web Worker,
// docs/architecture/browser-app.md). Types only plus the few names both sides must spell the same;
// the page side is packages/frontend/src/browserApp/, the worker side packages/backend/src/browser/.

/** One /api request from the page: a plain copy of fetch's Request (headers as pairs, body as bytes). */
export type BridgeRequest = {
  id: number;
  method: string;
  /** Path and query, e.g. "/api/nodes?x=1" (the page's own origin is dropped). */
  path: string;
  headers: Array<[string, string]>;
  body: ArrayBuffer | null;
};

/** How much of the last few seconds a closed tab can lose, and where the copy lives. */
export type BridgeSaveState = {
  /** Where the saved copy is kept: "opfs" (a file), "indexeddb" (Safari without usable file access), "none" (private window: nothing is kept). */
  store: "opfs" | "indexeddb" | "none";
  /** Epoch ms of the last copy that reached the store, or null before the first one. */
  lastSavedAt: number | null;
  /** What the last copy cost, for the person who wants to know why a page paused: milliseconds to make and write it, and its size. */
  lastCopyMs: number | null;
  lastCopyBytes: number | null;
  /** Changes made since that copy. */
  unsaved: boolean;
  /** Writes that changed the database since the page opened. Only the temporary session reads it (it keeps no copy, so
   *  "unsaved" never goes back to false there): the page compares it with the count at its last download. */
  changes: number;
  /** The store refused the last write (full, blocked): the page tells the person, since changes can be lost. */
  failed: boolean;
  /** Whether each change is also logged before it is applied (an IndexedDB journal); false = only the copy protects a change. */
  journal: boolean;
  /** Changes that were too large to log (they are covered by the next copy only). */
  journalSkipped: number;
};

/** Why the worker could not start, so the page can say the right thing. */
export type BootFailureKind = "newer-copy" | "upgrade-failed" | "other";

/** What the start did to the saved copy, for one short line to the person. */
export type BootReport = {
  /** Migrations applied to an older saved copy. */
  upgraded: number;
  /** Logged changes that a closed page had not yet put in a copy: found again / could not be applied. */
  recovered: number;
  recoveryFailed: number;
};

export type ToWorker =
  | ({ t: "request" } & BridgeRequest)
  /** The page is going away or hidden: save now. */
  | { t: "flush"; id: number }
  /** A reader gave up (an EventSource closed). */
  | { t: "cancel"; id: number }
  /** Throw the saved copy away and start from the packaged snapshot (「重新開始」). */
  | { t: "reset"; id: number }
  /** The saved copy as it is stored (a database image, not notes): the way out when it cannot be opened. Works after a failed start. */
  | { t: "export-copy"; id: number }
  /** Take the file another device made into this (empty) copy. The File itself crosses (a Blob is not copied into memory); the answer is one `join-result`. */
  | { t: "join-file"; id: number; file: Blob };

export type FromWorker =
  | ({ t: "ready"; firstOpen: boolean; bootMs: number; store: BridgeSaveState["store"]; seeded: boolean;
      /** A temporary session (`?temp=1`): nothing is kept anywhere; `welcomeNoteId` is its blank first note. */
      temporary: boolean;
      /** The welcome sample note, only on the open that made the samples (the page lands on it once); else null. */
      welcomeNoteId: string | null } & BootReport)
  /** While the start runs the changes a closed page left in the log: how many are done of how many (the opening screen says so). */
  | { t: "replay-progress"; done: number; total: number }
  | { t: "boot-failed"; kind: BootFailureKind; message: string }
  | { t: "copy"; id: number; data: ArrayBuffer | null }
  | { t: "head"; id: number; status: number; statusText: string; headers: Array<[string, string]> }
  | { t: "chunk"; id: number; data: ArrayBuffer }
  | { t: "end"; id: number }
  | { t: "failed"; id: number; message: string }
  | { t: "done"; id: number }
  | { t: "save-state"; state: BridgeSaveState }
  /** While a file is being taken in: how much of it has been read. */
  | { t: "join-progress"; id: number; readBytes: number; totalBytes: number }
  /** The end of a `join-file`: taken in and saved here, or refused (`error` is the backend's code, null when it gave none). */
  /** `history`: where the notes' earlier versions are (`arriving`: not all in: the same file again goes on; `missing`: this device has none, the file did not bring them); `historyScope`: `body` when only the text history is
   *  kept (the browser version over the drawings' threshold); `historyLeftOut`: versions the other device holds without their content; `historyRefused`: why the
   *  earlier versions stopped coming (a code; the notes are in either way). Backend services/stampedSnapshotStream.ts SnapshotTaken. */
  | { t: "join-result"; id: number; ok: true; pages: number; rows: number; history: "done" | "arriving" | "missing"; historyScope: "all" | "body"; historyLeftOut: number; historyRefused: string | null }
  | { t: "join-result"; id: number; ok: false; status: number; error: string | null; detail: string | null };

/** Temporary mode: the page is opened with `?temp=1` and hands the same parameter to the worker. Nothing of the session
 *  is kept in this browser (docs/architecture/browser-app.md §17). */
export const BROWSER_APP_TEMP_PARAM = "temp";

/** The page's language (a BCP 47 tag), handed to the worker of a temporary session: a worker is not reliably told the
 *  browser's language, and the blank first note is stored with the placeholder title of that language. */
export const BROWSER_APP_LANG_PARAM = "lang";


/** What a temporary session may hold in uploaded files (they live in memory). Past it a new file is refused with a plain
 *  sentence; the notes themselves are not limited. */
export const TEMP_SESSION_MEDIA_LIMIT_BYTES = 200 * 1024 * 1024;

/** The one tab that may run the browser app at a time (Web Locks): two workers writing one saved copy would lose edits. */
export const BROWSER_APP_LOCK = "onden-browser-app-owner";

/** Paths the worker answers itself instead of the backend (under /api/, which is what the page sends to the worker). */
export const BROWSER_APP_STATE_PATH = "/api/browser-app/state";
export const BROWSER_APP_CLEAR_SAMPLES_PATH = "/api/browser-app/clear-samples";

/** The uploaded files the browser holds: how many, how many bytes, and where ("none": nowhere, uploads are refused). */
export type BrowserAppMedia = { files: number; bytes: number; store: BridgeSaveState["store"] };

/** Answer of BROWSER_APP_STATE_PATH: the save state, how many sample notes are still there, and the uploaded files. */
export type BrowserAppState = BridgeSaveState & {
  sampleNotes: number;
  /** A one-way name (SHA-256) of this copy's own node id (never the id): two copies are different nodes when these differ. Only answered to `?node=1`; null otherwise. */
  ownNode: string | null;
  media: BrowserAppMedia;
  temporary: boolean;
};
