// relinkTarget finds the notes linking to a name through note_link_index
// (migration 146) and reads the text only of notes without a row. Both ways
// must give the edges the text-reading rule gives: each scenario runs the same
// stale edges through relinkTarget twice, once with the index and once with
// every row stale (every note read from its text), and compares.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q, withTransaction } from "../db.js";
import { createNote } from "../services/noteCreate.js";
import { trashNode } from "../services/nodeTrash.js";
import { indexMissingNoteLinks, relinkTarget, syncWikilinkEdges } from "../services/wikilinkEdges.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));

type EdgeRow = { source_node_id: string; target_node_id: string; edge_type: string; status: string; origin: string };

describe.skipIf(!isTestDb)("relinkTarget through the link index equals reading the texts", () => {
  let actor: ActorCtx = { id: "relink-index-admin", name: "Indexer", role: "admin", type: "human" };
  let spaceA = "";
  let spaceB = "";
  const stamp = () => randomUUID().replace(/-/g, "").slice(0, 8);

  const note = async (title: string, markdown: string, spaceId = spaceA) =>
    (await createNote({ actor, workspaceId, title, markdown, spaceId, event: { uiContext: "test.relinkIndex" } })).node.id as string;
  const tagNote = async (title: string) => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1, 'manual', 'class_tag', $2, $3, '') RETURNING id::text`,
    [workspaceId, title, `tag-${title.toLowerCase().replace(/\s+/g, "-")}`],
  )).rows[0]!.id;
  const edges = async (): Promise<EdgeRow[]> => (await q<EdgeRow>(
    `SELECT source_node_id::text, target_node_id::text, edge_type, status, origin FROM node_edges
      WHERE workspace_id = $1 AND origin = 'wikilink' ORDER BY source_node_id, target_node_id`, [workspaceId],
  )).rows;
  const putEdges = async (rows: EdgeRow[]) => {
    await seedQ(`DELETE FROM node_edges WHERE workspace_id = $1 AND origin = 'wikilink'`, [workspaceId]);
    for (const e of rows) {
      await seedQ(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) VALUES ($1,$2,$3,$4,$5,$6)`,
        [workspaceId, e.source_node_id, e.target_node_id, e.edge_type, e.status, e.origin]);
    }
  };
  const indexed = async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM note_link_index WHERE workspace_id = $1 AND NOT stale`, [workspaceId])).rows[0]!.n);

  /** The stale edges `before`, relinked for `ids` with the index and without it. */
  async function bothWays(ids: string[]) {
    const before = await edges();
    await withTransaction(() => relinkTarget(workspaceId, ids));
    const viaIndex = await edges();
    await putEdges(before);
    const saved = (await q(`SELECT note_id, workspace_id, link_lc, link_slug, stale FROM note_link_index WHERE workspace_id = $1`, [workspaceId])).rows;
    await q(`UPDATE note_link_index SET stale = true WHERE workspace_id = $1`, [workspaceId]);
    await withTransaction(() => relinkTarget(workspaceId, ids));
    const viaText = await edges();
    await seedQ(`DELETE FROM node_edges WHERE workspace_id = $1 AND origin = 'wikilink'`, [workspaceId]);
    await putEdges(viaIndex);
    for (const r of saved) {
      await q(`UPDATE note_link_index SET link_lc = $2, link_slug = $3, stale = $4 WHERE note_id = $1`, [r.note_id, r.link_lc, r.link_slug, r.stale]);
    }
    return { before, viaIndex, viaText };
  }

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('RelinkIndex', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
    spaceA = await makeSpace(workspaceId, `A ${stamp()}`, [{ id: actor.id, role: "manager" }]);
    spaceB = await makeSpace(workspaceId, `B ${stamp()}`, [{ id: actor.id, role: "manager" }]);
  });

  it("a rename, aliases, a node reference, a tag and a recreated title give the same edges both ways", async () => {
    const s = stamp();
    const alpha = await note(`Old name ${s}`, "target one");
    const beta = await note(`Beta ${s}`, "target two");
    const gamma = await note(`Gamma ${s}`, "target three");
    const tag = await tagNote(`reading ${s}`);
    const old = await note(`Old Delta ${s}`, "will be trashed");
    const links = [
      `[[Alpha Name ${s}]]`, `[[ALPHA NAME ${s}|shown]]`, `[[alpha name ${s}#Goals]]`, `[[alpha-name-${s}]]`,
      `[[AK${s}]]`, `[[Al${s}]]`, `[[Alt Name ${s}]]`, `[[onden://node/${gamma}]]`,
      `[[study ${s}]]`, `[[Study ${s}]]`, `[[Delta ${s}]]`, `![[Alpha Name ${s}]]`, `[[Ａlpha Name ${s}]]`,
    ];
    const sources = new Map<string, string>();
    for (const [i, link] of links.entries()) sources.set(link, await note(`Source ${i} ${s}`, `see ${link} here`));
    sources.set("other-space", await note(`Source far ${s}`, `see [[Alpha Name ${s}]] and [[study ${s}]]`, spaceB));
    sources.set("many", await note(`Source many ${s}`, links.join("\n")));
    sources.set("prose", await note(`Source prose ${s}`, `Alpha Name ${s} without brackets, AK${s}`));
    sources.set("trashed", await note(`Source trashed ${s}`, `see [[Alpha Name ${s}]]`));
    await trashNode(actor, workspaceId, sources.get("trashed")!);

    // What names each target changes without relinking: the edges go stale.
    await seedQ(`UPDATE content_nodes SET title = $2, slug = $3 WHERE id = $1`, [alpha, `Alpha Name ${s}`, `alpha-name-${s}`]);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1,$2,'aliases',$3,'text','ui')`,
      [workspaceId, beta, JSON.stringify([`Al${s}`, `alt name ${s}`])]);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1,$2,'aliases',$3,'text','ui')`,
      [workspaceId, alpha, `ak${s}`]);
    await seedQ(`UPDATE content_nodes SET title = $2, slug = $3 WHERE id = $1`, [tag, `Study ${s}`, `study-${s}`]);
    const delta = await note(`Delta ${s}`, "recreated after the trash of the old one");
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [old]);

    expect(await indexed()).toBeGreaterThan(sources.size);
    const ids = [alpha, beta, gamma, tag, delta];
    const { before, viaIndex, viaText } = await bothWays(ids);
    expect(viaIndex).toEqual(viaText);
    // Not a vacuous comparison: the rename wired links the stale edges lacked.
    expect(viaIndex.length).toBeGreaterThan(before.length);
    const to = (id: string) => viaIndex.filter((e) => e.target_node_id === id).map((e) => e.source_node_id);
    expect(to(alpha)).toContain(sources.get(`[[Alpha Name ${s}]]`));
    expect(to(alpha)).toContain(sources.get(`[[alpha-name-${s}]]`));
    expect(to(alpha)).toContain(sources.get(`[[AK${s}]]`));
    expect(to(alpha)).not.toContain(sources.get("other-space"));
    expect(to(alpha)).not.toContain(sources.get("prose"));
    expect(to(beta)).toContain(sources.get(`[[Alt Name ${s}]]`));
    expect(to(gamma)).toContain(sources.get(`[[onden://node/${gamma}]]`));
    expect(to(tag)).toContain(sources.get("other-space"));
    expect(to(delta)).toContain(sources.get(`[[Delta ${s}]]`));
  });

  it("a text changed behind syncWikilinkEdges's back is read from the text, not from a stale row", async () => {
    const s = stamp();
    const target = await note(`Target ${s}`, "");
    const src = await note(`Src ${s}`, "nothing yet");
    expect(await indexed()).toBeGreaterThan(0);
    // No sync: the trigger makes the row stale, so the new link is found in the text.
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [src, `now [[Target ${s}]]`]);
    expect((await q(`SELECT stale FROM note_link_index WHERE note_id = $1`, [src])).rows[0]).toEqual({ stale: true });
    await withTransaction(() => relinkTarget(workspaceId, [target]));
    expect((await edges()).some((e) => e.source_node_id === src && e.target_node_id === target)).toBe(true);
  });

  it("an embed-only note is read from its text whichever plan Postgres picks", async () => {
    // The pgroonga text index reads "![[" as one token, so a LIKE '%[[%' it
    // answered dropped "see ![[Name]]"; that plan won only under some table
    // statistics (a full suite run), so it is forced here.
    const s = stamp();
    const target = await note(`Embedded ${s}`, "");
    const src = await note(`Embedder ${s}`, "nothing yet");
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [src, `see ![[Embedded ${s}]] here`]);
    await withTransaction(async () => {
      for (const plan of ["seqscan", "indexscan", "nestloop", "mergejoin"]) await q(`SET LOCAL enable_${plan} = off`);
      await withTransaction(() => relinkTarget(workspaceId, [target]));
    });
    expect((await edges()).some((e) => e.source_node_id === src && e.target_node_id === target)).toBe(true);
  });

  it("indexMissingNoteLinks writes the rows syncWikilinkEdges writes", async () => {
    const s = stamp();
    const src = await note(`Indexed ${s}`, `see [[Some Name ${s}#Part|shown]] and [[other-${s}]]`);
    const row = async () => (await q<{ link_lc: string[]; link_slug: string[]; stale: boolean }>(`SELECT link_lc, link_slug, stale FROM note_link_index WHERE note_id = $1`, [src])).rows[0]!;
    const written = await row();
    expect(written.stale).toBe(false);
    expect(written.link_lc).toContain(`some name ${s}`);
    await q(`UPDATE note_link_index SET link_lc = '{}', link_slug = '{}', stale = true WHERE note_id = $1`, [src]);
    expect(await indexMissingNoteLinks({ workspaceId })).toBeGreaterThan(0);
    expect(await row()).toEqual(written);
    // A note whose text has no link is indexed too (a stale row would mean "read me"); a note without a row gets one.
    const plain = await note(`Plain ${s}`, "no links");
    await q(`DELETE FROM note_link_index WHERE note_id = $1`, [plain]);
    await indexMissingNoteLinks({ workspaceId });
    expect((await q(`SELECT link_lc, stale FROM note_link_index WHERE note_id = $1`, [plain])).rows[0]).toEqual({ link_lc: [], stale: false });
    // Syncing again keeps one row per note.
    const { markdown } = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [src])).rows[0]!;
    await withTransaction(() => syncWikilinkEdges(workspaceId, src, markdown));
    expect((await q(`SELECT 1 FROM note_link_index WHERE note_id = $1`, [src])).rowCount).toBe(1);
  });
});
