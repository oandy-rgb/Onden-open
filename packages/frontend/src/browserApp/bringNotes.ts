// "Bring notes from another device" on the browser version: what this browser remembers between page loads so that a page killed in
// the middle of taking a file in still knows what it was doing. The screen is BringNotes.tsx; the file is made by
// settings/DeviceFileSetting.tsx on the device that has the notes.
//
//   (nothing)  an ordinary start
//   "pending"  the person chose to bring notes: the next start opens that screen on an EMPTY copy (no sample notes)
//   "joining"  a file was being taken in. Still here at the next start = the page was closed or killed before it finished; the
//              backend leaves an empty copy in that case (services/stampedJoin.ts), and the screen says so.
// Cleared when the notes arrived, or when the person goes on without them.

import { BROWSER_INK_HISTORY_LIMIT_BYTES } from "@onden/markdown/contract";
import { confirmDialog } from "../components/ConfirmDialog";
import { holdsSummary, type JoinHolds, type SnapshotReadiness } from "../lib/deviceFile";
import { t } from "../lib/i18n";
import { PREFS, getPref, removePref, setPref } from "../lib/prefs";

type BringState = "pending" | "joining";

export function readBringState(): BringState | null {
  const value = getPref(PREFS.bringNotes);
  return value === "pending" || value === "joining" ? value : null;
}

export function writeBringState(state: BringState | null): void {
  if (state === null) removePref(PREFS.bringNotes); else setPref(PREFS.bringNotes, state);
}

/** Room the browser needs for a file's notes, as a guard before reading it (not a measurement of every case): the notes are kept as a copy
 *  of the whole database (about 64 MB for a copy that holds a handful of notes, `lastCopyBytes` in the state the worker reports) which is
 *  written next to the copy already saved, and the file's lines grow to roughly this much once they are rows and indexes. */
const ROOM_FACTOR = 3;
const DATABASE_COPY_BYTES = 128 * 1024 * 1024;

export const roomNeeded = (keptBytes: number): number => keptBytes * ROOM_FACTOR + DATABASE_COPY_BYTES;

export function lacksRoom(keptBytes: number, free: number | null): boolean {
  return free !== null && roomNeeded(keptBytes) > free;
}

/** The last line of a file is at most this far from its end (its digests are counts and hashes: a few KB). */
const LAST_LINE_BYTES = 1024 * 1024;

/** How much of the file this browser will keep, from the file's last line (its `bytes`, services/stampedSnapshotStream.ts): the notes part unless the notes are
 *  here already (`notesHere`: they are not written again), and the earlier versions without the drawings' ones when they are over the browser's threshold
 *  (spine/stampedImport.ts keeps the text history only then). A file without that line (cut short, or made before it was written) counts whole. */
export async function keptBytesOf(file: Blob, notesHere: boolean): Promise<number> {
  try {
    const last = (await file.slice(Math.max(0, file.size - LAST_LINE_BYTES)).text()).trimEnd().split("\n").pop() ?? "";
    const end = JSON.parse(last) as { kind?: unknown; bytes?: { rows?: unknown; history?: unknown }; history?: { inkBytes?: unknown } };
    const rows = end.bytes?.rows, history = end.bytes?.history, ink = end.history?.inkBytes;
    if (end.kind !== "manifest" || typeof rows !== "number" || typeof history !== "number") return file.size;
    const drawings = typeof ink === "number" && ink > BROWSER_INK_HISTORY_LIMIT_BYTES ? Math.min(ink, history) : 0;
    return (notesHere ? 0 : rows) + history - drawings;
  } catch {
    return file.size;
  }
}

/** The one question before this copy is emptied for a file: the erase is the same ("Start over") whatever was found, and the words say what the
 *  backend counted (`holds`, from GET /api/snapshot/readiness: the same judgement the join itself uses), never a guess of the page's own. */
export const confirmEraseEverything = (holds: JoinHolds): Promise<boolean> => {
  const what = holdsSummary(holds);
  return confirmDialog(
    `${t("Erase everything on this device, including the trash, tags and added files, and keep it empty for the file? This cannot be undone.")}${what ? ` ${t("Right now that is: {what}.", { what })}` : ""}`,
    { confirmLabel: t("Erase and continue"), danger: true });
};

/** The refusals after which the backend has given the join up and the copy is the empty one it was before (the others — a join already done or
 *  running, not the owner, no sign-in — say nothing about what the copy holds, so the screen does not claim it is empty). */
const GAVE_UP = new Set(["join_digest_mismatch", "join_incomplete", "join_source_failed", "join_bad_line", "join_line_too_long", "join_no_body", "join_not_kept",
  "join_column_not_carried", "join_table_not_carried", "join_sign_in_not_carried", "join_layer_not_done", "join_bad_cut", "join_bad_page", "join_order", "join_page_changed",
  "join_page_extra", "join_page_missing", "join_person_missing", "join_stamp_conflict", "join_stamp_from_this_node", "join_stamp_label", "join_stamp_number", "join_stamp_origin",
  "join_unstamped_rows", "join_wrong_cut", "join_wrong_source", "join_wrong_workspace", "join_not_started", "join_from_self", "join_stamp_saw", "join_origin_is_this_node", "join_bad_brought", "join_wrong_brought", "join_stamp_beyond_cut", "join_stamp_beyond_brought", "join_stamp_shape", "join_head_shape", "join_data_shape", "join_bad_former", "join_bad_source", "join_stamp_beyond_former", "join_wrong_former"]);
export const joinGaveUp = (code: string | null): boolean => code === null || GAVE_UP.has(code);

/** What the screen says of a device whose notes a file already brought, read from the database (GET /api/snapshot/readiness), never from what the
 *  last answer seemed to say: after a refusal, a cut file or a page opened again the words are the database's state. `reason`: why the last file
 *  did not finish, in words. Null: no file filled this device (the screen is the ordinary one). */
type JoinedDevicePhase =
  | { kind: "done"; textOnly: boolean; leftOut: number }
  | { kind: "notes-in"; reason: string | null }
  | { kind: "no-history"; reason: string | null };

export function joinedDevicePhase(readiness: SnapshotReadiness | null, reason: string | null = null): JoinedDevicePhase | null {
  if (readiness === null || readiness.ready || !("holds" in readiness)) return null;
  if (readiness.code === "join_history_arriving") return { kind: "notes-in", reason };
  if (readiness.code === "join_history_missing") return { kind: "no-history", reason };
  if (readiness.code === "join_already_done") return { kind: "done", textOnly: readiness.history?.scope === "body", leftOut: readiness.history?.leftOut ?? 0 };
  return null;
}
