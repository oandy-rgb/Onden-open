// Query block — Dataview-inspired inline querying of the workspace.
//
// Accepts a small JSON spec (the frontend's onden-query code block parses
// a YAML-ish syntax into this shape) and returns matching nodes:
//
//   tags  — array of tag names (case-insensitive, as Bases' file.hasTag);
//           matches nodes carrying at least one
//   where — object whose values are EITHER a bare string (equality sugar,
//           the legacy shape) OR a { op, value } clause. Operators are the
//           shared filter compiler's set: eq/ne/contains/empty/nempty plus
//           the range ops gt/gte/lt/lte (so year>=2020 / overdue-before-today
//           are expressible). Always the same compiler as executeView — one
//           operator dialect, not a 2nd.
//   sort  — sort field; "-prefix" for descending. Built-in columns sort
//           directly; any other field sorts by that node_attribute value
//           (missing → last). Parameterised — never a SQL fragment.
//   limit — capped at 200 server-side regardless of request
//   offset — skip N rows. The answer is a Page (services/paging.ts):
//           { rows, total, next } — `total` counts every match,
//           `next` is the next page's offset or null.
//   block nodes (docs/architecture/block-nodes.md §9) — a tag query lists,
//           in the same rows, the block nodes that carry one of the tags in
//           their own `{…}` (a row with `block`: its note's id, title and
//           slug, and the block's id, ref and label), each right after its
//           note's place in the sort. They page and count with the notes. Not
//           when `where` is given: a block has no fields. A block takes no tag
//           from the block above or its note, as a note takes none from its
//           parent.
//   include_blocks — accepted and ignored: it asked for blocks that inherit a
//           tag, and since 2026-11-09 none do. A page still open from before
//           sends it.
//
// Unknown keys are refused (400), never ignored: `{ tag: "x" }` used to be
// stripped and the query listed every note.
//
// All filters compose with AND. Hidden nodes, tag definitions and system
// machinery (reservedNodes.LISTED_NODE_SQL — class_tag rows, source_type
// 'system') are excluded. The query is
// strictly read-only — no parameter accepts SQL fragments.

// (Depth audit D13: the query moved verbatim from routes/query.ts, which
// parses the body with nodeQuerySchema and answers runNodeQuery's result.)

import { FILTER_OP_NAMES, isSystemAttr } from "@onden/markdown";
import { z } from "zod";
import { q } from "../db.js";
import { sqlIdentifier } from "../sqlText.js";
import { MANUAL_ORDER_CN_ASC, MANUAL_ORDER_CN_DESC, UNSORTED_ORDER_CN } from "./orderKeys.js";
import type { ActorCtx } from "../types.js";
import { memberTagIdsNamed } from "./tagHierarchy.js";
import { attributeSortSql } from "./collectionViewQuery.js";
import { appendFilterClauses, BUILT_IN_FIELDS, type FilterClause } from "./filter/index.js";
import { readableScopeSql } from "./readPolicy.js";
import { LISTED_NODE_SQL } from "../spine/reservedNodes.js";
import { blockQuerySql } from "./blockNodes.js";
import { pageOf, pageSql, type PageInput } from "./paging.js";
import { liveNodeSql } from "../spine/nodeSql.js";

const SORT_WHITELIST = new Set([
  "title", "updated_at", "created_at", "sort_order",
]);


// A where-value is either a bare string (eq sugar, legacy shape the
// onden-query block still emits) or a { op, value } clause object.
const clauseSchema = z.union([
  z.string(),
  z.object({
    op: z.enum(FILTER_OP_NAMES),
    value: z.string().optional(),
  }),
]);

export const nodeQuerySchema = z.object({
  tags: z.array(z.string()).optional(),
  where: z.record(z.string(), clauseSchema).optional(),
  sort: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(100_000).optional(),
  include_blocks: z.boolean().optional(),
}).strict();

export type NodeQuery = z.infer<typeof nodeQuerySchema>;

/** One page of the notes `body` asks for, bounded by `actor`'s read set.
 *  `within`: list only these notes (and block nodes in them) — a published
 *  page's frozen result lists published notes only (D113,
 *  publishing/queryBlocks.ts); pushed down, so `limit` and `total` count
 *  them alone. */
export async function runNodeQuery(
  actor: ActorCtx | null, workspaceId: string, body: NodeQuery, { within }: { within?: readonly string[] } = {},
) {
  const conditions: string[] = [];
  const params: unknown[] = [workspaceId];
  let tagMembers: string[] = [];
  if (within) {
    params.push(within);
    conditions.push(`cn.id = ANY($${params.length}::uuid[])`);
  }

  // A note matches when it is a member of ANY named tag (several names OR,
  // as onden-query blocks have always meant), membership counted the way a
  // saved view counts it (tagHierarchy.memberTagIds: child tags and tags that
  // extend it too). Every tag with that title counts — the same name can sit
  // under different parents — and case does not matter, as in the frontend's
  // Bases file.hasTag (test/fixtures/tagMembershipParity.json holds both ends
  // to it). An unknown name matches nothing.
  if (body.tags && body.tags.length > 0) {
    tagMembers = await memberTagIdsNamed(workspaceId, body.tags);
    params.push(tagMembers);
    conditions.push(`EXISTS (SELECT 1 FROM node_tags nt WHERE nt.node_id = cn.id AND nt.tag_id = ANY($${params.length}::uuid[]))`);
  }

  if (body.where) {
    // Normalise both wire shapes (bare string = eq sugar; { op, value }) onto
    // the shared filter compiler — same operator semantics as executeView,
    // never a 2nd dialect.
    const filters: FilterClause[] = Object.entries(body.where)
      .filter(([key]) => !isSystemAttr(key)) // reserved
      .map(([field, clause]) =>
        typeof clause === "string"
          ? { field, op: "eq" as const, value: clause }
          : { field, op: clause.op, value: clause.value },
      );
    appendFilterClauses(filters, conditions, params, "cn");
  }

  // Parse sort: optional "-" prefix → descending, otherwise ascending.
  // Built-in columns sort directly; any other field sorts by that
  // node_attribute's value (parameterised, missing → last), matching
  // executeView so the two query surfaces agree.
  let orderBy = UNSORTED_ORDER_CN;
  if (body.sort) {
    const desc = body.sort.startsWith("-");
    const field = desc ? body.sort.slice(1) : body.sort;
    const dir = desc ? "DESC" : "ASC";
    if (SORT_WHITELIST.has(field) || BUILT_IN_FIELDS.has(field)) {
      orderBy = field === "sort_order" ? (dir === "DESC" ? MANUAL_ORDER_CN_DESC : MANUAL_ORDER_CN_ASC) : `cn.${sqlIdentifier(field)} ${dir} NULLS LAST`;
    } else if (field) {
      // Typed like a saved view's sort (numbers as numbers, dates as dates).
      orderBy = attributeSortSql(field, dir, params, "cn").join(", ");
    }
  }
  const page: PageInput = { limit: body.limit ?? 50, offset: body.offset ?? 0 };

  const whereClause = conditions.length > 0 ? "AND " + conditions.join(" AND ") : "";
  // Audit #1: hits are bounded by the COMBINED read set (role/tag-policy
  // visibility ∩ bearer-token tag scope). As a PUSHED-DOWN predicate, LIMIT/OFFSET
  // now land on already-authorized rows — no more false pagination (a page
  // silently shrinking when restricted rows were .filter()-ed out after the fact,
  // leaving a wrong `next`).
  const scopeClause = readableScopeSql(actor, "cn", params);
  // A tag query lists the block nodes carrying the tag in the same list (§9). `where` names a note's fields, which a
  // block has none of, so a query with `where` lists notes only.
  const blocks = body.tags?.length && !body.where
    ? blockQuerySql(params, { tagIds: tagMembers, actor, within })
    : null;
  const hits = `WITH hits AS (
    SELECT cn.id AS note_id, NULL::uuid AS block_id, NULL::text AS block_ref, NULL::text AS label, NULL::timestamptz AS block_at
      FROM content_nodes cn
     WHERE cn.workspace_id = $1 AND cn.hidden = false AND ${liveNodeSql("cn")}
       AND ${LISTED_NODE_SQL("cn")} ${whereClause}
       AND ${scopeClause}
    ${blocks ? `UNION ALL ${blocks}` : ""}
  )`;
  const from = "FROM hits h JOIN content_nodes cn ON cn.id = h.note_id";
  // A block sorts with its note (the note's sort value), right after the note itself.
  const order = `ORDER BY ${orderBy}, cn.id ASC, h.block_id IS NOT NULL, h.block_at, h.block_id`;
  const countParams = [...params];
  // One probe row past the page says whether a next page exists; `count(*)
  // OVER ()` is the whole match, so the block says "120 matches", not the
  // page length (D66). LIMIT/OFFSET bound: services/paging.pageSql.
  const sql = `${hits}
    SELECT cn.id, cn.title, cn.slug, cn.updated_at, h.block_id::text, h.block_ref, h.label, count(*) OVER () AS total
    ${from}
    ${order}
    ${pageSql(page, params)}
  `;
  type Hit = { id: string; title: string; slug: string; updated_at: string; block_id: string | null; block_ref: string | null; label: string | null; total: string };
  const result = await q<Hit>(sql, params);
  // An offset past the end returns no row to read the total from.
  const total = result.rows.length > 0
    ? Number(result.rows[0]!.total)
    : page.offset === 0 ? 0 : Number((await q<{ total: string }>(
      // Same ORDER BY so every bound sort parameter is still referenced.
      `${hits} SELECT count(*) OVER () AS total ${from} ${order} LIMIT 1`, countParams,
    )).rows[0]?.total ?? 0);
  // A Page (services/paging.ts): a note's row, or a block's — its note's id, title and slug, with the block.
  const { rows, next } = pageOf(result.rows.map(({ total: _total, block_id, block_ref, label, ...note }) =>
    block_id === null ? note : { ...note, block: { id: block_id, ref: block_ref ?? "", label: label ?? "" } }), page);
  return { rows, total, next };
}
