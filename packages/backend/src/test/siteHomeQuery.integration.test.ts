// The site's fallback home (siteHome.ts) counts the pages of each space once instead of once per candidate. The result
// must be the one the old query gave, ties included: the top note of the space with the most pages, then the old
// tie-breaks. The old SQL is kept here as the reference. Its cost is checked by the shape of the query plan, not by a clock.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { HOME_SQL, siteHomeFor } from "../modules/website/publishing/siteHome.js";
import { seedQ } from "./helpers/seedQ.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const OLD_FALLBACK = `SELECT (SELECT n.id::text FROM content_nodes n
              WHERE n.workspace_id = w.id AND n.id = ANY($2::uuid[])
                AND n.hidden = false AND n.deleted_at IS NULL AND n.node_type <> 'class_tag'
              ORDER BY (SELECT count(*) FROM content_nodes m
                         WHERE m.id = ANY($2::uuid[]) AND m.space_id IS NOT DISTINCT FROM n.space_id) DESC,
                       (n.parent_id IS NULL OR n.parent_id <> ALL($2::uuid[])) DESC,
                       NOT EXISTS (
                         SELECT 1 FROM node_tags nt
                           JOIN content_nodes t ON t.id = nt.tag_id AND t.node_type = 'class_tag'
                            AND t.deleted_at IS NULL AND t.tag_schema IS NOT NULL
                          WHERE nt.node_id = n.id) DESC,
                       n.slug = 'home' DESC,
                       array_position($2::uuid[], n.id)
              LIMIT 1) AS fallback
       FROM workspaces w WHERE w.id = $1`;

/** `nested`: every page after the first sits under an earlier page of the site (a tree: most pages have a parent on
 *  the site), which is the shape that makes `parent_id <> ALL(ids)` cost per candidate. */
async function seedSite(pagesPerSpace: number[], opts: { nested?: boolean } = {}): Promise<{ ws: string; ids: string[] }> {
  const ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Home query', $1) RETURNING id::text`, [`home-query-${randomUUID()}`])).rows[0]!.id;
  const ids: string[] = [];
  for (const [i, count] of pagesPerSpace.entries()) {
    const space = (await q<{ id: string }>(`INSERT INTO spaces (workspace_id, name, kind, capabilities) VALUES ($1, $2, 'shared', '{"publish": true}') RETURNING id::text`, [ws, `Space ${i}`])).rows[0]!.id;
    const rows = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
       SELECT $1, 'manual', 'content', 'Note ' || g, CASE WHEN g = 3 THEN 'home' ELSE 'n-' || $3 || '-' || g END, 'words', $2
         FROM generate_series(1, $4::int) g RETURNING id::text`, [ws, space, String(i), count]);
    const mine = rows.rows.map((r) => r.id);
    if (opts.nested && mine.length > 1) {
      // Each page after the first goes under the page half way back in the list: a binary tree.
      await seedQ(`WITH numbered AS (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM unnest($1::uuid[]) AS id)
                   UPDATE content_nodes c SET parent_id = p.id
                     FROM numbered k JOIN numbered p ON p.rn = k.rn / 2 WHERE c.id = k.id AND k.rn > 1`, [mine]);
    }
    ids.push(...mine);
  }
  return { ws, ids };
}

const oldHome = async (ws: string, ids: string[]) => (await q<{ fallback: string | null }>(OLD_FALLBACK, [ws, ids])).rows[0]!.fallback;

describe.skipIf(!isTestDatabase())("the fallback home query", () => {
  it("picks what the old query picked, with ties between spaces and a note that is a child of another", async () => {
    for (const shape of [[5, 5], [3, 7, 7], [1], [4, 4, 4]]) {
      const { ws, ids } = await seedSite(shape);
      // A child page whose parent is on the site ranks behind a plain top note.
      await seedQ(`UPDATE content_nodes SET parent_id = $2 WHERE id = $1`, [ids[1], ids[0]]);
      const published = ids.map((id) => ({ id }));
      expect(await siteHomeFor(ws, published), JSON.stringify(shape)).toBe(await oldHome(ws, ids) ?? ids[0]);
    }
  });

  it("a tree where most pages have a parent on the site, and a page tagged with a schema tag, rank as before", async () => {
    for (const shape of [[15], [9, 6], [7, 7, 7]]) {
      const { ws, ids } = await seedSite(shape, { nested: true });
      // The first page of each space is its root; tag the first space's root with a schema tag: it ranks behind an untagged one.
      const tag = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_schema)
         VALUES ($1, 'manual', 'class_tag', 'Paper', 'paper-' || $2, '', '{"fields": []}') RETURNING id::text`, [ws, randomUUID().slice(0, 6)])).rows[0]!.id;
      await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [ids[0], tag]);
      const published = ids.map((id) => ({ id }));
      expect(await siteHomeFor(ws, published), JSON.stringify(shape)).toBe(await oldHome(ws, ids) ?? ids[0]);
    }
  });

  it("notes with no space and notes in a space are counted as two groups, as before", async () => {
    for (const shape of [[4, 3], [2, 6], [5]]) {
      const { ws, ids } = await seedSite(shape);
      // The last three pages of the list sit in no space (space_id NULL): they are a group of their own, and may be the largest.
      await seedQ(`UPDATE content_nodes SET space_id = NULL WHERE id = ANY($1::uuid[])`, [ids.slice(-3)]);
      expect(await siteHomeFor(ws, ids.map((id) => ({ id }))), JSON.stringify(shape)).toBe(await oldHome(ws, ids) ?? ids[0]);
    }
  });

  it("1 note, none, and a site whose notes sit in no space", async () => {
    const { ws, ids } = await seedSite([2]);
    await seedQ(`UPDATE content_nodes SET space_id = NULL WHERE workspace_id = $1`, [ws]);
    expect(await siteHomeFor(ws, ids.map((id) => ({ id })))).toBe(await oldHome(ws, ids));
    expect(await siteHomeFor(ws, [])).toBeNull();
  });

  // The quadratic form counted a space's pages inside the ORDER BY: a count in a SubPlan that runs once per candidate
  // (6,000 pages took 9 s, measured 2026-11-11; the current query 0.1 s). The plan, not the clock, tells them apart: a
  // per-row aggregate is there in the old query and not in the current one.
  it("counts the pages of a space once, not once per candidate (the plan has no per-row count)", async () => {
    const { ws, ids } = await seedSite([30, 20], { nested: true });
    type Plan = { "Node Type": string; Strategy?: string; "Parent Relationship"?: string; Plans?: Plan[] };
    const perRowAggregates = async (sql: string) => {
      const rows = (await q<{ "QUERY PLAN": Array<{ Plan: Plan }> }>(`EXPLAIN (FORMAT JSON) ${sql}`, [ws, ids])).rows;
      const found: Plan[] = [];
      const walk = (node: Plan, inSubPlan: boolean) => {
        // An InitPlan (the WITH) runs once, wherever it hangs; a SubPlan runs once per row of what it is in.
        const relation = node["Parent Relationship"];
        const here = relation === "InitPlan" ? false : inSubPlan || relation === "SubPlan";
        // A plain aggregate (a bare count(*)) inside a SubPlan is a count made again for each row; the WITH's one count
        // per space is a grouped aggregate.
        if (here && node["Node Type"] === "Aggregate" && node.Strategy === "Plain") found.push(node);
        for (const child of node.Plans ?? []) walk(child, here);
      };
      walk(rows[0]!["QUERY PLAN"][0]!.Plan, false);
      return found.length;
    };
    expect(await perRowAggregates(OLD_FALLBACK), "the old query, as the control").toBeGreaterThan(0);
    expect(await perRowAggregates(HOME_SQL)).toBe(0);
  });
});
