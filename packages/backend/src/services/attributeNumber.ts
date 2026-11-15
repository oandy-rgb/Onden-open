import { NUMBER_PATTERN } from "@onden/markdown";

/** The one numeric read of an attribute value (D50), as SQL: the value of the
 *  node_attributes row aliased `alias` as numeric when its value_type is
 *  'number' and it matches NUMBER_PATTERN (@onden/markdown, the grammar of
 *  isStoredNumber, which the table footer reads with), else NULL. Typed sorts
 *  (collectionViewQuery.ts), range filters (filter/sqlClauses.ts) and rollups
 *  (nodeAttributes.ts) all read numbers through it, so "2h", "1e3" or "NaN" is
 *  no number to any of them, and the CASE keeps the cast from ever seeing such
 *  a value — the query can't fail on it (a guard AND-ed beside the cast has no
 *  evaluation order in Postgres). */
export function numericValueSql(alias: string): string {
  return `(CASE WHEN ${alias}.value_type = 'number' AND ${alias}.value ~ '${NUMBER_PATTERN}' THEN ${alias}.value::numeric END)`;
}
