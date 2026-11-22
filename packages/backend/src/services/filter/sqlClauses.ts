// Shared filter-clause SQL compiler — the one operator set + one clause builder
// for the SQL query paths (executeView saved-views AND the onden-query block),
// which used to hand-roll divergent SQL. Step 1 of the query-dialect
// unification (doc 08): collapse the two SQL dialects onto this.
//
// A clause is { field, op, value }. A built-in column (title/slug/dates/sort)
// filters directly on content_nodes; anything else is a node_attributes filter
// via a correlated EXISTS so a missing attribute doesn't silently exclude the
// node (except nempty, which requires presence). Everything is parameterised —
// no value ever reaches the query string. The caller passes its table alias and
// its already-started params array; we append conditions + params in place,
// continuing the parameter numbering.
//
// (The in-memory AND/OR/NOT tree evaluator — basesEval — is the frontend's
// client-side presentational path; it now lives only in packages/frontend and
// is not a trust boundary. This module covers the flat, AND-composed SQL
// filters that ARE trust boundaries.)

import { BUILT_IN_FIELDS, isCalendarDate, NUMBER_PATTERN, type FilterOpName } from "@onden/markdown";
import { containsPattern } from "../../utils.js";
import { numericValueSql } from "../attributeNumber.js";
import { sqlIdentifier } from "../../sqlText.js";

// Range comparisons (gt/gte/lt/lte) use typed comparison via the value_type guards
// below (numeric / date); an attribute range whose value is neither matches
// nothing. Built-in text columns (title/slug) compare lexicographically.
export type FilterOp = FilterOpName;

export interface FilterClause {
  field: string;
  op: FilterOp;
  value?: string;
}

// Range ops → SQL comparator.
const RANGE_OPS: Record<string, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" };

// A range value is numeric by the same grammar a stored number has; the row
// side reads through numericValueSql (../attributeNumber.ts).
const NUMBER_RE = new RegExp(NUMBER_PATTERN);

// Built-in columns stored already-typed: a comparison (eq/ne/range) casts the
// (text) param to the column type and compares on the typed column directly.
// Built-ins not listed (title/slug) compare as text. `accepts` is the one test
// of a value the cast takes: a saved view is refused one it fails
// (tagViews.ts), and a stored or query-block clause that fails it matches
// nothing instead of failing the cast (a 500 on every run).
const TYPED_BUILT_INS: Record<string, { cast: string; accepts: (value: string) => boolean; expects: string }> = {
  updated_at: { cast: "timestamptz", accepts: isCalendarDate, expects: "a date (YYYY-MM-DD, optionally with a time)" },
  created_at: { cast: "timestamptz", accepts: isCalendarDate, expects: "a date (YYYY-MM-DD, optionally with a time)" },
};

/** Ops that compare the value as the column's type (contains/empty/nempty read text). */
const TYPED_OPS = new Set<FilterOp>(["eq", "ne", "gt", "gte", "lt", "lte"]);

// The one date read of an attribute value, as SQL (numericValueSql's twin): the
// value of the node_attributes row aliased `alias` as timestamptz when its
// value_type is 'date' and Postgres can read it, else NULL — so a stray value
// drops out of a range comparison (NULL <op> x is unknown) instead of failing
// the cast. The shape test alone lets 2026-02-30 through, so the cast sits in a
// CASE behind pg_input_is_valid (a guard AND-ed beside the cast has no
// evaluation order). Writes type a date only by @onden/markdown isCalendarDate,
// so such a row is not expected; one written by other means must not turn
// every run of the view into a 500.
const DATE_GUARD = "^[0-9]{4}-[0-9]{2}-[0-9]{2}";
const dateValueSql = (alias: string) =>
  `(CASE WHEN ${alias}.value_type = 'date' AND ${alias}.value ~ '${DATE_GUARD}'
      AND pg_input_is_valid(${alias}.value, 'timestamptz') THEN ${alias}.value::timestamptz END)`;

// Multi-value attributes (D117): a list is one stored value, a JSON array of
// strings (@onden/markdown attributeValues). eq and ne read it by its
// elements — `authors eq Alice` matches `["Alice","Bob"]` — as the app's
// compareAttribute does. The jsonb cast sits inside a CASE behind the shape
// test, so a value that only starts with "[" ("[draft") is plain text and
// never reaches the cast. A list's rows are value_type 'text' (or node_ref), so
// the typed range arms below never see one. Other ops (contains, empty) still
// read the stored string.
const equalsValueSql = (param: string) =>
  `(na.value = ${param} OR (CASE WHEN left(na.value, 1) = '[' AND na.value IS JSON ARRAY
      THEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(na.value::jsonb) AS el(v) WHERE el.v = ${param})
      ELSE FALSE END))`;

/**
 * Append parameterised WHERE conditions for `filters` onto `where`/`params`,
 * against content_nodes aliased as `alias`. Mutates both arrays.
 */
export function appendFilterClauses(
  filters: FilterClause[],
  where: string[],
  params: unknown[],
  alias: string,
): void {
  for (const f of filters) {
    // "Manual order" (sort_order, the name saved views keep) is the order key now, compared as text by byte.
    const key = f.field === "sort_order" ? "order_key" : f.field;
    if (BUILT_IN_FIELDS.has(f.field)) {
      const typed = TYPED_BUILT_INS[key];
      if (typed && TYPED_OPS.has(f.op) && !typed.accepts(f.value ?? "")) {
        // A value the column's type cannot take (a date still being typed in
        // the view builder, which autosaves; an onden-query block): equal to
        // or ordered against nothing, so ne keeps every row and the rest keep
        // none — never a failed cast.
        where.push(f.op === "ne" ? "TRUE" : "FALSE");
        continue;
      }
      switch (f.op) {
        case "eq":
          params.push(f.value ?? "");
          where.push(typed ? `${alias}.${sqlIdentifier(key)} = $${params.length}::${typed.cast}` : `${alias}.${sqlIdentifier(key)} = $${params.length}`);
          break;
        case "ne":
          params.push(f.value ?? "");
          where.push(typed ? `${alias}.${sqlIdentifier(key)} <> $${params.length}::${typed.cast}` : `${alias}.${sqlIdentifier(key)} <> $${params.length}`);
          break;
        case "contains":
          params.push(containsPattern(f.value ?? ""));
          where.push(`${alias}.${sqlIdentifier(key)}::text ILIKE $${params.length}`);
          break;
        case "empty":
          where.push(`(${alias}.${sqlIdentifier(key)} IS NULL OR ${alias}.${sqlIdentifier(key)}::text = '')`);
          break;
        case "nempty":
          where.push(`(${alias}.${sqlIdentifier(key)} IS NOT NULL AND ${alias}.${sqlIdentifier(key)}::text <> '')`);
          break;
        case "gt":
        case "gte":
        case "lt":
        case "lte": {
          // Already-typed columns (dates/sort_order) cast the param to the
          // column type; text columns (title/slug) compare lexicographically.
          params.push(f.value ?? "");
          where.push(
            typed
              ? `${alias}.${sqlIdentifier(key)} ${RANGE_OPS[f.op]} $${params.length}::${typed.cast}`
              : `${alias}.${sqlIdentifier(key)} ${RANGE_OPS[f.op]} $${params.length}`,
          );
          break;
        }
      }
      continue;
    }
    // Attribute filter via correlated EXISTS.
    params.push(key);
    const keyIdx = params.length;
    switch (f.op) {
      case "eq":
        params.push(f.value ?? "");
        where.push(`EXISTS (SELECT 1 FROM node_attributes na
          WHERE na.node_id = ${alias}.id AND na.key = $${keyIdx}
            AND ${equalsValueSql(`$${params.length}`)})`);
        break;
      case "ne":
        // ne = no row OR a row with a different value (missing ≠ the value);
        // a list differs when none of its elements is the value.
        params.push(f.value ?? "");
        where.push(`NOT EXISTS (SELECT 1 FROM node_attributes na
          WHERE na.node_id = ${alias}.id AND na.key = $${keyIdx}
            AND ${equalsValueSql(`$${params.length}`)})`);
        break;
      case "contains":
        params.push(containsPattern(f.value ?? ""));
        where.push(`EXISTS (SELECT 1 FROM node_attributes na
          WHERE na.node_id = ${alias}.id AND na.key = $${keyIdx}
            AND na.value ILIKE $${params.length})`);
        break;
      case "empty":
        where.push(`NOT EXISTS (SELECT 1 FROM node_attributes na
          WHERE na.node_id = ${alias}.id AND na.key = $${keyIdx}
            AND na.value <> '')`);
        break;
      case "nempty":
        where.push(`EXISTS (SELECT 1 FROM node_attributes na
          WHERE na.node_id = ${alias}.id AND na.key = $${keyIdx}
            AND na.value <> '')`);
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        // Typed range comparison. The arm is chosen by the COMPARISON VALUE's
        // format at build time (it's known here in JS) — NOT by OR-ing a numeric
        // and a timestamptz arm in SQL. The OR form is unsafe: Postgres binds
        // one type to the placeholder and constant-folds the value cast in BOTH
        // arms regardless of which row-side guard is reachable, so `'2020'` gets
        // cast to timestamptz (or a date string to numeric) and 500s EVERY range
        // query. Emitting only the matching arm casts the value exactly once.
        // The row side reads through numericValueSql / dateValueSql, so a
        // mistyped stored value can't 500 the cast either. A range value that
        // is no number or calendar date (isCalendarDate, as compareAttribute
        // reads it) matches nothing (FALSE) — same as missing-attribute-excludes-row.
        const cmp = RANGE_OPS[f.op];
        const rangeVal = f.value ?? "";
        if (NUMBER_RE.test(rangeVal)) {
          params.push(rangeVal);
          const valIdx = params.length;
          where.push(`EXISTS (SELECT 1 FROM node_attributes na
            WHERE na.node_id = ${alias}.id AND na.key = $${keyIdx}
              AND ${numericValueSql("na")} ${cmp} ($${valIdx}::text)::numeric)`);
        } else if (isCalendarDate(rangeVal)) {
          params.push(rangeVal);
          const valIdx = params.length;
          where.push(`EXISTS (SELECT 1 FROM node_attributes na
            WHERE na.node_id = ${alias}.id AND na.key = $${keyIdx}
              AND ${dateValueSql("na")} ${cmp} ($${valIdx}::text)::timestamptz)`);
        } else {
          // No arm reads the key: take its param back, or the statement gets
          // one more param than it uses and Postgres refuses it (a 500).
          params.pop();
          where.push(`FALSE`);
        }
        break;
      }
    }
  }
}
