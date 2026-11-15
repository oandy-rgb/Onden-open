// Wikilink resolution for aliased / heading links and frontmatter aliases.
//
// Bug [wikilink-alias-heading-resolution]: [[Page|alias]] and [[Page#heading]]
// produced NO backlink edge (the raw inner text was matched against title/slug
// with no stripping), and imported frontmatter `aliases:` were never consulted.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { q, getWorkspaceId, withTransaction } from "../db.js";
import { syncWikilinkEdges } from "../services/nodes.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const stamp = Date.now();
async function seedNode(ws: string, title: string, slug: string, markdown = ""): Promise<string> {
  const r = await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,$4) RETURNING id`,
    [ws, title, slug, markdown],
  );
  return r.rows[0]!.id;
}

describe.skipIf(!isTestDb)("syncWikilinkEdges: alias / heading / frontmatter-alias resolution", () => {
  let WS = "";
  let targetId = "";
  let aliasTargetId = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();

    targetId = await seedNode(WS, `Target Page ${stamp}`, `target-page-${stamp}`);
    aliasTargetId = await seedNode(WS, `Real Title ${stamp}`, `real-title-${stamp}`);
    // Frontmatter import stores aliases as a JSON array string under key 'aliases'.
    await seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, source)
       VALUES ($1,$2,'aliases',$3,'frontmatter')
       ON CONFLICT (node_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [WS, aliasTargetId, JSON.stringify([`Nickname ${stamp}`, `Other Name ${stamp}`])],
    );
  });

  async function edgeTargets(sourceId: string): Promise<string[]> {
    const r = await q<{ target_node_id: string }>(
      `SELECT target_node_id FROM node_edges
        WHERE workspace_id=$1 AND source_node_id=$2 AND origin='wikilink' AND status='active'`,
      [WS, sourceId],
    );
    return r.rows.map((x) => x.target_node_id);
  }

  it("resolves an aliased wikilink [[Page|alias]] to the target", async () => {
    const src = await seedNode(WS, `Src alias ${stamp}`, `src-alias-${stamp}`,
      `See [[Target Page ${stamp}|the nice label]] here.`);
    await withTransaction(() => syncWikilinkEdges(WS, src, `See [[Target Page ${stamp}|the nice label]] here.`));
    expect(await edgeTargets(src)).toContain(targetId);
  });

  it("resolves a heading wikilink [[Page#heading]] to the target", async () => {
    const src = await seedNode(WS, `Src heading ${stamp}`, `src-heading-${stamp}`,
      `Jump to [[Target Page ${stamp}#Section Two]].`);
    await withTransaction(() => syncWikilinkEdges(WS, src, `Jump to [[Target Page ${stamp}#Section Two]].`));
    expect(await edgeTargets(src)).toContain(targetId);
  });

  it("resolves heading + alias together [[Page#h|label]]", async () => {
    const src = await seedNode(WS, `Src both ${stamp}`, `src-both-${stamp}`,
      `[[Target Page ${stamp}#Intro|shown text]]`);
    await withTransaction(() => syncWikilinkEdges(WS, src, `[[Target Page ${stamp}#Intro|shown text]]`));
    expect(await edgeTargets(src)).toContain(targetId);
  });

  it("resolves a wikilink to a node's imported frontmatter alias", async () => {
    const src = await seedNode(WS, `Src fm-alias ${stamp}`, `src-fm-alias-${stamp}`,
      `Linking by [[Nickname ${stamp}]].`);
    await withTransaction(() => syncWikilinkEdges(WS, src, `Linking by [[Nickname ${stamp}]].`));
    expect(await edgeTargets(src)).toContain(aliasTargetId);
  });

  it("does not fabricate an edge for an unrelated alias-less mention", async () => {
    const src = await seedNode(WS, `Src none ${stamp}`, `src-none-${stamp}`,
      `No links here, just the words Nickname and Target Page.`);
    await withTransaction(() => syncWikilinkEdges(WS, src, `No links here, just the words Nickname and Target Page.`));
    expect(await edgeTargets(src)).toEqual([]);
  });
});
