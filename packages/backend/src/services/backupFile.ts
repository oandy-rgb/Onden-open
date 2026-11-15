/// <reference path="../vendor/yauzl.d.ts" />
// A backup zip someone uploaded to restore (services/backupRestore.ts): kept
// on disk while they look at the preview, checked before anything reads it.
//
// The upload is streamed to a file under content/backup-uploads/, never held
// in memory, and refused past maxBackupUploadBytes() (16 GB, ONDEN_MAX_BACKUP_MB) or when the
// disk has no room for it. Opening it checks
// the whole central directory before any entry is read:
//   * the layout is exactly a backup's (services/backupArchive.ts): notes in
//     the root, in their parents' folders (D109; older backups are flat) or
//     .trash/, attachments/<media id>, .onden/notes/<uuid>.json,
//     the manifest, spaces.json, extras.json and README.txt — anything else (a path with
//     `..`, an absolute path, a backslash, a symlink, an unknown folder or file
//     type) refuses the whole file, so no entry name ever becomes a path on
//     disk except an attachment's, which is a media id (one safe segment);
//   * no entry is encrypted or named twice;
//   * sizes: at most MAX_ENTRIES entries, maxUncompressedBytes() in all, a
//     sidecar at most MAX_JSON_BYTES, an attachment at most its type's cap,
//     and no entry inflating more than MAX_RATIO times (a zip bomb). yauzl
//     checks while reading that an entry really is the size it declares.
// The manifest must name the backup format at a version this code reads.
//
// An upload belongs to the person who sent it: a different person asking for
// its id gets "not found". Uploads are dropped after a restore, when the same
// person uploads another (unless a restore job is reading it), after
// UPLOAD_TTL_MS, and — half-written bodies — at boot.

import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { open as openZip, type Entry, type ZipFile } from "yauzl";
import { DEFAULT_MAX_BACKUP_REQUEST_BYTES, UUID_SOURCE, isMediaId } from "@onden/markdown";
import { config } from "../config.js";
import { STORE } from "../git.js";
import { MIME, capFor } from "./mediaStore.js";
import { FREE_SPACE_MARGIN_BYTES } from "./mediaFiles.js";
import { BACKUP_FORMAT, BACKUP_VERSION, EXTRAS_PATH, MANIFEST_PATH, NOTE_SIDECAR_DIR, SPACES_PATH, type BackupNote, type BackupSpace } from "./backupArchive.js";
import { parseExtras, type BackupExtras } from "./backupExtras.js";
import type { BackupManifest } from "@onden/contract";
import { BACKUP_VERSION_WITH_HISTORY, HISTORY_DIR } from "./backupHistory.js";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

const UPLOAD_DIR = join(STORE, "backup-uploads");
const MB = 1024 * 1024;
/** Entries in one backup at most. */
export const MAX_ENTRIES = 200_000;
/** The largest backup upload: ONDEN_MAX_BACKUP_MB (self-hosters raise or lower it; nginx must state the same number),
 *  else DEFAULT_MAX_BACKUP_REQUEST_BYTES. The page asks for it (GET /api/backup/restore/limit). */
export function maxBackupUploadBytes(): number {
  const mb = config.int("ONDEN_MAX_BACKUP_MB", DEFAULT_MAX_BACKUP_REQUEST_BYTES / MB, { min: 1 });
  return mb * MB;
}
/** Bytes all entries inflate to, at most: what a backup at the upload cap may hold (attachments are stored nearly as they
 *  are, so twice the cap), and never less than 8 GB. */
export function maxUncompressedBytes(): number {
  return Math.max(8 * 1024 * MB, 2 * maxBackupUploadBytes());
}
/** One sidecar (a note's JSON, the manifest, spaces.json) at most; a note's
 *  Markdown file and README.txt too. */
export const MAX_JSON_BYTES = 64 * MB;
/** One note's history file at most (a long note saved thousands of times). */
export const MAX_HISTORY_BYTES = 1024 * MB;
/** One line of a history file (a version: its whole text, JSON-escaped) at most. The server sets no limit on a note's text;
 *  16 MB is far past any note a person writes (the browser app's own journal refuses a body above it). A longer line fails
 *  that note's history alone (entry_too_large) and is never held whole: the reader stops at the cap. */
export const MAX_HISTORY_LINE_CHARS = 16 * MB;
/** An entry larger than 1 MB may inflate at most this many times. (A history file is not held to it: the versions of one
 *  note are near copies of each other and compress far past it; its own cap and the total bound it.) */
const MAX_RATIO = 200;
/** How long an upload waits for its restore. */
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;

/** Why an uploaded file is not a backup this server restores. */
export type BackupFileProblem =
  | "backup_too_large" | "backup_no_room" | "not_zip" | "unsafe_entry" | "unexpected_entry" | "duplicate_entry"
  | "encrypted_entry" | "entry_too_large" | "too_many_entries" | "no_manifest"
  | "bad_manifest" | "newer_version" | "bad_note";

export class BackupFileError extends Error {
  readonly status: 400 | 413 | 507;
  constructor(readonly code: BackupFileProblem, readonly entry?: string) {
    super(entry ? `${code}: ${entry}` : code);
    this.name = "BackupFileError";
    this.status = code === "backup_too_large" ? 413 : code === "backup_no_room" ? 507 : 400;
  }
}

/** The restore does not fit the target: the space is gone or unknown
 *  (404), "empty" mode met a space with notes (409), a workspace move met a
 *  workspace that is not new (409 workspace_not_new) or a person who does not
 *  own it (403 not_workspace_owner), another restore is running into the
 *  space (409 restore_running), or the disk has no room for the attachments
 *  it would write (507). */
export class BackupRestoreRefusal extends Error {
  constructor(
    readonly code: "space_not_found" | "target_not_empty" | "insufficient_storage" | "restore_running" | "workspace_not_new" | "not_workspace_owner" | "bad_request",
    readonly status: 400 | 403 | 404 | 409 | 507,
  ) {
    super(code);
    this.name = "BackupRestoreRefusal";
  }
}

/** The upload id is unknown, expired, or someone else's. */
export class BackupUploadNotFound extends Error {
  readonly status = 404 as const;
  constructor() { super("upload not found"); this.name = "BackupUploadNotFound"; }
}

const NOTE_JSON_RE = new RegExp(`^${NOTE_SIDECAR_DIR.replace(".", "\\.")}/(${UUID_SOURCE})\\.json$`);
// A vault file name: no control characters or backslash, in the root, in
// .trash/, or under its parent notes' folders (services/vaultPath.ts, D109:
// folder names don't start with a dot, so no folder is .onden/ or .trash/).
// The restore reads the sidecars, never these files, so both the flat
// layout of older backups and the nested one pass.
// eslint-disable-next-line no-control-regex
const MD_RE = /^(?:\.trash\/|(?:[^./\\\u0000-\u001f][^/\\\u0000-\u001f]*\/)*)[^/\\\u0000-\u001f]+\.md$/;
const DIRECTORIES = new Set(["attachments/", ".trash/", ".onden/", `${NOTE_SIDECAR_DIR}/`, `${HISTORY_DIR}/`]);
const HISTORY_RE = new RegExp(`^${HISTORY_DIR.replace(".", "\\.")}/(${UUID_SOURCE})\\.jsonl$`);
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

type EntryKind = "history" | "note" | "attachment" | "markdown" | "manifest" | "spaces" | "extras" | "readme" | "directory";

/** What a name may be in a backup, or null. Pure. */
export function backupEntryKind(name: string): EntryKind | null {
  if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || name.split("/").some((part) => part === ".." || part === ".")) return null;
  if (DIRECTORIES.has(name)) return "directory";
  if (name === MANIFEST_PATH) return "manifest";
  if (name === SPACES_PATH) return "spaces";
  if (name === EXTRAS_PATH) return "extras";
  if (name === "README.txt") return "readme";
  if (NOTE_JSON_RE.test(name)) return "note";
  if (HISTORY_RE.test(name)) return "history";
  if (name.startsWith("attachments/")) {
    const id = name.slice("attachments/".length);
    const ext = /\.[^.]+$/.exec(id)?.[0]?.toLowerCase() ?? "";
    return isMediaId(id) && MIME[ext] ? "attachment" : null;
  }
  if (MD_RE.test(name)) return "markdown";
  return null;
}

/** An opened, checked backup. Entries are read on demand, one at a time. */
export type BackupReader = {
  manifest: BackupManifest;
  spaces: BackupSpace[];
  /** The person's own state and the workspace's settings (format 2), or null. */
  extras: BackupExtras | null;
  /** Note ids with a sidecar, in archive order. */
  noteIds: string[];
  /** Notes with a history file (format 3), else empty. */
  historyNoteIds: Set<string>;
  /** Attachment media ids present. */
  attachments: Set<string>;
  readNote(id: string): Promise<BackupNote>;
  /** The lines of note `id`'s history file (backupHistory.ts), or null when it has none. Opens the entry anew on every call. */
  openHistory(id: string): AsyncIterable<string> | null;
  /** What the history files hold, counted by reading them (the manifest's own figures are not trusted). */
  countHistory(): Promise<{ notes: number; versions: number; bytes: number }>;
  /** A stream of attachment `mediaId` and its size. */
  openAttachment(mediaId: string): Promise<{ stream: Readable; size: number }>;
  /** The size attachment `mediaId` inflates to (0 when absent). */
  attachmentSize(mediaId: string): number;
  close(): void;
};

function openZipFile(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    openZip(path, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (err, zip) => {
      if (err) reject(new BackupFileError("not_zip"));
      else resolve(zip);
    });
  });
}

function allEntries(zip: ZipFile): Promise<Entry[]> {
  if (zip.entryCount > MAX_ENTRIES) return Promise.reject(new BackupFileError("too_many_entries"));
  return new Promise((resolve, reject) => {
    const entries: Entry[] = [];
    zip.on("entry", (entry) => { entries.push(entry); zip.readEntry(); });
    zip.on("end", () => resolve(entries));
    // yauzl's own refusals (an absolute or `..` name, a bad header) name the
    // entry in their message; the whole file is unsafe.
    zip.on("error", (err) => reject(/file name|relative path|absolute path|invalid characters/i.test(err.message)
      ? new BackupFileError("unsafe_entry", err.message) : new BackupFileError("not_zip")));
    zip.readEntry();
  });
}

function entryStream(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) { reject(new BackupFileError("not_zip", entry.fileName)); return; }
      // A stored (uncompressed) entry comes as fd-slicer's old-style stream,
      // which never ends under async iteration; piped, it is a plain one.
      const out = new PassThrough();
      // The data flows (and can fail: a corrupt entry, one longer than its
      // header says) before the caller starts reading — restoreMediaFile
      // stats the target first. The error then waits in `out` for the
      // reader (async iteration rethrows a stored error); without a listener
      // it would reach the process as an unhandled 'error' and stop it.
      out.on("error", () => {});
      stream.on("error", (error) => out.destroy(error));
      resolve(stream.pipe(out));
    });
  });
}

async function readEntryText(zip: ZipFile, entry: Entry): Promise<string> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of await entryStream(zip, entry)) chunks.push(chunk as Buffer);
  } catch (error) {
    if (error instanceof BackupFileError) throw error;
    // A size mismatch or a corrupt deflate stream.
    throw new BackupFileError("not_zip", entry.fileName);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** An entry's lines, a stream read a chunk at a time (no `node:readline`: the browser app has none); a damaged entry is
 *  `not_zip`, as for any other entry. */
async function* historyLines(zip: ZipFile, entry: Entry): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  // The pieces of the line being read: a newline is looked for in each new chunk only (never again in what came before),
  // so a very long line costs its own length, and one past the cap is refused as soon as it is seen.
  let parts: string[] = [];
  let length = 0;
  const tooLong = () => new BackupFileError("entry_too_large", entry.fileName);
  try {
    for await (const chunk of await entryStream(zip, entry)) {
      const text = decoder.decode(chunk as Uint8Array, { stream: true });
      let from = 0;
      for (;;) {
        const at = text.indexOf("\n", from);
        if (at < 0) { parts.push(text.slice(from)); length += text.length - from; break; }
        parts.push(text.slice(from, at)); length += at - from;
        if (length > MAX_HISTORY_LINE_CHARS) throw tooLong();
        const line = parts.join("");
        parts = []; length = 0; from = at + 1;
        yield line;
      }
      if (length > MAX_HISTORY_LINE_CHARS) throw tooLong();
    }
    const tail = decoder.decode();
    if (tail) { parts.push(tail); length += tail.length; }
  } catch (error) {
    if (error instanceof BackupFileError) throw error;
    throw new BackupFileError("not_zip", entry.fileName);
  }
  if (length > MAX_HISTORY_LINE_CHARS) throw tooLong();
  if (length > 0) yield parts.join("");
}

function parseJson<T>(text: string, code: BackupFileProblem, entry: string): T {
  try { return JSON.parse(text) as T; } catch { throw new BackupFileError(code, entry); }
}

const isString = (v: unknown): v is string => typeof v === "string";
const isNullableString = (v: unknown) => v === null || typeof v === "string";
// Checked before the restore writes anything: a bad date half way through
// would otherwise fail a batch after earlier ones committed.
const isTimestamp = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

/** Check a note sidecar's shape (what restore relies on). */
function checkedNote(raw: unknown, id: string, entry: string): BackupNote {
  const n = raw as Partial<BackupNote> | null;
  const ok = !!n && typeof n === "object" && n.id === id && isString(n.node_type) && ["content", TAG_NODE_TYPE, "canvas"].includes(n.node_type)
    && isString(n.title) && isString(n.markdown) && isNullableString(n.parent_id) && isNullableString(n.deleted_at)
    && isTimestamp(n.created_at) && isTimestamp(n.updated_at) && typeof n.hidden === "boolean"
    && Array.isArray(n.attributes) && n.attributes.every((a) => a && isString(a.key) && isString(a.value))
    && Array.isArray(n.tags) && n.tags.every(isString) && (n.media === undefined || (Array.isArray(n.media) && n.media.every(isString)));
  if (!ok) throw new BackupFileError("bad_note", entry);
  return { ...n, media: n.media ?? [] } as BackupNote;
}

/** Open and check the backup at `path` (see the module comment). Throws
 *  BackupFileError for anything that is not a restorable backup. */
export async function openBackup(path: string): Promise<BackupReader> {
  const zip = await openZipFile(path);
  try {
    const entries = await allEntries(zip);
    const byName = new Map<string, Entry>();
    let total = 0;
    for (const entry of entries) {
      const name = entry.fileName;
      const kind = backupEntryKind(name);
      if (kind === null) {
        throw new BackupFileError(/(^|\/)\.\.(\/|$)|^\/|\\/.test(name) ? "unsafe_entry" : "unexpected_entry", name);
      }
      if (((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK) throw new BackupFileError("unsafe_entry", name);
      if (byName.has(name)) throw new BackupFileError("duplicate_entry", name);
      if (entry.isEncrypted()) throw new BackupFileError("encrypted_entry", name);
      const cap = kind === "attachment" ? capFor(/\.[^.]+$/.exec(name)![0].toLowerCase()) : kind === "history" ? MAX_HISTORY_BYTES : MAX_JSON_BYTES;
      if (entry.uncompressedSize > cap) throw new BackupFileError("entry_too_large", name);
      if (kind !== "history" && entry.uncompressedSize > MB && entry.uncompressedSize > MAX_RATIO * Math.max(entry.compressedSize, 1)) {
        throw new BackupFileError("entry_too_large", name);
      }
      total += entry.uncompressedSize;
      if (total > maxUncompressedBytes()) throw new BackupFileError("backup_too_large");
      byName.set(name, entry);
    }
    const manifestEntry = byName.get(MANIFEST_PATH);
    if (!manifestEntry) throw new BackupFileError("no_manifest");
    const manifest = parseJson<BackupManifest>(await readEntryText(zip, manifestEntry), "bad_manifest", MANIFEST_PATH);
    if (manifest?.format !== BACKUP_FORMAT || typeof manifest.version !== "number") throw new BackupFileError("bad_manifest", MANIFEST_PATH);
    if (manifest.version > BACKUP_VERSION_WITH_HISTORY) throw new BackupFileError("newer_version", MANIFEST_PATH);
    // History is a format-3 section: a file that claims an older format and carries it is not one this code wrote.
    if (manifest.version < BACKUP_VERSION_WITH_HISTORY && [...byName.keys()].some((n) => HISTORY_RE.test(n))) throw new BackupFileError("unexpected_entry", HISTORY_DIR);
    const spacesEntry = byName.get(SPACES_PATH);
    const spaces = spacesEntry ? parseJson<BackupSpace[]>(await readEntryText(zip, spacesEntry), "bad_manifest", SPACES_PATH) : [];

    const extrasEntry = byName.get(EXTRAS_PATH);
    const extras = extrasEntry ? parseExtras(parseJson<unknown>(await readEntryText(zip, extrasEntry), "bad_manifest", EXTRAS_PATH)) : null;

    const noteIds: string[] = [];
    const attachments = new Set<string>();
    const historyNoteIds = new Set<string>();
    for (const name of byName.keys()) {
      const note = NOTE_JSON_RE.exec(name);
      const history = HISTORY_RE.exec(name);
      if (history) historyNoteIds.add(history[1]!);
      if (note) noteIds.push(note[1]!);
      else if (name.startsWith("attachments/") && !name.endsWith("/")) attachments.add(name.slice("attachments/".length));
    }
    return {
      manifest,
      spaces: Array.isArray(spaces) ? spaces : [],
      extras,
      noteIds,
      historyNoteIds,
      attachments,
      openHistory(id) {
        const entry = byName.get(`${HISTORY_DIR}/${id}.jsonl`);
        return entry ? historyLines(zip, entry) : null;
      },
      async countHistory() {
        let versions = 0, bytes = 0, notes = 0;
        for (const id of historyNoteIds) {
          let any = false;
          try {
            for await (const line of historyLines(zip, byName.get(`${HISTORY_DIR}/${id}.jsonl`)!)) {
              if (line === "") continue;
              any = true; versions++; bytes += Buffer.byteLength(line, "utf8");
            }
          } catch (error) {
            if (!(error instanceof BackupFileError)) throw error; // that note's history will fail alone when carried
          }
          if (any) notes++;
        }
        return { notes, versions, bytes };
      },
      async readNote(id) {
        const name = `${NOTE_SIDECAR_DIR}/${id}.json`;
        const entry = byName.get(name);
        if (!entry) throw new BackupFileError("bad_note", name);
        return checkedNote(parseJson(await readEntryText(zip, entry), "bad_note", name), id, name);
      },
      async openAttachment(mediaId) {
        const entry = byName.get(`attachments/${mediaId}`);
        if (!entry) throw new BackupFileError("bad_note", `attachments/${mediaId}`);
        return { stream: await entryStream(zip, entry), size: entry.uncompressedSize };
      },
      attachmentSize: (mediaId) => byName.get(`attachments/${mediaId}`)?.uncompressedSize ?? 0,
      close: () => zip.close(),
    };
  } catch (error) {
    zip.close();
    throw error;
  }
}

// ── Uploads ────────────────────────────────────────────────────────────────

type UploadMeta = { actor_id: string; created_at: number };

const zipPath = (id: string) => join(UPLOAD_DIR, `${id}.zip`);
const metaPath = (id: string) => join(UPLOAD_DIR, `${id}.json`);
const UUID_RE = new RegExp(`^${UUID_SOURCE}$`);

/** Uploads a restore job is reading (services/backupRestoreJobs.ts): no
 *  sweep drops them, however old, until the job lets go. In memory, as the
 *  jobs are. */
const inUse = new Set<string>();
export function holdUpload(uploadId: string): void { inUse.add(uploadId); }
export function releaseUpload(uploadId: string): void { inUse.delete(uploadId); }
export function uploadHeld(uploadId: string): boolean { return inUse.has(uploadId); }

/** Drop expired uploads and the earlier uploads of `actorId`; at boot
 *  (`actorId` null), also every half-written body: no upload is running. */
async function sweepUploads(actorId: string | null): Promise<void> {
  let names: string[];
  try { names = await readdir(UPLOAD_DIR); } catch { return; }
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const id = name.slice(0, -".json".length);
    if (inUse.has(id)) continue;
    const meta = await readFile(metaPath(id), "utf8").then((t) => JSON.parse(t) as UploadMeta).catch(() => null);
    if (!meta || meta.actor_id === actorId || Date.now() - meta.created_at > UPLOAD_TTL_MS) await discardUpload(id);
  }
  // A body that never got its meta (a failed upload, or one cut off by a restart).
  for (const name of names.filter((n) => n.endsWith(".zip.part"))) {
    const info = await stat(join(UPLOAD_DIR, name)).catch(() => null);
    if (info && (actorId === null || Date.now() - info.mtimeMs > UPLOAD_TTL_MS)) await rm(join(UPLOAD_DIR, name), { force: true });
  }
}

/** Boot: drop half-written and expired uploads (index.ts). */
export function sweepUploadsAtBoot(): Promise<void> {
  return sweepUploads(null);
}

const freeBytesOf = async (dir: string): Promise<number> => { const s = await statfs(dir); return s.bavail * s.bsize; };

/** Store an uploaded body for `actorId`, refusing it past the cap or when the disk has no room for it; then
 *  check it. Returns its id and the opened reader's manifest. A refused or
 *  broken file is not kept. `maxBytes` is the transport cap (default
 *  maxBackupUploadBytes()); `freeBytes` reads the free space of the upload folder's disk (tests). */
export async function stageBackupUpload(
  actorId: string, body: Readable, declaredBytes: number | null,
  { maxBytes = maxBackupUploadBytes(), freeBytes = freeBytesOf }: { maxBytes?: number; freeBytes?: (dir: string) => Promise<number> } = {},
): Promise<{ uploadId: string; manifest: BackupManifest; bytes: number }> {
  if (declaredBytes !== null && declaredBytes > maxBytes) throw new BackupFileError("backup_too_large");
  await mkdir(UPLOAD_DIR, { recursive: true });
  await sweepUploads(actorId);
  // The file is written whole before it is read, so its length (when the request states it) plus the margin the
  // disk keeps free must fit now; a body of unstated length is cut off by ENOSPC below instead.
  if ((await freeBytes(UPLOAD_DIR)) < (declaredBytes ?? 0) + FREE_SPACE_MARGIN_BYTES) throw new BackupFileError("backup_no_room");
  const uploadId = randomUUID();
  const partial = `${zipPath(uploadId)}.part`;
  let bytes = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) done(new BackupFileError("backup_too_large"));
      else done(null, chunk);
    },
  });
  try {
    try {
      await pipeline(body, cap, createWriteStream(partial, { flags: "wx" }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw new BackupFileError("backup_no_room");
      throw error;
    }
    const reader = await openBackup(partial);
    const manifest = reader.manifest;
    reader.close();
    await writeFile(metaPath(uploadId), JSON.stringify({ actor_id: actorId, created_at: Date.now() } satisfies UploadMeta), { flag: "wx" });
    await rename(partial, zipPath(uploadId));
    return { uploadId, manifest, bytes };
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/** Whether upload `uploadId` of `actorId` is still there to restore from. */
export async function uploadAvailable(actorId: string, uploadId: string): Promise<boolean> {
  if (!UUID_RE.test(uploadId)) return false;
  const meta = await readFile(metaPath(uploadId), "utf8").then((t) => JSON.parse(t) as UploadMeta).catch(() => null);
  return !!meta && meta.actor_id === actorId && Date.now() - meta.created_at <= UPLOAD_TTL_MS;
}

/** The stored upload `uploadId` of `actorId`, opened. */
export async function openBackupUpload(actorId: string, uploadId: string): Promise<BackupReader> {
  if (!UUID_RE.test(uploadId)) throw new BackupUploadNotFound();
  const meta = await readFile(metaPath(uploadId), "utf8").then((t) => JSON.parse(t) as UploadMeta).catch(() => null);
  if (!meta || meta.actor_id !== actorId || Date.now() - meta.created_at > UPLOAD_TTL_MS) throw new BackupUploadNotFound();
  return openBackup(zipPath(uploadId));
}

/** Forget an upload (after its restore, or when replaced). */
export async function discardUpload(uploadId: string): Promise<void> {
  if (!UUID_RE.test(uploadId)) return;
  // The meta first: it is what openBackupUpload checks, so "gone" is answered 404 from that moment,
  // never "not a zip" for an upload whose zip alone was removed.
  await rm(metaPath(uploadId), { force: true });
  await rm(zipPath(uploadId), { force: true });
}
