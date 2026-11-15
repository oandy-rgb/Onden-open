// The SQL edge rule against the shared link-target fixture
// (packages/markdown/src/fixtures/wikilinkTargets.json): which notes a
// `[[link]]` becomes an edge to (syncWikilinkEdges, linkMatchesNodeSql). The
// app (resolveWikilink) and the site (servedLinkTarget) are held to the same
// answers by their own tests, so the three rules cannot drift apart unseen.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { q, withTransaction } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { relinkTarget, syncWikilinkEdges } from "../services/wikilinkEdges.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = isTestDatabase();

type FixtureNote = { id: string; title: string; slug: string; space: string; aliases?: string[]; deleted?: boolean; type?: string };
const fixture = JSON.parse(readFileSync(new URL("../../../markdown/src/fixtures/wikilinkTargets.json", import.meta.url), "utf8")) as {
  notes: FixtureNote[]; cases: Array<{ name: string; from: string; link: string; reaches: string[]; opens: string | null }>;
};

describe.skipIf(!isTestDb)("wikilink targets in SQL (shared fixture)", () => {
  let ws = "";
  const rowId = new Map<string, string>();
  const nameOfRow = new Map<string, string>();

  beforeAll(async () => {
    // Its own workspace: the fixture's titles must not meet other tests' notes.
    const stamp = `wl-fixture-${Date.now()}`;
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id::text`, [stamp])).rows[0]!.id;
    const spaces = new Map<string, string>();
    for (const space of new Set(fixture.notes.map((n) => n.space))) {
      spaces.set(space, (await q<{ id: string }>(
        `INSERT INTO spaces (workspace_id, name, kind) VALUES ($1, $2, 'shared') RETURNING id::text`, [ws, space],
      )).rows[0]!.id);
    }
    for (const n of fixture.notes) {
      const id = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, space_id, source_type, node_type, title, slug, deleted_at)
         VALUES ($1, $2, 'manual', $3, $4, $5, CASE WHEN $6 THEN now() END) RETURNING id::text`,
        [ws, spaces.get(n.space), n.type ?? "content", n.title, n.slug, n.deleted === true],
      )).rows[0]!.id;
      rowId.set(n.id, id);
      nameOfRow.set(id, n.id);
      if (n.aliases) {
        await seedQ(
          `INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, $2, 'aliases', $3, 'frontmatter')`,
          [ws, id, JSON.stringify(n.aliases)],
        );
      }
    }
  });

  for (const c of fixture.cases) {
    it(c.name, async () => {
      const targets = await withTransaction(() => syncWikilinkEdges(ws, rowId.get(c.from)!, `See [[${c.link}]] here.`));
      const reached = targets.map((t) => nameOfRow.get(t.id)!);
      // Fixture order = the order a person reads the answer in; SQL returns rows in any order.
      expect(reached.sort((a, b) => fixture.notes.findIndex((n) => n.id === a) - fixture.notes.findIndex((n) => n.id === b)))
        .toEqual(c.reaches);
    });
  }

  // The other side: a change to what names a note re-derives the edges INTO it
  // (relinkTarget), through a text pre-filter assembled by hand in wikilinkEdges.ts.
  // It must find every link the exact rule above names.
  for (const c of fixture.cases.filter((x) => x.reaches.length > 0)) {
    it(`relinkTarget finds: ${c.name}`, async () => {
      const from = rowId.get(c.from)!;
      await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [from, `See [[${c.link}]] here.`]);
      await seedQ(`DELETE FROM node_edges WHERE source_node_id = $1 AND origin = 'wikilink'`, [from]);
      await withTransaction(() => relinkTarget(ws, c.reaches.map((id) => rowId.get(id)!)));
      const edges = (await q<{ target_node_id: string }>(
        `SELECT target_node_id::text FROM node_edges WHERE source_node_id = $1 AND origin = 'wikilink' AND status = 'active'`, [from],
      )).rows.map((r) => nameOfRow.get(r.target_node_id)!);
      expect(edges.sort()).toEqual([...c.reaches].sort());
    });
  }
});
