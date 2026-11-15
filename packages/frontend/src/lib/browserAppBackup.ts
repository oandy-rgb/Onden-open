// The trial version's backup habit: when to remind, and where a backup can go besides the downloads folder.
//
// There is no server copy of anything in the trial version (docs/architecture/browser-app.md §4), so a backup the
// person keeps is the only protection against clearing site data, switching browser or Safari's 7-day clean-up.
//   • Reminder: a backup is "due" after BACKUP_EVERY_DAYS since the last one (or since first opening, if never)
//     provided something was saved since, or after SAVES_BEFORE_REMINDER saved changes whatever the days.
//   • Folder: with the File System Access API (Chromium) the person picks a folder once; backups are then written
//     there as dated zips (the last KEEP_IN_FOLDER stay). The browser asks permission again after a restart; that
//     needs a tap, so it is reported as "needs permission", not retried silently.
// The backup itself is the app's existing full export (GET /api/backup/full.zip); nothing here makes a second format.

import { PREFS, getPref, setPref, type Pref } from "./prefs";
import { getStoredDirHandle, pickDirectory, requestDirPermission, storeDirHandle } from "./fileSystemStorage";
import { dateIdAt, dateTimeId, daysBetween } from "./localDate";

export const BACKUP_EVERY_DAYS = 7;
export const SAVES_BEFORE_REMINDER = 50;
const KEEP_IN_FOLDER = 5;
const FOLDER_SLOT = "trialBackupDir";

export type BackupHabit = { lastBackupAt: number | null; savesSince: number; firstSeenAt: number | null };

export type BackupDue = { due: boolean; /** Whole days since the last backup (or since first opening); null when neither is known. */ daysSince: number | null; neverBackedUp: boolean };

/** Pure: whether to remind now. */
export function backupDue(habit: BackupHabit, now: number): BackupDue {
  const since = habit.lastBackupAt ?? habit.firstSeenAt;
  const daysSince = since === null ? null : Math.max(0, daysBetween(dateIdAt(new Date(since)), dateIdAt(new Date(now))));
  const due = habit.savesSince > 0 && (habit.savesSince >= SAVES_BEFORE_REMINDER || (daysSince !== null && daysSince >= BACKUP_EVERY_DAYS));
  return { due, daysSince, neverBackedUp: habit.lastBackupAt === null };
}

const readNumber = (pref: Pref): number | null => {
  const value = Number(getPref(pref));
  return Number.isFinite(value) && getPref(pref) !== null ? value : null;
};

export function readBackupHabit(): BackupHabit {
  return { lastBackupAt: readNumber(PREFS.trialBackupAt), savesSince: readNumber(PREFS.trialSavesSince) ?? 0, firstSeenAt: readNumber(PREFS.trialFirstSeenAt) };
}

/** First time this browser opens the trial: the clock for "never backed up" starts here. */
export function noteFirstSeen(now: number): void {
  if (readNumber(PREFS.trialFirstSeenAt) === null) setPref(PREFS.trialFirstSeenAt, String(now));
}

/** The worker finished saving a copy that held new changes. */
export function noteSave(): void {
  setPref(PREFS.trialSavesSince, String((readNumber(PREFS.trialSavesSince) ?? 0) + 1));
}

/** A backup reached the person (downloaded or written to the folder). */
export function noteBackupMade(now: number): void {
  setPref(PREFS.trialBackupAt, String(now));
  setPref(PREFS.trialSavesSince, "0");
}

/** The existing full export, as bytes (through the page's fetch bridge to the worker). */
export async function makeBackupBlob(): Promise<Blob> {
  const response = await fetch("/api/backup/full.zip");
  if (!response.ok) throw new Error("backup failed");
  return response.blob();
}

/** What a temporary session hands on (docs/architecture/browser-app.md §17): the notes someone WROTE in it and their files,
 *  in the same backup format, never the blank note a new session starts with. The two options make it incremental:
 *  `since` = only notes saved at or after that instant, `noteIds` = only those notes (each with its ancestors, tags and
 *  attachments). `cursor` is the clock's reading from just before the request: pass it as the next `since` and a note
 *  saved while this backup was being made is in the next one too (a note twice is harmless, a restore skips what it has). */
export async function makeSessionBackupBlob(options: { since?: string; noteIds?: readonly string[] } = {}): Promise<{ blob: Blob; cursor: string }> {
  const cursor = new Date().toISOString();
  const query = new URLSearchParams({ written: "1" });
  if (options.since) query.set("since", options.since);
  for (const id of options.noteIds ?? []) query.append("note", id);
  const response = await fetch(`/api/backup/full.zip?${query}`);
  if (!response.ok) throw new Error("backup failed");
  return { blob: await response.blob(), cursor };
}

export const trialBackupFileName = (now: number): string => `onden-backup-${dateTimeId(new Date(now)).replace(/[^0-9]/g, "")}.zip`;

type DirectoryWithEntries = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };

/** Whether this browser can write into a folder the person picks. */
export { isFileSystemAccessSupported as canBackupToFolder } from "./fileSystemStorage";

/** The chosen folder's name, or null when none is chosen. */
export async function backupFolderName(): Promise<string | null> {
  return (await getStoredDirHandle(FOLDER_SLOT))?.name ?? null;
}

/** Asks the person for a folder and remembers it. False when they cancelled. */
export async function chooseBackupFolder(): Promise<boolean> {
  const handle = await pickDirectory();
  if (!handle) return false;
  await storeDirHandle(handle, FOLDER_SLOT);
  return true;
}

export type FolderBackupResult = "saved" | "no-folder" | "needs-permission";

/** Writes `backup` into the chosen folder. `askPermission` is only true from a tap (the browser refuses to ask otherwise). */
export async function writeBackupToFolder(backup: Blob, now: number, askPermission: boolean): Promise<FolderBackupResult> {
  const folder = await getStoredDirHandle(FOLDER_SLOT);
  if (!folder) return "no-folder";
  const granted = askPermission
    ? await requestDirPermission(folder)
    : (await (folder as FileSystemDirectoryHandle & { queryPermission(d: { mode: string }): Promise<string> }).queryPermission({ mode: "readwrite" }).catch(() => "denied")) === "granted";
  if (!granted) return "needs-permission";
  const file = await folder.getFileHandle(trialBackupFileName(now), { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(backup);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  // Keep the newest few; older dated zips of ours go (nothing else in the folder is touched).
  const names: string[] = [];
  for await (const entry of (folder as DirectoryWithEntries).values()) {
    if (entry.kind === "file" && /^onden-backup-\d+\.zip$/.test(entry.name)) names.push(entry.name);
  }
  for (const old of names.sort().slice(0, Math.max(0, names.length - KEEP_IN_FOLDER))) await folder.removeEntry(old).catch(() => {});
  return "saved";
}
