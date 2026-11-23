// What a version's identity is made of, as pure functions: the one shape of its time (note_versions.at, a backup's carried history, a snapshot's history
// part: UTC microseconds as text, `YYYY-MM-DDTHH:MM:SS.ffffffZ`, passed on as text and never through Date) and the encoding of the keys that are worked out
// from what a version is (`g:`, `b:`; migration 220's SQL twins, versionKeys.integration.test.ts compares them). Their own file so that a path that only
// RECEIVES versions (spine/historyLayer.ts, reached from spine/stampedImport.ts) checks a time and a key without reaching the code that mints versions
// (guards/receiveMintsNoVersion.guard.test.ts).
import { sha256Hex } from "../utils.js";

/** The only shape of a version's time: what the export writes (microseconds, UTC). Passed on as text, never through Date. Spelled IMPORTED_AT where it began
 *  (spine/importedHistory.ts, a backup's carried history). */
const IMPORTED_AT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d{6}Z$/;
/** Whether `at` is a real calendar time in that shape (not 2026-02-31, not hour 25). */
export function isImportedAt(at: string): boolean {
  const whole = IMPORTED_AT.exec(at)?.[1];
  if (!whole) return false;
  const parsed = new Date(`${whole}.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === `${whole}.000Z`;
}

// The key encoding of migration 220 (note_version_field): every field `<UTF-8 bytes>:<text>`, a missing one `-`, in this order.
const field = (value: string | null): string => (value === null ? "-" : `${Buffer.byteLength(value, "utf8")}:${value}`);

/** `g:` — a version recorded as an event (here, or carried in from a backup), from what it is. `at`: UTC microseconds (IMPORTED_AT).
 *  The same function as SQL note_version_legacy_key (versionKeys.integration.test.ts). */
export function legacyVersionKey(noteId: string, unit: string, kind: string, contentHash: string | null, title: string | null, at: string): string {
  return `g:${sha256Hex(`onden version 1${[noteId, unit, kind, contentHash, title, at].map(field).join("")}`)}`;
}

/** `b:` — the root's baseline of a note or drawing: what its content was when its history began (not its time). The same function as SQL
 *  note_version_baseline_key (versionKeys.integration.test.ts); only migration 220 mints one, a receiver works it out again to check a copy. */
export function baselineVersionKey(noteId: string, unit: string, contentHash: string | null): string {
  return `b:${sha256Hex(`onden baseline 1${[noteId, unit, contentHash].map(field).join("")}`)}`;
}
