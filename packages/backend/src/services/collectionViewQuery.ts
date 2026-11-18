// M3.2 — collection_views query executor.
//
// Takes a view config (filters + sorts + visible_fields + group_by) and
// returns rows. Each row carries the node identity + per-visible-field
// attribute values pre-resolved (LEFT JOIN against node_attributes),
// so the layout renderer doesn't have to do N+1 lookups.
//
// Filter ops (9):
//   eq        value = ?
//   ne        value ≠ ?
//   contains  value ILIKE %?%
//   empty     row missing OR value IS NULL OR ''
//   nempty    row present AND value ≠ ''
//   gt/gte    value > / >= ?   (typed: numeric/date cast, else lexicographic)
//   lt/lte    value < / <= ?   (typed: numeric/date cast, else lexicographic)
//
// Built-in fields (always available regardless of attribute presence):
//   title, slug, updated_at, created_at, sort_order
//
// Per-attribute fields use the node_attributes(key, value) row for the
// node — when missing, the field renders as null. Range ops on attributes
// cast by the row's value_type (number→numeric, date→timestamptz),
// regex-guarded so bad data is excluded rather than 500-ing the query
// (mirrors the typed-sort path below).
//
// Reference: SiYuan av/filter.go is 1295 lines; Onden covers the ops that
// handle ~90% of practical filters. Add more from the SiYuan list
// (starts-with/between) when needed.

import { q } from "../db.js";
import { sqlIdentifier } from "../sqlText.js";
import { MANUAL_ORDER_N_ASC, MANUAL_ORDER_N_DESC, UNSORTED_ORDER_N } from "./orderKeys.js";
import { memberTagIds } from "./tagHierarchy.js";

import { appendFilterClauses, type FilterClause } from "./filter/index.js";
import { numericValueSql } from "./attributeNumber.js";
import { LISTED_NODE_SQL } from "../spine/reservedNodes.js";
import { MAX_OFFSET, pageOf, pageSql, type PageInput } from "./paging.js";
import type { ExecRow, Page } from "@onden/contract";
import { BUILT_IN_FIELDS } from "@onden/markdown";
import { liveNodeSql } from "../spine/nodeSql.js";
export type { FilterClause };

export interface SortClause {
  field: string;
  dir: "asc" | "desc";
}

/** Where a view's rows come from (docs/architecture/views-as-modules.md
 *  「檢視的來源」): a tag's members, or a note's children. */
export type ExecSource = { tagId: string; parentId?: never } | { parentId: string; tagId?: never };

export type ExecOptions = ExecSource & {
  workspaceId: string;
  filters: FilterClause[];
  sorts: SortClause[];
  visibleFields: string[];
  /** Fields the layout places rows by (placementFields): their values are
   *  filled in `attributes` whether or not the view shows them as columns. */
  placementFields?: readonly string[];
  limit?: number;
  /** Page offset (0-based). With limit, lets a caller page instead of silently
   *  capping at the first `limit` rows. */
  offset?: number;
  /** Read-policy iron law: every node-returning surface is bounded by the
   *  CALLER's read set. Required — passing the full workspace is a conscious
   *  act at the callsite, not a default. */
  readableIds: string[];
};

/** The fields a saved view's layout places its rows by: the grouping field
 *  (board columns, table groups) and `layout_config`'s calendar date / gallery
 *  cover field. The frontend's placementChanges (LayoutChooser) adds the same
 *  fields to visible_fields; this is the server's half, so a view that does
 *  not list its grouping field still gets its values. */
export function placementFields(view: { group_by?: string | null; layout_config?: Record<string, unknown> | null }): string[] {
  const fields = [view.group_by, view.layout_config?.date_field, view.layout_config?.cover_field];
  return fields.filter((f): f is string => typeof f === "string" && f !== "");
}

/** A saved view's page size: 200 rows by default, at most 500. */
export const VIEW_PAGE = { default: 200, max: 500 };

// Every built-in field is a column a view can sort by (the one list: @onden/markdown sharedContract).
const SORT_WHITELIST = new Set<string>(BUILT_IN_FIELDS);

/**
 * Execute a saved view's query against the live data. Read-only.
 *
 * Predicates use parameterised SQL throughout; no value reaches the
 * query string unescaped. Per-attribute filter clauses correlate via
 * EXISTS subqueries so missing rows don't silently exclude nodes
 * (except `nempty` which requires presence — that's the desired
 * semantic).
 */
export async function executeView(opts: ExecOptions): Promise<Page<ExecRow> & {
  /** Rows on this page. */
  count: number;
  /** Every row the view matches, across all pages. */
  total: number;
}> {
  // A tag's members: the tag, its child tags and the tags that extend it
  // (tagHierarchy.memberTagIds, the one membership rule). A note's children:
  // the rows whose parent it is.
  const source = opts.parentId !== undefined
    ? { value: opts.parentId, sql: `n.parent_id = $2::uuid` }
    : {
      value: await memberTagIds(opts.workspaceId, opts.tagId),
      sql: `EXISTS (SELECT 1 FROM node_tags nt WHERE nt.node_id = n.id AND nt.tag_id = ANY($2::uuid[]))`,
    };

  const params: unknown[] = [opts.workspaceId, source.value, opts.readableIds];
  const where: string[] = [
    `n.workspace_id = $1`,
    liveNodeSql("n"),
    `n.hidden = false`,
    // Tag definitions and system machinery never list (the same rule as
    // /api/query; Bases drops system rows).
    LISTED_NODE_SQL("n"),
    source.sql,
    // read-policy bound (audit 2026-06-12 #1: saved views leaked
    // read-restricted nodes' titles/slugs/attributes to low-role callers)
    `n.id = ANY($3::uuid[])`,
  ];

  // Filters — shared SQL clause compiler (services/filter/sqlClauses.ts).
  appendFilterClauses(opts.filters, where, params, "n");

  // Sorts — built-in only via whitelist. Attribute sorting uses a
  // correlated subquery for the LEFT JOIN's sake.
  const orderParts: string[] = [];
  for (const s of opts.sorts) {
    const dir = s.dir === "desc" ? "DESC" : "ASC";
    if (SORT_WHITELIST.has(s.field)) {
      orderParts.push(s.field === "sort_order" ? (dir === "DESC" ? MANUAL_ORDER_N_DESC : MANUAL_ORDER_N_ASC) : `n.${sqlIdentifier(s.field)} ${dir} NULLS LAST`);
    } else {
      // Attribute sort: order by the attribute value, treating missing
      // as last. Number/date fields must sort by their TYPED value, not
      // lexicographically ("10" < "9" as text is wrong, and date ranges
      // come out misordered). node_attributes carries a per-row value_type
      // (set from the schema field type at write time — see
      // services/attributeChange.ts), so the cast keys off it without
      // loading the schema. Each cast is regex-guarded so a stray
      // non-numeric / non-date value can't 500 the whole query — it just
      // sorts as NULL (last). The three keys are layered: typed-number,
      // then typed-date, then raw text as the final tie-breaker, so a
      // pure-text field is unaffected (its first two keys are all NULL).
      orderParts.push(...attributeSortSql(s.field, dir, params, "n"));
    }
  }
  // No sort set: by title, then id (a table whose rows share one manual number always listed that way); the manual order is not the default.
  if (orderParts.length === 0) orderParts.push(UNSORTED_ORDER_N);
  // Equal sort values would leave the order of their rows to the planner, and
  // each page is its own query: "load more" could repeat or skip them. The id
  // is the unique last key (nodeQuery.ts does the same).
  else orderParts.push(`n.id ASC`);

  // Route callers parse ?limit/&offset with services/paging.parsePage; this
  // clamp keeps internal callers (agent tools) in range too.
  const page: PageInput = {
    limit: Math.min(Math.max(Math.floor(opts.limit ?? VIEW_PAGE.default), 1), VIEW_PAGE.max),
    offset: Math.min(Math.max(Math.floor(opts.offset ?? 0), 0), MAX_OFFSET),
  };

  // One extra (probe) row says "there's more" (M1); `count(*) OVER ()` is the
  // whole match, so the table can say 200 of 350 (D66). LIMIT/OFFSET are
  // bound parameters (services/paging.pageSql).
  const whereSql = where.join(" AND ");
  const countParams = [...params];
  const sql = `
    SELECT n.id, n.title, n.slug,
           -- An ISO 8601 instant (what JSON gives a Date everywhere else):
           -- timestamptz::text reads "2026-10-21 03:00:00.12+00", whose
           -- hour-only zone the calendar's date rule (@onden/markdown
           -- calendarDayOf) does not take, so a date column placed no row.
           ${isoInstantSql("n.created_at")} AS created_at,
           ${isoInstantSql("n.updated_at")} AS updated_at,
           count(*) OVER () AS total
      FROM content_nodes n
     WHERE ${whereSql}
     ORDER BY ${orderParts.join(", ")}
     ${pageSql(page, params)}
  `;
  const fetched = await q<{ id: string; title: string; slug: string; created_at: string; updated_at: string; total: string }>(sql, params);
  // An offset past the end returns no row to read the total from.
  const total = fetched.rows.length > 0
    ? Number(fetched.rows[0]!.total)
    : page.offset === 0 ? 0 : Number((await q<{ total: string }>(
      // Same ORDER BY so every bound sort parameter is still referenced.
      `SELECT count(*) OVER () AS total FROM content_nodes n WHERE ${whereSql} ORDER BY ${orderParts.join(", ")} LIMIT 1`, countParams,
    )).rows[0]?.total ?? 0);
  const paged = pageOf(fetched.rows, page, total);
  const baseRows = { rows: paged.rows };

  // Per-row attribute hydration. One SELECT against node_attributes
  // for the whole batch — avoids N+1.
  const ids = baseRows.rows.map((r) => r.id);
  let attrMap: Map<string, Record<string, string>> = new Map();
  const shownFields = [...new Set([...opts.visibleFields, ...opts.placementFields ?? []])];
  if (ids.length > 0 && shownFields.length > 0) {
    const attrFields = shownFields.filter((f) => !BUILT_IN_FIELDS.has(f));
    if (attrFields.length > 0) {
      const attrResult = await q<{ node_id: string; key: string; value: string }>(
        `SELECT node_id, key, value FROM node_attributes
          WHERE node_id = ANY($1::uuid[]) AND key = ANY($2::text[])`,
        [ids, attrFields],
      );
      attrMap = new Map();
      for (const row of attrResult.rows) {
        const m = attrMap.get(row.node_id) ?? {};
        m[row.key] = row.value;
        attrMap.set(row.node_id, m);
      }
    }
  }

  const rows: ExecRow[] = baseRows.rows.map((r) => {
    const attrs: Record<string, string | null> = {};
    for (const f of shownFields) {
      if (BUILT_IN_FIELDS.has(f)) {
        attrs[f] = (r as unknown as Record<string, string>)[f] ?? null;
      } else {
        attrs[f] = attrMap.get(r.id)?.[f] ?? null;
      }
    }
    return {
      id: r.id, title: r.title, slug: r.slug,
      created_at: r.created_at, updated_at: r.updated_at, attributes: attrs,
    };
  });

  return { rows, count: rows.length, total, next: paged.next };
}

const isoInstantSql = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** ORDER BY keys for sorting by an attribute, shared by saved views and
 *  /api/query: the typed number, then the typed date, then the raw text (so a
 *  number field sorts 9 before 10). The number cast is regex-guarded and
 *  dates compare as ISO text, so a stray value never fails the query.
 *  Missing → last. */
export function attributeSortSql(field: string, dir: "ASC" | "DESC", params: unknown[], alias: string): string[] {
  params.push(field);
  const keyIdx = params.length;
  return [
    `(SELECT ${numericValueSql("na")}
        FROM node_attributes na WHERE na.node_id = ${alias}.id AND na.key = $${keyIdx} LIMIT 1) ${dir} NULLS LAST`,
    // ISO dates sort chronologically as text, so no cast (a stray 2024-02-30
    // can't fail the query).
    `(SELECT CASE WHEN na.value_type = 'date' AND na.value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN na.value END
        FROM node_attributes na WHERE na.node_id = ${alias}.id AND na.key = $${keyIdx} LIMIT 1) ${dir} NULLS LAST`,
    `(SELECT value FROM node_attributes na WHERE na.node_id = ${alias}.id AND na.key = $${keyIdx} LIMIT 1) ${dir} NULLS LAST`,
  ];
}
