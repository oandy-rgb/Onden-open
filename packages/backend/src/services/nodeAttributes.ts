import { pool } from "../db.js";
import { effectiveTagFields, loadTagFieldRows } from "./tagFields.js";
import { readableScopeSql } from "./readPolicy.js";
import { subtreeIds } from "./nodeTree.js";
import { numericValueSql } from "./attributeNumber.js";
import { memberTagIdsNamed } from "./tagHierarchy.js";
import type { ActorCtx } from "../types.js";
import { liveNodeSql, liveTagNodeSql } from "../spine/nodeSql.js";

// Synthesized-attribute computation extracted from routes/nodes.ts so the route
// handlers stay thin and these recursive-CTE walks are integration-testable in
// isolation. Both are read-only and re-compute on every call (fine at
// dogfood scale — see the rollup note below).

export type RollupAttribute = {
  key: string;
  label: string;
  value: number;
  op: string;
  /** The tag name the rollup counts or reads from (no leading #), if it is limited to one. */
  tag: string | null;
  /** The attribute key a sum / max / min reads. */
  attr: string | null;
};

// Rollup attributes (synthesized — Knuth bottom-up). For every applied class
// tag's schema fields whose `rollup` is set, walks descendants (nodeTree.ts)
// and computes the aggregate. Returns one entry per matched field with the
// computed numeric value and a label describing the operation, e.g. "count
// #task" or "sum hours". Depth-capped at 10.
//
// Worth noting: read-only, re-computed per call. For dogfood-scale workspaces
// (< a few thousand nodes) the walk is sub-millisecond; if it ever shows up
// in profiling, the answer is a materialised cache invalidated by parent_id /
// node_attributes changes, not pre-aggregation in the schema.
//
// Only descendants the caller can READ are aggregated: a count or sum over a
// restricted child would otherwise leak its existence and its values through
// the parent's rollup.
export async function computeRollupAttributes(
  actor: ActorCtx,
  workspaceId: string,
  nodeId: string,
): Promise<RollupAttribute[]> {
  // The rollup fields of the tags applied to this node — each tag's effective
  // fields, its own and those it inherits (tagFields.ts); a field two tags
  // give is computed once.
  type RollupField = { name: string; label?: string; rollup?: { op: string; tag?: string; attr?: string } };
  const tagIds = (await pool.query<{ id: string }>(
    `SELECT t.id FROM content_nodes t JOIN node_tags nt ON nt.tag_id = t.id
      WHERE nt.node_id = $1 AND t.workspace_id = $2 AND ${liveTagNodeSql("t")}`,
    [nodeId, workspaceId],
  )).rows.map((row) => row.id);
  const effective = tagIds.length ? effectiveTagFields(await loadTagFieldRows(workspaceId)) : new Map();
  const byName = new Map<string, RollupField>();
  for (const id of tagIds) {
    for (const field of (effective.get(id) ?? []) as RollupField[]) if (field.rollup && !byName.has(field.name)) byName.set(field.name, field);
  }
  const fieldRows = { rows: [...byName.values()].map((field) => ({ field })) };

  const computed: RollupAttribute[] = [];
  // The live descendants up to ten levels down, the node itself excluded;
  // walked once for all rollup fields. A trashed node rolls up nothing.
  let descendants: string[] | undefined;
  for (const row of fieldRows.rows) {
    const field = row.field;
    const rollup = field.rollup;
    if (!rollup) continue;
    descendants ??= await subtreeIds(workspaceId, nodeId, { lifecycle: "live", maxDepth: 10 });

    const params: unknown[] = [descendants, workspaceId];
    // The tag by name, as /api/query reads `tags` (D50): every tag with that
    // title, case-insensitively, and their members — child tags (task/bug)
    // and the tags extending them (tagHierarchy.memberTagIdsNamed).
    let tagClause = "";
    if (rollup.tag) {
      // The hint the editor shows reads "#name"; a tag's title has no "#".
      params.push(await memberTagIdsNamed(workspaceId, [rollup.tag.replace(/^#/, "")]));
      tagClause = `AND EXISTS (
        SELECT 1 FROM node_tags nt WHERE nt.node_id = d.id AND nt.tag_id = ANY($${params.length}::uuid[])
      )`;
    }

    let valueSql: string;
    if (rollup.op === "count") {
      const scope = readableScopeSql(actor, "rn", params);
      valueSql = `SELECT COUNT(*)::float AS v FROM unnest($1::uuid[]) AS d(id)
                  JOIN content_nodes rn ON rn.id = d.id
                  WHERE rn.workspace_id = $2 AND ${scope} ${tagClause}`;
    } else {
      // sum / max / min: requires attr key
      if (!rollup.attr) continue;
      params.push(rollup.attr);
      const attrIdx = params.length;
      const scope = readableScopeSql(actor, "rn", params);
      const fn = rollup.op === "sum" ? "SUM" : rollup.op === "max" ? "MAX" : "MIN";
      // Only stored numbers count (numericValueSql, the read typed sorts and
      // filters use): "2h", "1e3" or "NaN" is skipped, not cast. The aggregate
      // stays numeric — pg hands it over as a string, read with Number().
      valueSql = `SELECT COALESCE(${fn}(${numericValueSql("na")}), 0) AS v
                  FROM unnest($1::uuid[]) AS d(id)
                  JOIN content_nodes rn ON rn.id = d.id
                  JOIN node_attributes na ON na.node_id = d.id AND na.key = $${attrIdx}
                  WHERE rn.workspace_id = $2 AND ${scope} ${tagClause}`;
    }

    // No catch: the numeric read can't fail on a stored value, so an error
    // here is a real one and must not vanish with the rollup.
    const result = await pool.query<{ v: number | string }>(valueSql, params);
    const value = Number(result.rows[0]?.v ?? 0);
    computed.push({
      key: field.name,
      label: field.label ?? field.name,
      value,
      op: rollup.op,
      tag: rollup.tag ? rollup.tag.replace(/^#/, "") : null,
      attr: rollup.attr ?? null,
    });
  }

  return computed;
}

export type InheritedAttribute = {
  key: string;
  value: string;
  value_type: string;
  source_node_id: string;
  source_node_title: string;
  depth: number;
};

// Inherited attributes: walks up the parent_id chain and returns every
// is_inheritable=true attribute from ancestors that isn't already set locally.
// Lowest-depth ancestor wins for any given key — closest parent's value reaches
// the descendant. Depth capped at 10 as a sanity guard against accidental
// cycles (parent_id is single-valued so true cycles shouldn't exist, but
// defensive).
export async function computeInheritedAttributes(
  workspaceId: string,
  nodeId: string,
): Promise<InheritedAttribute[]> {
  const result = await pool.query<InheritedAttribute>(
    `WITH RECURSIVE ancestors AS (
       SELECT id, parent_id, title, 0 AS depth
       FROM content_nodes
       WHERE id = $1 AND workspace_id = $2 AND ${liveNodeSql()}
       UNION ALL
       SELECT n.id, n.parent_id, n.title, a.depth + 1
       FROM content_nodes n
       JOIN ancestors a ON n.id = a.parent_id
       WHERE a.depth < 10 AND n.workspace_id = $2 AND ${liveNodeSql("n")}
     )
     SELECT na.key, na.value, na.value_type,
            a.id AS source_node_id, a.title AS source_node_title, a.depth
     FROM ancestors a
     JOIN node_attributes na ON na.node_id = a.id
     WHERE a.depth > 0
       AND na.is_inheritable = true
       AND na.workspace_id = $2
       AND na.key NOT LIKE '\\_%' ESCAPE '\\'
     ORDER BY a.depth ASC, na.key ASC`,
    [nodeId, workspaceId],
  );

  // Filter out keys already set locally — they win over any inheritance — and
  // deduplicate so the closest ancestor's value is the one returned.
  const local = await pool.query<{ key: string }>(
    `SELECT key FROM node_attributes WHERE node_id = $1 AND workspace_id = $2`,
    [nodeId, workspaceId],
  );
  const localKeys = new Set(local.rows.map((r) => r.key));
  const seen = new Set<string>();
  const out: InheritedAttribute[] = [];
  for (const row of result.rows) {
    if (localKeys.has(row.key) || seen.has(row.key)) continue;
    seen.add(row.key);
    out.push(row);
  }
  return out;
}
