// 「這次更新」: what changed for the person, from the repo's changes/ folder
// (one file per change; see changes/README.md). The files are bundled at build
// time, so a self-hosted site ships the same list and no API is involved.
//
// Not imported by the local-DB worker: the text would count against its size
// budget (test/workerImports.test.ts, scripts/check-worker-bundle.mjs).
//
// A change is identified by its file name (`2026-10-29-add-view`), which starts
// with its day, so "newer" is a plain string comparison. The account keeps the
// newest one it has seen (lib/changesSeenStore); everything after it is new.

import { isCalendarDay } from "@onden/markdown";
import type { Change } from "./whatsNewText";

export { changeText, isNewerChange, unseenChanges, type Change } from "./whatsNewText";

const SOURCES = import.meta.glob(["../../../../changes/*.md", "!../../../../changes/README.md"], {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

/** One file: `---`, `key: value` lines, `---`. Null when it lacks a day or the Chinese text. */
export function parseChange(id: string, source: string): Change | null {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!head) return null;
  const fields = new Map<string, string>();
  for (const line of head[1]!.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const date = fields.get("date") ?? "";
  const zh = fields.get("zh-TW") ?? "";
  if (!isCalendarDay(date) || !id.startsWith(date) || !zh) return null;
  return { id, date, zh, en: fields.get("en") || null };
}

/** Newest first. */
export function parseChanges(files: Record<string, string>): Change[] {
  const out: Change[] = [];
  for (const [path, source] of Object.entries(files)) {
    const change = parseChange(path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, ""), source);
    if (change) out.push(change);
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export const CHANGES: readonly Change[] = parseChanges(SOURCES);
