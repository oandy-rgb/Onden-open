// M3.4 — client-side group_by bucketing + aggregation footer.
//
// group_by is stored on the view config but the executor returns flat
// rows (intentionally — grouping is presentation, not a different read).
// This pure helper buckets the already-returned rows by a field value so
// the Table, List and Kanban layouts render the SAME groups in the SAME
// order (D78: Kanban used to carry its own copy with different ordering
// and a different empty sentinel), plus a per-group aggregation footer
// (count always; sum/avg over the stored numbers of a number column).
//
// Built-in field values live on the row top-level; everything else lives
// in row.attributes. Rows missing the group field fall into a single
// empty bucket, rendered last (mirrors the executor's NULLS LAST sort
// convention). A multi-value attribute (a JSON list, D117) groups by element:
// a row holding ["ml","db"] sits in both the ml and the db group.

import { attributeValues, BUILT_IN_FIELD_NAMES, encodeValues, isListValue, isStoredNumber } from "@onden/markdown";
import { t } from "../../lib/i18n";

export interface GroupableRow {
  id: string;
  title: string;
  slug: string;
  updated_at: string;
  attributes: Record<string, string | null>;
}

/** Fields every row carries on its top level (not in `attributes`). The one
 *  list the collection layouts and the view toolbar share. */
export const BUILT_IN_FIELDS: ReadonlySet<string> = new Set(BUILT_IN_FIELD_NAMES);

/** The value of a field on a row (built-in or attribute); missing or "" → null. */
export function fieldValue(row: GroupableRow, field: string): string | null {
  const v = BUILT_IN_FIELDS.has(field)
    ? (row as unknown as Record<string, string | null | undefined>)[field]
    : row.attributes[field];
  return v == null || v === "" ? null : v;
}

/** The values of a field on a row, one per element of a list attribute
 *  (@onden/markdown attributeValues, each once); none → []. Built-in fields
 *  hold one value. */
export function fieldValues(row: GroupableRow, field: string): string[] {
  if (BUILT_IN_FIELDS.has(field)) {
    const v = fieldValue(row, field);
    return v === null ? [] : [v];
  }
  return [...new Set(attributeValues(row.attributes[field]).filter((v) => v !== ""))];
}

/** The stored value after a card moves from group `from` to group `to`
 *  (null = the empty group). A list keeps its other elements — the move
 *  swaps `from` for `to`; a single value is replaced by `to`. "" = no value. */
export function movedValue(raw: string | null | undefined, from: string | null, to: string | null): string {
  if (raw == null || !isListValue(raw)) return to ?? "";
  const rest = attributeValues(raw).filter((v) => v !== from);
  return encodeValues(to === null || rest.includes(to) ? rest : [...rest, to]);
}

/** Bucket key of the empty group. A value bucket's key is always `=<value>`,
 *  so no stored value — not even a literal "(none)" — can share it. */
export const EMPTY_GROUP_KEY = "empty";

/** The bucket key of a group value (null = the empty bucket). */
export function groupKey(value: string | null): string {
  return value == null ? EMPTY_GROUP_KEY : `=${value}`;
}

export interface RowGroup<R extends GroupableRow> {
  /** Collision-free bucket key (React key, <option> value) — see groupKey. */
  key: string;
  /** The field value every row in the bucket holds; null = the empty bucket,
   *  shown as "No value" (groupLabel). */
  value: string | null;
  rows: R[];
}

/** Display label of a group: its value, or "No value" for the empty bucket.
 *  Pass the component's `useT()` so the label follows locale changes. */
export function groupLabel(group: { value: string | null }, translate: (s: string) => string = t): string {
  return group.value ?? translate("No value");
}

/**
 * Bucket rows by `field`. Order: values the field declares in `options`
 * first, in declared order (a pipeline keeps Lead → Qualified → Won however
 * the view is sorted); then any other value — e.g. a stale one no longer in
 * the schema — in first-seen order (rows arrive pre-sorted by the executor);
 * the empty bucket last. A row with a list value is in one bucket per element. Declared options no row holds get no bucket.
 */
export function groupRows<R extends GroupableRow>(
  rows: R[],
  field: string,
  options?: readonly string[] | null,
): RowGroup<R>[] {
  const buckets = new Map<string, RowGroup<R>>();
  for (const row of rows) {
    const values = fieldValues(row, field);
    for (const value of values.length ? values : [null]) {
      const key = groupKey(value);
      const bucket = buckets.get(key);
      if (bucket) bucket.rows.push(row);
      else buckets.set(key, { key, value, rows: [row] });
    }
  }

  const rank = new Map<string, number>();
  options?.forEach((opt, i) => {
    if (!rank.has(opt)) rank.set(opt, i);
  });
  const rankOf = (g: RowGroup<R>): number =>
    g.value == null ? Number.POSITIVE_INFINITY : rank.get(g.value) ?? Number.MAX_SAFE_INTEGER;

  // Array sort is stable: equal ranks keep first-seen order.
  return [...buckets.values()].sort((a, b) => rankOf(a) - rankOf(b));
}

export interface FieldAggregate {
  count: number;
  /** Present only on a number column: over its stored numbers. */
  sum?: number;
  avg?: number;
}

/**
 * Aggregate one field across a set of rows. `count` = rows with a present
 * (non-empty) value. `sum`/`avg` read numbers the one way the server does
 * (@onden/markdown isStoredNumber — value_type 'number' and NUMBER_PATTERN,
 * as rollups, typed sorts and range filters read them), so "2h", "1e3" or
 * "NaN" is never a number here either. `valueType` is the column's storage
 * type when its field is known (rows carry no per-value type):
 *   - 'number' → sum/avg over the values that are stored numbers, the rest
 *     skipped (like the rollup); avg divides by how many were numbers;
 *   - another type → no sum: a text column never shows a meaningless one;
 *   - unknown → a number column only when EVERY present value is one.
 */
export function aggregateField(rows: GroupableRow[], field: string, valueType?: string): FieldAggregate {
  let count = 0;
  let numbers = 0;
  let sum = 0;
  for (const row of rows) {
    const v = fieldValue(row, field);
    if (v == null) continue;
    count += 1;
    if (isStoredNumber(v, valueType)) {
      numbers += 1;
      sum += Number(v);
    }
  }
  const numeric = valueType === undefined ? count > 0 && numbers === count : numbers > 0;
  return numeric ? { count, sum, avg: sum / numbers } : { count };
}

/** Round to at most 2 decimals without trailing-zero noise (24.00 → 24). */
function tidyNumber(n: number): number {
  return Number.isInteger(n) ? n : Number(n.toFixed(2));
}

/**
 * Render the footer label for a non-first column from its aggregate.
 * Numeric columns show both sum and average (the fitness / number-log
 * payoff — `Σ 120 · avg 24`); non-numeric columns fall back to a count
 * so the footer stays meaningful instead of blank.
 */
export function formatFooter(agg: FieldAggregate): string {
  if (agg.sum !== undefined && agg.avg !== undefined) {
    return t("Σ {sum} · avg {avg}", { sum: tidyNumber(agg.sum), avg: tidyNumber(agg.avg) });
  }
  return agg.count > 0 ? t("{n} values", { n: agg.count }) : "";
}
