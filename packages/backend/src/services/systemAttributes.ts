// Reserved node attributes: keys starting with `_` are derived/internal and
// not user-editable — except these, which the note's own menu writes. The
// one list both PUT and DELETE /api/nodes/:id/attributes/:key check.

import { isHexColor, isSystemAttr, PUBLISHED_ATTR_KEY } from "@onden/markdown";
import { NOTE_PAGES_ATTR, PDF_TEXT_ATTR } from "@onden/markdown/contract";
import { decodeNotePages } from "@onden/markdown/note-pages";
import { db } from "../dbKysely.js";

/** The note is on the published site (D9): the website module redeploys
 *  when it toggles. */
export const PUBLISHED_KEY = PUBLISHED_ATTR_KEY;
/** 「不發布」: the note's own exception to a space that publishes. A note made from another note (a copy, a block moved
 *  out, an import, a restore) takes this one along, or it would be public at the next publish. */
export const KEPT_OFF_SITE = { key: PUBLISHED_KEY, value: "false", value_type: "text", is_inheritable: false } as const;
export const isKeptOffSite = (attribute: { key: string; value: string }) => attribute.key === PUBLISHED_KEY && attribute.value === "false";
/** The one place that decides whether a new note made from another starts kept off the site (a copy, a block moved
 *  out, a restored copy): the mark to write, or null for none. Only 「不發布」 travels; a 「發布」 does not (the new note
 *  takes its space's default). A new way of making a note from another calls this instead of reading the flag itself. */
export const keptOffFromSource = (sourceAttributes: ReadonlyArray<{ key: string; value: string }>): typeof KEPT_OFF_SITE | null =>
  sourceAttributes.some(isKeptOffSite) ? KEPT_OFF_SITE : null;
/** keptOffFromSource for a note read from the database. */
export async function keptOffFromNote(noteId: string): Promise<typeof KEPT_OFF_SITE | null> {
  const rows = await db.selectFrom("node_attributes").select(["key", "value"]).where("node_id", "=", noteId).where("key", "=", PUBLISHED_KEY).execute();
  return keptOffFromSource(rows);
}
/** The note is pinned: listed first among its siblings in the sidebar. */
const PINNED_KEY = "_pinned";
/** The note's colour (a #rrggbb swatch), shown beside its title. */
const COLOR_KEY = "_color";
/** The note began as a quick capture (capture module). Set when it is created,
 *  and kept after the capture is filed under a note, so the day's captures can
 *  still be found. */
export const CAPTURED_KEY = "_captured";

// A flag is "true" or "false". For _published, 'false' is 「不發布」 and is not the same as removing it (it keeps the
// note off a space that publishes, publishedSet.ts); for the others only "true" counts.
const isFlag = (value: string) => value === "true" || value === "false";

/** `note_pages`: a list of pages this version reads, a newer version's (kept as it is, so an older server does not refuse a newer
 *  app), or empty (no list). */
const isNotePagesValue = (value: string) => { const r = decodeNotePages(value); return r.ok || r.reason === "empty" || r.reason === "newer"; };
/** `pdf_text`: `{ [pageKey]: text }`, at most PDF_TEXT_MAX_BYTES (a PDF's text is capped at ~60,000 characters). */
const PDF_TEXT_MAX_BYTES = 2_000_000;
function isPdfTextValue(value: string): boolean {
  if (value === "") return true;
  if (value.length > PDF_TEXT_MAX_BYTES) return false;
  try {
    const parsed: unknown = JSON.parse(value);
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.values(parsed).every((v) => typeof v === "string");
  } catch { return false; }
}

const VALUE_RULES: Record<string, (value: string) => boolean> = {
  [NOTE_PAGES_ATTR]: isNotePagesValue,
  [PDF_TEXT_ATTR]: isPdfTextValue,
  [PUBLISHED_KEY]: isFlag,
  [PINNED_KEY]: isFlag,
  [COLOR_KEY]: isHexColor,
  [CAPTURED_KEY]: isFlag,
};

/** Whether a client may set or remove this key at all. */
export function isWritableAttributeKey(key: string): boolean {
  return !isSystemAttr(key) || key in VALUE_RULES;
}

/** Whether a value is acceptable for a reserved key (other keys: always). */
export function isValidSystemAttributeValue(key: string, value: string): boolean {
  return VALUE_RULES[key]?.(value) ?? true;
}

/** Reserved keys a module keeps as provenance or configuration of what it
 *  made (a feed's _rss_*, a template child's _tpl_origin, the import stamp,
 *  a board's _canvas_sections). They change with the operation that wrote
 *  them, never on their own: an attribute undo refuses them. (Task fields,
 *  _task_*, are edited through the task route and undo like any value.) */
const MODULE_OWNED_PREFIXES = ["_rss_", "_tpl_", "_import_", "_canvas_", "_block_"];
export function isModuleOwnedAttributeKey(key: string): boolean {
  return MODULE_OWNED_PREFIXES.some((prefix) => key.startsWith(prefix));
}
