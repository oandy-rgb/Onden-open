// D113: an onden-query / onden-base block in a published note is frozen at
// publish time — a static list of the notes it matches that are themselves
// published — and every published surface (the snapshot payload, the served
// site after takedowns, the zip/static pages, the single-note export) shows
// that list, never the query's source and never an unpublished note.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q, pool, getWorkspaceId } from "../db.js";

// A workspace of its own: a workspace has one site, and the published notes
// and snapshots of other tests would otherwise be on it.
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { buildCandidate } from "../modules/website/publishing/snapshot.js";
import { loadServedSite, singleNoteExport } from "../modules/website/publishing/servedSite.js";
import { md2html } from "../modules/website/publishing/htmlUtils.js";
import type { FrozenQueryBlock } from "@onden/markdown";
import type { ActorCtx } from "../types.js";
import type { NodeRow } from "../modules/website/publishing/types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishDefaultSpace } from "./helpers/spaceFixtures.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const stamp = Date.now();
const TAG = `d113tag${stamp}`;
let WS = "";
let owner: ActorCtx;

type PayloadNode = NodeRow & { query_blocks?: FrozenQueryBlock[] };

async function note(title: string, markdown: string, { published, tagged, stage }: { published: boolean; tagged?: string; stage?: string }) {
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,$4) RETURNING id`,
    [WS, title, `${title.toLowerCase().replace(/\s+/g, "-")}-${stamp}`, markdown],
  )).rows[0]!.id;
  // The default space publishes; an unpublished note is one kept off (「不發布」).
  await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1, $2, '_published', $3, 'bool')`,
    [WS, id, published ? "true" : "false"]);
  if (stage) await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1, $2, 'stage', $3, 'text')`, [WS, id, stage]);
  if (tagged) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id, tagged]);
  return id;
}

const QUERY = ["```onden-query", `tags: ${TAG}`, "sort: title", "```"].join("\n");
const BASE = ["```onden-base", "filters:", `  - 'file.hasTag("${TAG}")'`, "views:", "  - type: table", "    order: [file.name, stage]", "```"].join("\n");

describe.skipIf(!isTestDb)("query blocks frozen at publish (D113)", () => {
  let tag = "", alpha = "", beta = "", secret = "", host = "";
  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('D113', $1) RETURNING id::text`, [`d113-${randomUUID()}`])).rows[0]!.id;
    await publishDefaultSpace(ownWorkspace);
    WS = await getWorkspaceId();
    owner = await persistActor(WS, { id: "", name: `D113 owner ${stamp}`, role: "admin", type: "human" });
    tag = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','class_tag',$2,$2,'') RETURNING id`, [WS, TAG],
    )).rows[0]!.id;
    alpha = await note("Alpha", "first", { published: true, tagged: tag, stage: "draft" });
    beta = await note("Beta", "second", { published: true, tagged: tag, stage: "done" });
    secret = await note("Secret plan", "private", { published: false, tagged: tag, stage: "hidden" });
    host = await note("Host", `Matches:\n\n${QUERY}\n\nAs a table:\n\n${BASE}\n`, { published: true });
  });
  afterAll(async () => {
    await q(`DELETE FROM publish_snapshots WHERE workspace_id = $1`, [WS]);
    await pool.end();
  });

  const hostOf = (nodes: PayloadNode[]) => nodes.find((n) => n.id === host)!;
  /** Publish: the current candidate becomes the served snapshot. */
  async function publishSnapshot() {
    const c = await buildCandidate(WS, { title: "Site", actor: owner });
    await q(
      `INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload, artifact_ref) VALUES ($1,$2,$3,$4,$5,'/site/')`,
      [WS, c.title, c.homeNodeId, c.eventCursor, c.payload],
    );
  }

  it("the payload carries each block's result, listing published notes only", async () => {
    const c = await buildCandidate(WS, { title: "Site", actor: owner });
    const nodes = c.payload.nodes as PayloadNode[];
    const blocks = hostOf(nodes).query_blocks!;
    expect(blocks.map((b) => b.lang)).toEqual(["onden-query", "onden-base"]);
    const slug = (id: string) => nodes.find((n) => n.id === id)!.slug;
    expect(blocks[0]!.rows).toEqual([
      { id: alpha, title: "Alpha", slug: slug(alpha) },
      { id: beta, title: "Beta", slug: slug(beta) },
    ]);
    expect(blocks[0]!.more).toBe(0);
    // onden-base: the app's evaluator, with the column the table asks for.
    expect(blocks[1]!.columns).toEqual(["stage"]);
    expect(blocks[1]!.rows.map((r) => [r.title, r.values])).toEqual([["Alpha", ["draft"]], ["Beta", ["done"]]]);
    // The unpublished match leaves no trace: not its id, title or value.
    const json = JSON.stringify(c.payload);
    expect(json).not.toContain(secret);
    expect(json).not.toContain("Secret plan");
    expect(json).not.toContain('"hidden"');
    // Notes without blocks carry none.
    expect(nodes.find((n) => n.id === alpha)!.query_blocks).toBeUndefined();
  });

  it("without a publishing actor the blocks list nothing (never more than the publisher could read)", async () => {
    const c = await buildCandidate(WS, { title: "Site" });
    const blocks = hostOf(c.payload.nodes as PayloadNode[]).query_blocks!;
    expect(blocks.every((b) => b.rows.length === 0)).toBe(true);
  });

  it("a block that can't be read is frozen as its problem, not widened to every note", async () => {
    const bad = await note("Bad query", "```onden-query\ntag: x\nwhere: y\ncolour: red\n```", { published: true });
    try {
      const c = await buildCandidate(WS, { title: "Site", actor: owner });
      const blocks = (c.payload.nodes as PayloadNode[]).find((n) => n.id === bad)!.query_blocks!;
      expect(blocks[0]!.rows).toEqual([]);
      expect(blocks[0]!.problem).toMatch(/colour/);
    } finally {
      await seedQ(`DELETE FROM content_nodes WHERE id = $1`, [bad]);
    }
  });

  it("the exported page draws the frozen list with links, never the query source", async () => {
    const c = await buildCandidate(WS, { title: "Site", actor: owner });
    const nodes = c.payload.nodes as PayloadNode[];
    const host = hostOf(nodes);
    const page = md2html(host.markdown, { pages: nodes, from: host.id, queryBlocks: host.query_blocks });
    const slug = (id: string) => nodes.find((n) => n.id === id)!.slug;
    expect(page).toContain(`<ul class="onden-query-frozen-list"><li><a href="/site/${slug(alpha)}">Alpha</a></li>`);
    expect(page).toContain(`<table class="onden-query-frozen-table">`);
    expect(page).toContain("<td>done</td>");
    expect(page).not.toContain(`tags: ${TAG}`);
    expect(page).not.toContain("Secret plan");
  });

  it("the served site drops a listed note taken down since the publish", async () => {
    await publishSnapshot();
    await seedQ(`UPDATE node_attributes SET value = 'false' WHERE node_id = $1 AND key = '_published'`, [beta]);
    try {
      const site = await loadServedSite(WS);
      const blocks = hostOf(site.payload.nodes as PayloadNode[]).query_blocks!;
      expect(blocks[0]!.rows.map((r) => r.id)).toEqual([alpha]);
      expect(blocks[1]!.rows.map((r) => r.id)).toEqual([alpha]);
    } finally {
      await seedQ(`UPDATE node_attributes SET value = 'true' WHERE node_id = $1 AND key = '_published'`, [beta]);
    }
  });

  it("a single-note export evaluates now, as the exporter, listing only the served site's pages", async () => {
    // The served site: a publish with Alpha and Beta on it. A draft with the
    // same query lists them, never the unpublished match.
    await publishSnapshot();
    const html = await singleNoteExport(WS, { id: host, title: "Draft", markdown: QUERY }, owner);
    expect(html).toContain(">Alpha</a>");
    expect(html).toContain(">Beta</a>");
    expect(html).not.toContain("Secret plan");
    expect(html).not.toContain(`tags: ${TAG}`);
  });

  it("md2html without a frozen result says so instead of showing the source", () => {
    const html = md2html(QUERY);
    expect(html).toContain("onden-query-frozen-note");
    expect(html).not.toContain(TAG);
  });
});
