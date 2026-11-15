// Deep CSV/Notion database import: turn a CSV table into a *collection schema*
// (typed fields) + one collection item per row, instead of one loose note per
// row. This is the difference between "I dumped my Notion database as notes"
// and "my Notion database is now a usable kanban/table/gallery in Onden".
//
// Everything in this module is PURE (no db, no fs): it derives the schema and
// the per-row item payloads from parsed CSV text. modules/importers/routes.ts feeds the
// results through the existing collection service (createItem) so the rows land
// as tagged content_nodes with node_attributes — no parallel write path, and
// the imported database renders through the already-mounted CollectionView.
//
// What "deep" buys over the Round-2 one-node-per-row path:
//   - column type inference (number / date / boolean / select / text), so the
//     CollectionView can sort numbers, bucket dates on a calendar, and offer a
//     kanban grouped on a select column;
//   - a real collection_schema, so the database is editable as a unit and new
//     rows can be added through the same UI;
//   - row → page-body attachment (Notion exports one `<Title> <hash>.md` file
//     per row alongside the CSV), and per-row dedup by the Notion page id.

import { inferFieldType, toCalendarDate } from "@onden/markdown";
import type { CsvTable } from "./import.js";

// ── Field type inference ─────────────────────────────────────────────────────

export type InferredFieldType = "number" | "date" | "boolean" | "select" | "text";

export type InferredField = {
  /** Column name as it appears in the CSV header (the attribute key). */
  name: string;
  type: InferredFieldType;
  /** For 'select': the distinct values observed, in first-seen order. */
  options?: string[];
  /** A date column kept as text: its slash dates read as month-first or
   *  day-first and nothing in it says which (see ambiguousSlashDates). */
  ambiguousDate?: true;
};

// Notion exports a Checkbox property as Yes/No; other apps write true/false
// or checked/unchecked. The vocabulary of an import, not a value grammar: each
// cell is stored as the "true"/"false" a boolean field holds.
const CHECKBOX_VALUES = new Map<string, boolean>([
  ["true", true], ["false", false], ["yes", true], ["no", false],
  ["checked", true], ["unchecked", false], ["✓", true], ["✗", false],
]);

// A column becomes a 'select' (single-choice) when its non-empty values come
// from a small, repeating vocabulary — the signal that it was a Notion
// Select/Status property rather than free text. Tuned conservatively so a
// column of unique free-text values stays 'text'.
const SELECT_MAX_DISTINCT = 12;
const SELECT_MAX_VALUE_LEN = 40;

// Number and date are the attribute value rule's (@onden/markdown), so a
// column is typed only when every value is one its field stores and typed
// sorts, filters and the calendar read: a number as NUMBER_PATTERN writes it
// ("1,200" is text, like a typed one), a date as a real calendar day — Notion's
// "October 16, 2026" and "10/16/2026" are stored as 2026-10-16 (toCalendarDate).
function isNumber(v: string): boolean {
  return inferFieldType(withoutThousands(v)) === "number";
}

// Notion's "Number with commas" format writes 1,200 / 12,345.6. Only a strict
// thousands grouping is undone; "1,5" (a European decimal) or "1,20" stays as
// written, so its column stays text instead of reading as 15 or 120.
const THOUSANDS_RE = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
function withoutThousands(v: string): string {
  return THOUSANDS_RE.test(v) ? v.replace(/,/g, "") : v;
}

function isDate(v: string): boolean {
  return toCalendarDate(v) !== null;
}

function isBool(v: string): boolean {
  return CHECKBOX_VALUES.has(v.toLowerCase());
}

/** "03/04/2026" is March 4 to toCalendarDate but April 3 to much of the world.
 *  A column whose slash dates all have both parts up to 12, at least one of
 *  them different, never says which; guessing would swap days and months
 *  without a trace, so the column stays text as written. A value with a part
 *  above 12 in second place proves month-first and settles it. */
function ambiguousSlashDates(values: string[]): boolean {
  let differs = false;
  for (const v of values) {
    const m = /^(\d{1,2})\/(\d{1,2})\/\d{4}(?: |$)/.exec(v);
    if (!m) continue;
    if (Number(m[2]) > 12) return false;
    if (m[1] !== m[2]) differs = true;
  }
  return differs;
}

/**
 * Infer a field type for a single column from all its non-empty cell values.
 * Empty columns default to 'text'. The decision is "all values agree" for the
 * strict types (number/date/boolean); otherwise small-vocabulary → select,
 * else text.
 */
export function inferColumnType(values: string[]): { type: InferredFieldType; options?: string[]; ambiguousDate?: true } {
  const nonEmpty = values.map((v) => v.trim()).filter((v) => v !== "");
  if (nonEmpty.length === 0) return { type: "text" };

  if (nonEmpty.every(isNumber)) return { type: "number" };
  if (nonEmpty.every(isDate)) return ambiguousSlashDates(nonEmpty) ? { type: "text", ambiguousDate: true } : { type: "date" };
  if (nonEmpty.every(isBool)) return { type: "boolean" };

  // Small, repeating vocabulary of short values ⇒ a Select/Status column.
  const distinct = new Map<string, true>();
  let tooLong = false;
  for (const v of nonEmpty) {
    if (v.length > SELECT_MAX_VALUE_LEN) { tooLong = true; break; }
    distinct.set(v, true);
  }
  if (
    !tooLong &&
    distinct.size >= 2 &&                 // ≥2 choices, else it's not really a picker
    distinct.size <= SELECT_MAX_DISTINCT &&
    // require at least one value to actually repeat, else it's just short free text
    distinct.size < nonEmpty.length
  ) {
    return { type: "select", options: [...distinct.keys()] };
  }
  return { type: "text" };
}

/**
 * Build the inferred schema fields for a CSV table by sampling every column
 * across all rows. The first column keeps its position (Notion puts the title
 * column first), which is what pickTitleField will latch onto.
 */
export function inferSchemaFields(table: CsvTable): InferredField[] {
  const fields: InferredField[] = [];
  const seen = new Set<string>();
  // The next suffix to try per name: a duplicate resumes where the last one stopped instead of
  // counting up from 2 again (a header of N identical names would cost N²/2 lookups).
  const nextSuffix = new Map<string, number>();
  for (let col = 0; col < table.header.length; col++) {
    const rawName = (table.header[col] ?? "").trim();
    if (rawName === "") continue;
    // De-dupe header collisions (Notion can emit two "Tags" columns) so the
    // attribute keys stay unique per node.
    let name = rawName;
    let n = nextSuffix.get(rawName) ?? 2;
    while (seen.has(name)) name = `${rawName} ${n++}`;
    nextSuffix.set(rawName, n);
    seen.add(name);

    const colValues = table.rows.map((r) => r[col] ?? "");
    const { type, options, ambiguousDate } = inferColumnType(colValues);
    fields.push({ name, type, ...(options ? { options } : {}), ...(ambiguousDate ? { ambiguousDate } : {}) });
  }
  return fields;
}

// ── Schema → tag field defs ──────────────────────────────────────────────────

export type CollectionFieldDef = {
  name: string;
  type: "text" | "number" | "boolean" | "date" | "select";
  options?: string[];
};

/** Map an inferred field to the collection_schemas field shape. */
export function toCollectionField(f: InferredField): CollectionFieldDef {
  return f.options ? { name: f.name, type: f.type, options: f.options } : { name: f.name, type: f.type };
}

/**
 * Choose default views for the imported collection. A select column makes a
 * kanban meaningful (group-by); a date column makes the calendar useful; the
 * first text column is the card title.
 */
export function defaultViews(fields: InferredField[]): {
  title_field?: string;
  group_field?: string;
  date_field?: string;
} {
  const title = fields.find((f) => f.type === "text" || f.type === "select")?.name ?? fields[0]?.name;
  const group = fields.find((f) => f.type === "select")?.name;
  const date = fields.find((f) => f.type === "date")?.name;
  const out: { title_field?: string; group_field?: string; date_field?: string } = {};
  if (title) out.title_field = title;
  if (group) out.group_field = group;
  if (date) out.date_field = date;
  return out;
}

// ── Row → item payload ───────────────────────────────────────────────────────

export type RowItem = {
  /** Field name → the value its field stores (a number as written, a date
   *  as YYYY-MM-DD, a boolean), ready for the collection createItem service. */
  data: Record<string, unknown>;
  /** The row's title (first non-empty cell), used to match a page-body file. */
  title: string;
  /** Notion page id parsed from the title's trailing hash, for dedup. */
  notionId: string | null;
};

// The cell as its field stores it: the column's type was inferred from every
// cell, so each one fits (a number as written, a date as its YYYY-MM-DD).
function coerce(value: string, type: InferredFieldType): unknown {
  const v = value.trim();
  if (v === "") return null;
  switch (type) {
    case "date":
      return toCalendarDate(v);
    case "boolean":
      return CHECKBOX_VALUES.get(v.toLowerCase()) ?? null;
    case "number":
      return withoutThousands(v);
    default:
      return v; // select/text are stored as written
  }
}

/**
 * Notion suffixes both database rows and page filenames with a 32-hex page id,
 * e.g. "My Task 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d". Extract it (lowercased) for
 * dedup and page-file matching. Returns null when there's no such suffix.
 */
export function parseNotionId(title: string): string | null {
  const m = title.match(/\b([0-9a-fA-F]{32})\b\s*$/);
  return m ? m[1]!.toLowerCase() : null;
}

/** Strip the trailing Notion page-id hash from a title for a clean display name. */
export function cleanNotionTitle(title: string): string {
  return title.replace(/\s+[0-9a-fA-F]{32}\s*$/, "").trim() || title;
}

/**
 * Turn one CSV data row into an item payload keyed by the inferred field names.
 * Cells are coerced to the field's type; empties are dropped.
 */
export function rowToItem(fields: InferredField[], header: string[], row: string[]): RowItem {
  // Map header position → field (skipping blank-header columns the schema dropped).
  const data: Record<string, unknown> = {};
  let titleCell = "";
  // Track which header index each field came from (handles blank-header gaps
  // and de-duped names by walking the header in order).
  const seen = new Set<string>();
  let fieldIdx = 0;
  for (let col = 0; col < header.length && fieldIdx < fields.length; col++) {
    const rawName = (header[col] ?? "").trim();
    if (rawName === "") continue;
    let name = rawName;
    let n = 2;
    while (seen.has(name)) name = `${rawName} ${n++}`;
    seen.add(name);
    const field = fields[fieldIdx++];
    if (!field || field.name !== name) continue;
    const cell = row[col] ?? "";
    if (titleCell === "" && cell.trim() !== "") titleCell = cell.trim();
    const coerced = coerce(cell, field.type);
    if (coerced != null) data[field.name] = coerced;
  }
  const title = titleCell || "Untitled";
  return { data, title, notionId: parseNotionId(title) };
}

/**
 * Notion exports a database twice: `<DB>.csv` (current view, may hide columns)
 * and `<DB>_all.csv` (every column). Prefer the `_all` variant and drop its
 * sibling so we don't import the database twice. Returns the csv file paths to
 * keep. Input/Output are path strings (lowercased compare, original returned).
 */
export function dedupNotionCsvFiles(csvPaths: string[]): string[] {
  const byBase = new Map<string, { plain?: string; all?: string }>();
  const passthrough: string[] = [];
  for (const p of csvPaths) {
    const lower = p.toLowerCase();
    const allMatch = lower.match(/^(.*)_all\.csv$/);
    if (allMatch) {
      const base = allMatch[1]!;
      const e = byBase.get(base) ?? {};
      e.all = p;
      byBase.set(base, e);
      continue;
    }
    const base = lower.replace(/\.csv$/, "");
    const e = byBase.get(base) ?? {};
    if (e.plain) { passthrough.push(p); continue; } // genuine collision, keep both
    e.plain = p;
    byBase.set(base, e);
  }
  const keep: string[] = [...passthrough];
  for (const { plain, all } of byBase.values()) {
    if (all) keep.push(all);          // prefer the complete export
    else if (plain) keep.push(plain);
  }
  return keep;
}

/**
 * Derive a human collection name from a Notion CSV filename, stripping the
 * `_all` suffix and the trailing page-id hash.
 * e.g. "Tasks 1a2b…_all.csv" → "Tasks".
 */
export function collectionNameFromCsvPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  const noExt = base.replace(/\.csv$/i, "").replace(/_all$/i, "");
  return cleanNotionTitle(noExt);
}
