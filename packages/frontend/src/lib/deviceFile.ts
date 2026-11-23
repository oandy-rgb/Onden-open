// "Take my notes to another device" through one file (Settings › 你的資料 › 帶到另一台裝置; backend routes/stampedSnapshot.ts).
// This file is the device that HAS the notes: it asks for the file and writes it to disk a piece at a time. The device that
// receives it is browserApp/BringNotes.tsx (the browser version only).
//
// What the file holds today: the notes with their tags, properties, links, tasks, views, handwriting and layout — every row's
// source mark included — and then their earlier versions (the backend's "rows" layer and its history part, services/stampedSnapshot.ts).
// NOT yet: pictures and files added to notes, and the operation log. Screens say so (sentences in DeviceFileSetting).

import { t } from "./i18n";
import { todayId } from "./localDate";
import { ApiError, readErrorBody } from "./api";
import { reads } from "./data";

/** The codes a refused or interrupted import carries (`{ error: code, detail }`), so a screen can say what happened: the codes of backend
 *  `spine/stampedImport.ts` and `services/stampedSnapshotStream.ts`, `workspace_joining` (ordinary writes wait while a join runs), `snapshot_*`
 *  (the making side) and `join_not_kept` (the browser worker: the notes were taken in but the browser would not store them). Here and not in
 *  the shared contract: only these two screens need it, and the boot JS should not carry a list of sentences' codes. */
const DEVICE_FILE_REFUSALS = [
  "join_stamp_saw",
  "join_origin_is_this_node",
  "join_bad_brought",
  "join_wrong_brought",
  "join_stamp_beyond_cut",
  "join_stamp_beyond_brought",
  "snapshot_source_joining",
  "snapshot_source_unsettled",
  "snapshot_too_many_origins",
  "join_stamp_shape",
  "join_bad_former",
  "join_bad_source",
  "join_stamp_beyond_former",
  "join_wrong_former",
  "join_data_shape",
  "fresh_proof_wrong_password",
  "fresh_proof_no_password",
  "fresh_proof_password_needed",
  "fresh_proof_required",
  "fresh_proof_invalid",
  "fresh_proof_expired",
  "fresh_proof_used",
  "fresh_proof_locked",
  "join_head_shape",
  "join_not_empty",
  "join_person_not_owner",
  "join_no_login",
  "workspace_joining",
  "join_in_progress",
  "join_already_done",
  "join_from_self",
  "join_digest_mismatch",
  "join_incomplete",
  "join_source_failed",
  "join_bad_line",
  "join_line_too_long",
  "join_no_body",
  "join_not_kept",
  "join_column_not_carried",
  "join_table_not_carried",
  "join_sign_in_not_carried",
  "join_layer_not_done",
  "join_bad_cut",
  "join_bad_page",
  "join_order",
  "join_page_changed",
  "join_page_extra",
  "join_page_missing",
  "join_person_missing",
  "join_stamp_conflict",
  "join_stamp_from_this_node",
  "join_stamp_label",
  "join_stamp_number",
  "join_stamp_origin",
  "join_unstamped_rows",
  "join_wrong_cut",
  "join_wrong_source",
  "join_wrong_workspace",
  "join_not_started",
  "snapshot_foreign_origin",
  "snapshot_since_not_done",
  "snapshot_layer_not_done",
  "snapshot_failed",
  "join_history_hash",
  "join_history_shape",
  "join_history_clash",
  "join_history_unknown_note",
  "join_history_order",
  "join_history_digest_mismatch",
  "snapshot_source_history_incomplete",
  "snapshot_history_cut",
  "join_history_content_gone",
  "join_history_other_file",
  "join_history_not_arriving",
  "join_history_arriving",
  "snapshot_source_history_missing",
  "join_history_missing",
  "join_history_other_source",
  "join_history_not_missing",
  "join_history_file_cut",
  "join_history_source_failed",
] as const;

export type DeviceFileWrite = { bytes: number; how: "chosen-place" | "download" };

type PickerWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FileSystemFileHandle>;
};

/** Where the file goes: a place the person chooses (Chromium on a computer: written straight to disk, nothing gathered in memory),
 *  or the browser's own download (gathered as pieces of a Blob, which the browser keeps on disk when it is large). */
async function chooseSink(name: string): Promise<{ write(piece: Uint8Array): Promise<void>; finish(): Promise<DeviceFileWrite["how"]>; abort(): Promise<void> } | "cancelled"> {
  const picker = (window as PickerWindow).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker.call(window, { suggestedName: name, types: [{ description: "Onden", accept: { "application/octet-stream": [".onden"] } }] });
      const writable = await handle.createWritable();
      return {
        write: (piece) => writable.write(piece as unknown as FileSystemWriteChunkType),
        finish: async () => { await writable.close(); return "chosen-place"; },
        // A half-written file is no use to anyone: take it away where the browser lets us.
        abort: async () => { await writable.abort().catch(() => {}); await (handle as FileSystemFileHandle & { remove?: () => Promise<void> }).remove?.().catch(() => {}); },
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
      // The browser would not open a picker now (no recent tap, a frame): the ordinary download below.
    }
  }
  const blobs: Blob[] = [];
  let batch: Uint8Array[] = [];
  let batchBytes = 0;
  const seal = () => { if (batch.length) { blobs.push(new Blob(batch as BlobPart[])); batch = []; batchBytes = 0; } };
  return {
    write: async (piece) => { batch.push(piece); batchBytes += piece.byteLength; if (batchBytes >= 8 * 1024 * 1024) seal(); },
    finish: async () => {
      seal();
      const { downloadBlob } = await import("./download");
      downloadBlob(new Blob(blobs, { type: "application/octet-stream" }), name);
      return "download";
    },
    abort: async () => { blobs.length = 0; batch = []; },
  };
}

/** The refusal of one of this feature's codes as an `ApiError`, WITHOUT the backend's English detail: serverErrors shows a detail as it is
 *  in an English page, and these details name tables and kinds of rows ("(events of a person)", "content_nodes (rows, +3)"). */
export function deviceFileRefusal(status: number, code: string | null, rawBody: string): ApiError {
  return (DEVICE_FILE_REFUSALS as readonly string[]).includes(code ?? "") ? new ApiError(status, JSON.stringify({ error: code })) : new ApiError(status, rawBody);
}

/** Keeps the last line of a stream (not the stream) so it can be parsed whole: the manifest carries a digest of every table and is long, but a line
 *  longer than this is not a manifest. A snapshot that gave up half way ends with an `error` line, not the manifest. */
const MAX_LAST_LINE_CHARS = 8 * 1024 * 1024;
class LastLine {
  private done = "";
  private current = "";
  private overflow = false;
  push(text: string): void {
    text.split("\n").forEach((part, at) => {
      if (at > 0) { if (this.current.length > 0 || this.overflow) this.done = this.overflow ? "" : this.current; this.current = ""; this.overflow = false; }
      if (this.current.length + part.length > MAX_LAST_LINE_CHARS) this.overflow = true; else this.current += part;
    });
  }
  /** The last non-empty line. */
  text(): string { return this.current.length > 0 || this.overflow ? (this.overflow ? "" : this.current) : this.done; }
}

/** Each line is parsed and judged by its own `kind`, whatever order its keys are in. */
const endsWithManifest = (last: LastLine): boolean => {
  try { return (JSON.parse(last.text()) as { kind?: unknown }).kind === "manifest"; } catch { return false; }
};

/** Ask for the file and write it. Resolves with what was written, `"cancelled"` when the person closed the place picker, and throws an
 *  `ApiError` (a refusal worded by serverErrors; `fresh_proof_*` means confirm again) or an `Error("incomplete")` when the file did not come out whole. `onProgress` gets the bytes written so far. */
export async function makeDeviceFile(freshProofTicket: string, onProgress: (bytes: number) => void, signal?: AbortSignal): Promise<DeviceFileWrite | "cancelled"> {
  // The place first, before the request for the file. The browser opens its picker only shortly after a tap, and the confirmation (a request for the
  // ticket) has already taken some time since the tap: on a slow connection the picker is refused and the file is gathered as pieces of a Blob and handed
  // to the browser's download. That path keeps the file in memory as long as the browser holds the Blob (it may move a large one to disk, which was not
  // measured: only a 3.5 MB file was tried), so a very large workspace is best made on a computer, where the picker usually opens.
  const sink = await chooseSink(`${t("Onden notes")} ${todayId()}.onden`);
  if (sink === "cancelled") return "cancelled";
  try {
    const response = await reads.workspace.deviceFile(freshProofTicket, signal);
    if (!response.ok || !response.body) {
      const body = await readErrorBody(response);
      let code: string | null = null;
      try { code = (JSON.parse(body) as { error?: string }).error ?? null; } catch { /* not JSON: an ordinary ApiError */ }
      throw deviceFileRefusal(response.status, code, body);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const last = new LastLine();
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await sink.write(value);
      bytes += value.byteLength;
      last.push(decoder.decode(value, { stream: true }));
      onProgress(bytes);
    }
    if (!endsWithManifest(last)) throw new Error("incomplete");
    return { bytes, how: await sink.finish() };
  } catch (error) {
    await sink.abort();
    throw error;
  }
}

/** What a join would erase from this device, by kind (backend `JoinRemoval`): counts only. */
export type JoinHolds = { own_notes: number; trash: number; own_tags: number; spaces: number; files: number; prefs: number };

/** The backend's answer to "would you take a file now" (GET /api/snapshot/readiness): `kind` is a stable code of what stands in the way, never text. */
export type SnapshotReadiness =
  | { ready: true; holds: JoinHolds }
  | { ready: false; code: "join_in_progress" }
  | { ready: false; code: string; kind: string | null; holds: JoinHolds; history?: { scope: "all" | "body"; leftOut: number } };

/** The readiness that says "not ready, because of what is on this device" (not "a join is running"): the one that carries the counts. */
type NotEmptyReadiness = Extract<SnapshotReadiness, { holds: JoinHolds; ready: false }>;
export const isNotEmpty = (readiness: SnapshotReadiness | "unknown" | null): readiness is NotEmptyReadiness => readiness !== null && readiness !== "unknown" && !readiness.ready && "holds" in readiness;

/** What would be erased, in the person's words ("3 notes, 2 in the trash, 1 tag"), or null when the counts are all zero. */
export function holdsSummary(holds: JoinHolds): string | null {
  const parts = [
    holds.own_notes > 0 ? t("{n} notes", { n: holds.own_notes }) : null,
    holds.trash > 0 ? t("{n} in the trash", { n: holds.trash }) : null,
    holds.own_tags > 0 ? t("{n} tags", { n: holds.own_tags }) : null,
    holds.spaces > 0 ? t("{n} spaces", { n: holds.spaces }) : null,
    holds.files > 0 ? t("{n} pictures and files", { n: holds.files }) : null,
    holds.prefs > 0 ? t("your settings") : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(t(", ")) : null;
}
