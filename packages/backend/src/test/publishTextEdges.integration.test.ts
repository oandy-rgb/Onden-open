// The snapshot's edges (modules/website/publishing/textEdges.ts): links and
// embeds between PUBLISHED notes are edges even when no `node_edges` row was
// ever written for them (an import or restore that skipped the save path); a
// link to a note kept off the site never is, and nothing of that note reaches
// the serialized snapshot. Backlinks and the graph read these edges only.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { buildCandidate } from "../modules/website/publishing/snapshot.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishDefaultSpace } from "./helpers/spaceFixtures.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let WS = "";
let stamp = "";
async function note(title: string, markdown: string, published: boolean): Promise<string> {
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,$4) RETURNING id`,
    [WS, title, `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${stamp}`, markdown],
  )).rows[0]!.id;
  await seedQ(
    `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1, $2, '_published', $3, 'bool')`,
    [WS, id, published ? "true" : "false"],
  );
  return id;
}

describe.skipIf(!isTestDb)("snapshot edges come from published text (DB)", () => {
  let a = "", b = "", c = "", secret = "";
  beforeEach(async () => {
    stamp = randomUUID().slice(0, 8);
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Edges', $1) RETURNING id::text`, [`edges-${stamp}`])).rows[0]!.id;
    await publishDefaultSpace(WS);
    // No syncWikilinkEdges here: the rows are missing, as for an imported note.
    b = await note("Beta", "beta body", true);
    c = await note("Gamma", "gamma body", true);
    secret = await note("Secret plan", "private words", false);
    a = await note("Alpha", "See [[Beta]] and [[Secret plan]] and [[Secret plan|my plan]]. ![[Gamma]] [[Alpha]] [[Nowhere]]", true);
  });

  it("has an edge for each published link or embed, and none for a private or missing target", async () => {
    const { payload } = await buildCandidate(WS, { title: "Site" });
    const edges = payload.edges as Array<{ source_node_id: string; target_node_id: string; edge_type: string }>;
    expect(edges.map((e) => `${e.source_node_id}>${e.target_node_id}`).sort()).toEqual([`${a}>${b}`, `${a}>${c}`].sort());
    expect(edges.every((e) => e.edge_type === "knowledge_link")).toBe(true);
  });

  it("puts nothing of a private note in the serialized snapshot", async () => {
    const { payload } = await buildCandidate(WS, { title: "Site" });
    const text = JSON.stringify(payload);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("Secret plan");
    expect(text).not.toContain("private words");
  });

  it("keeps a stored edge and does not repeat it", async () => {
    await seedQ(
      `INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) VALUES ($1,$2,$3,'knowledge_link','active','wikilink')`,
      [WS, a, b],
    );
    const { payload } = await buildCandidate(WS, { title: "Site" });
    const edges = payload.edges as Array<{ source_node_id: string; target_node_id: string }>;
    expect(edges.filter((e) => e.source_node_id === a && e.target_node_id === b)).toHaveLength(1);
  });
});
