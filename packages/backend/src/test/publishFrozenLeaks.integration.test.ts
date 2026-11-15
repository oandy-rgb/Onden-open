// What a snapshot FREEZES about a note other than its own text, and whether a
// takedown reaches it. A snapshot is cut down at serve time (servedSite.applyTakedown):
// pages and edges of notes no longer public go, and every page's text is redacted
// again against the pages that remain. These tests ask the same of the other things
// the snapshot freezes at publish time: the excerpt and field values of the rows
// the home page and tag pages list, and the cells of a frozen onden-base table.
// Each is a title typed into published text that the takedown must also remove.
//
// Tests marked `it.fails` are CONFIRMED defects (review 2026-11-11,
// docs/archive/deep-review-publish-2026-11-11.md): the title of a note taken
// down is still served. They turn red the day the defect is fixed, which is the
// cue to change `it.fails` to `it`.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q, pool } from "../db.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
import { buildAndEnqueueSnapshot } from "../modules/website/publishing/snapshot.js";
import { forgetNodesInSnapshots } from "../services/purgedContent.js";
import { withTransaction } from "../db.js";
import { registerNodeHooks } from "../spine/nodeHooks.js";
import { websiteModule } from "../modules/website/index.js";
import { loadServedSite } from "../modules/website/publishing/servedSite.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const stamp = randomUUID().replace(/\D/g, "").slice(0, 8);
let owner: ActorCtx;
let tagId = "";
// Notes are on the site by their space (publishedSet.ts): `_published` alone does nothing in a space that does not publish.
let siteSpace = "";

async function note(title: string, markdown: string, opts: { published: boolean; tagged?: boolean; attrs?: Record<string, string> }): Promise<string> {
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,$4) RETURNING id::text`, [WS, title, `s-${randomUUID()}`, markdown],
  )).rows[0]!.id;
  await putInSpace(id, siteSpace);
  await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1,$2,'_published',$3,'bool')`, [WS, id, opts.published ? "true" : "false"]);
  for (const [key, value] of Object.entries(opts.attrs ?? {})) {
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1,$2,$3,$4,'text')`, [WS, id, key, value]);
  }
  if (opts.tagged) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [id, tagId]);
  return id;
}
// 「不發布」: in a space that publishes, a note is taken off the site by its own flag, not by having none.
const unpublish = async (id: string) => { await seedQ(`DELETE FROM node_attributes WHERE node_id = $1 AND key = '_published'`, [id]); await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1,$2,'_published','false','bool')`, [WS, id]); };
const publish = () => buildAndEnqueueSnapshot(WS, owner, { title: "Site" });
const servedJson = async () => JSON.stringify((await loadServedSite(WS)).payload);

describe.skipIf(!isTestDb)("what a snapshot freezes beside note text, after a takedown (DB)", () => {
  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Frozen leaks', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(WS, { id: "", name: "Owner", role: "admin", type: "human" });
    siteSpace = await makeSpace(WS, `Site ${stamp}`, [{ id: owner.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
    tagId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','class_tag',$2,$2,'') RETURNING id::text`, [WS, `tag${stamp}`],
    )).rows[0]!.id;
  });
  afterAll(async () => { await pool.end(); });

  it("control: a page's own text re-redacts at once when the note it links to is taken down", async () => {
    const target = await note(`Control target ${stamp}`, "x", { published: true });
    await note(`Control source ${stamp}`, `See [[Control target ${stamp}]] now.`, { published: true });
    await publish();
    expect(await servedJson()).toContain(`Control target ${stamp}`);
    await unpublish(target);
    expect(await servedJson()).not.toContain(`Control target ${stamp}`);
  });

  it("the excerpt a tag page / home listing froze for a note does not keep the title of a note taken down since", async () => {
    // Fix direction: takeDownDesign (siteRows.ts) rebuilds each row's `excerpt` from the served, re-redacted
    // markdown of its note, or the freeze stores no prose and the renderer derives it from served text.
    const target = await note(`Excerpt target ${stamp}`, "x", { published: true });
    await note(`Excerpt source ${stamp}`, `Closely tied to [[Excerpt target ${stamp}]] and more.`, { published: true, tagged: true });
    await publish();
    const before = await servedJson();
    expect(before).toContain(`Excerpt target ${stamp}`);
    await unpublish(target);
    // Every place the title still appears is a leak; the page text already passed the control above.
    expect(await servedJson()).not.toContain(`Excerpt target ${stamp}`);
  });

  it("a frozen onden-base cell does not keep the title of a note taken down since", async () => {
    // Fix direction: freezeQueryBlocks (queryBlocks.ts frozenBase) runs each cell through inertUnpublishedWikilinks
    // at freeze time, and keepServedQueryRows re-runs it against the served pages at serve time.
    const target = await note(`Cell target ${stamp}`, "x", { published: true });
    await note(`Cell row ${stamp}`, "row", { published: true, tagged: true, attrs: { related: `see [[Cell target ${stamp}]]` } });
    const base = ["```onden-base", "filters:", `  - 'file.hasTag("tag${stamp}")'`, "views:", "  - type: table", "    order: [file.name, related]", "```"].join("\n");
    await note(`Cell host ${stamp}`, `Table:\n\n${base}\n`, { published: true });
    await publish();
    expect(await servedJson()).toContain(`Cell target ${stamp}`);
    await unpublish(target);
    expect(await servedJson()).not.toContain(`Cell target ${stamp}`);
  });

  it("a frozen onden-base cell never names a note that was NOT published when the page was published", async () => {
    // Same defect at freeze time: the cell is the attribute value as typed, `[[Secret ...]]` included.
    await note(`Secret cell ${stamp}`, "private", { published: false });
    await note(`Plain row ${stamp}`, "row", { published: true, tagged: true, attrs: { related2: `see [[Secret cell ${stamp}]]` } });
    const base = ["```onden-base", "filters:", `  - 'file.hasTag("tag${stamp}")'`, "views:", "  - type: table", "    order: [file.name, related2]", "```"].join("\n");
    await note(`Plain host ${stamp}`, `Table:\n\n${base}\n`, { published: true });
    await publish();
    expect(await servedJson()).not.toContain(`Secret cell ${stamp}`);
  });

  it("a frozen onden-query row for a tagged block does not carry the raw label, wikilinks to unpublished notes included", async () => {
    // Fix direction: frozenQuery (queryBlocks.ts) builds the row label from the redacted text, or runs it
    // through inertUnpublishedWikilinks like the other frozen text; keepServedQueryRows re-runs it at serve time.
    await note(`Secret block ${stamp}`, "private", { published: false });
    const holder = await note(`Block holder ${stamp}`, "Thought on [[Secret block " + stamp + "]]", { published: true });
    const blockId = (await seedQ<{ id: string }>(
      `INSERT INTO block_nodes (workspace_id, note_id, block_ref, kind, label)
       VALUES ($1,$2,'blk1','paragraph',$3) RETURNING id::text`, [WS, holder, `Thought on [[Secret block ${stamp}]]`],
    )).rows[0]!.id;
    await seedQ(`INSERT INTO block_node_tags (block_node_id, tag_id, workspace_id) VALUES ($1,$2,$3)`, [blockId, tagId, WS]);
    const query = ["```onden-query", `tags: tag${stamp}`, "```"].join("\n");
    await note(`Block host ${stamp}`, `List:\n\n${query}\n`, { published: true });
    await publish();
    const json = await servedJson();
    expect(json).toContain("Block holder");
    expect(json).not.toContain(`Secret block ${stamp}`);
  });

  it("permanently deleting a note leaves its title in no stored snapshot, not in an excerpt or a table cell either", async () => {
    // The module's own hooks, as mountModules registers them at boot.
    registerNodeHooks("website", websiteModule.nodeHooks!);
    const target = await note(`Purged target ${stamp}`, "x", { published: true });
    await note(`Purged source ${stamp}`, `Closely tied to [[Purged target ${stamp}]] and more.`, { published: true, tagged: true, attrs: { related3: `see [[Purged target ${stamp}]]` } });
    const base = ["```onden-base", "filters:", `  - 'file.hasTag("tag${stamp}")'`, "views:", "  - type: table", "    order: [file.name, related3]", "```"].join("\n");
    await note(`Purged host ${stamp}`, `Table:\n\n${base}\n`, { published: true });
    await publish();
    const stored = async () => (await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM publish_snapshots WHERE workspace_id = $1 AND payload::text LIKE $2`, [WS, `%Purged target ${stamp}%`])).rows[0]!.n;
    expect(await stored()).not.toBe("0");
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [target]);
    await withTransaction(() => forgetNodesInSnapshots(WS, [target]));
    expect(await stored()).toBe("0");
  });

  it("control: a frozen onden-query row and a tag page row of a note taken down since are gone at once", async () => {
    const gone = await note(`Row gone ${stamp}`, "x", { published: true, tagged: true });
    const query = ["```onden-query", `tags: tag${stamp}`, "```"].join("\n");
    await note(`Row host ${stamp}`, `List:\n\n${query}\n`, { published: true });
    await publish();
    expect(await servedJson()).toContain(`Row gone ${stamp}`);
    await unpublish(gone);
    expect(await servedJson()).not.toContain(`Row gone ${stamp}`);
  });

  it("control: aliases are never a field of the served payload, and a link by alias is served by slug (the typed link text is the author's)", async () => {
    await note(`Aliased ${stamp}`, "x", { published: true, attrs: { aliases: `Secret alias ${stamp}` } });
    await note(`Aliaser ${stamp}`, `See [[Secret alias ${stamp}]].`, { published: true });
    await publish();
    const json = await servedJson();
    expect(json).toContain(`Aliased ${stamp}`);
    expect(json).not.toContain('"aliases"');
    const slug = (await q<{ slug: string }>(`SELECT slug FROM content_nodes WHERE workspace_id = $1 AND title = $2`, [WS, `Aliased ${stamp}`])).rows[0]!.slug;
    expect(json).toContain(`[[${slug}|Secret alias ${stamp}]]`);
  });

  it("control: hiding a tag removes its chips and its tag page at once", async () => {
    const hidden = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','class_tag',$2,$2,'') RETURNING id::text`, [WS, `hide${stamp}`])).rows[0]!.id;
    const n = await note(`Tagged page ${stamp}`, "x", { published: true });
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [n, hidden]);
    await publish();
    expect(await servedJson()).toContain(`hide${stamp}`);
    await seedQ(`UPDATE content_nodes SET hidden = true WHERE id = $1`, [hidden]);
    expect(await servedJson()).not.toContain(`hide${stamp}`);
  });

  it("two published notes never end up at one address, even when a clash suffix equals another note's slug", async () => {
    // Fix direction: uniquePublishedSlugs (publishedSet.ts) must check the suffixed slug against every slug in the
    // set and keep counting (`-<id6>`, then `-<id8>` …) until it is free, as services/nodes.ts uniqueSlug does.
    const { uniquePublishedSlugs } = await import("../modules/website/publishing/publishedSet.js");
    const a = "aaaaaaaa-0000-4000-8000-000000000001";
    const b = "bbbbbb11-0000-4000-8000-000000000002";
    const c = "cccccccc-0000-4000-8000-000000000003";
    const rows = [{ id: a, slug: "x" }, { id: b, slug: "x" }, { id: c, slug: "x-bbbbbb" }];
    await uniquePublishedSlugs(rows);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(3);
  });
});
