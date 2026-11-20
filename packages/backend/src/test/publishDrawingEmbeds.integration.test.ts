// `![[drawing]]` on the published site (modules/website/publishing/drawingEmbeds.ts):
// the picture of what a published note embeds is frozen into that note and
// served as an image — also when the drawing lives in a space that does not
// publish (publishDrawingPictures.integration.test.ts covers that case); an
// embed of a drawing marked 「不發布」 shows the placeholder, and none of its
// strokes, title or picture reach the payload; a drawing taken down after the
// publish stops showing at once. Also: `[[name.excalidraw]]` makes a backlink
// edge to the imported drawing titled `name` (utils.extractWikilinks via wikilinkNames).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { encodeInk, inkToSvg, type InkDocument } from "@onden/markdown/ink";
import { q, withTransaction } from "../db.js";
import { buildCandidate } from "../modules/website/publishing/snapshot.js";
import { loadServedSite } from "../modules/website/publishing/servedSite.js";
import { syncWikilinkEdges } from "../services/wikilinkEdges.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishDefaultSpace } from "./helpers/spaceFixtures.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// Each test runs in a workspace of its own (beforeEach): the site and the
// title lookups are per workspace, so no other note titled like these — left
// by another file or an earlier run — can answer an embed.
let WS = "";
let stamp = "";
const ink = (x: number): string => encodeInk({
  version: 1, erased: {}, page: { width: 1000 },
  strokes: [{ id: `s${x}`, color: "#1e1e1e", size: 4, toolId: "pen", points: [[x, 10], [x + 50, 40], [x + 110, 20]] }],
} satisfies InkDocument);

async function attr(id: string, key: string, value: string, type = "text") {
  await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1, $2, $3, $4, $5)`, [WS, id, key, value, type]);
}
async function note(title: string, markdown: string, published: boolean, extra: { ink?: string; aliases?: string[] } = {}): Promise<string> {
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,$4) RETURNING id`,
    [WS, title, `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${stamp}`, markdown],
  )).rows[0]!.id;
  // The default space publishes; an unpublished note is one kept off (「不發布」).
  await attr(id, "_published", published ? "true" : "false", "bool");
  if (extra.ink) await attr(id, "ink_data", extra.ink);
  if (extra.aliases) await attr(id, "aliases", JSON.stringify(extra.aliases));
  return id;
}
type SiteNode = { id: string; title: string; slug: string; markdown: string; drawing_svg?: string; pictures?: Array<{ key: string; source_node_id: string; svg: string }> };
const nodesOf = (payload: Record<string, unknown>) => payload.nodes as SiteNode[];

describe.skipIf(!isTestDb)("published ![[drawing]] embeds (DB)", () => {
  let home = "", shared = "", secret = "";
  async function publish() {
    const c = await buildCandidate(WS, { title: "Site" });
    await q(
      `INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload, artifact_ref) VALUES ($1,$2,$3,$4,$5,'/site/')`,
      [WS, c.title, c.homeNodeId, c.eventCursor, c.payload],
    );
    return c;
  }
  beforeEach(async () => {
    stamp = randomUUID().slice(0, 8);
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Drawings', $1) RETURNING id::text`, [`drawings-${stamp}`])).rows[0]!.id;
    await publishDefaultSpace(WS);
    // As the Obsidian import names them: the title without .excalidraw, the old name an alias.
    shared = await note("2025-12-08 09.58.38", "label text", true, { ink: ink(10), aliases: ["2025-12-08 09.58.38.excalidraw", "My Sketch"] });
    secret = await note("Secret sketch", "private words", false, { ink: ink(500) });
    await note("About", "plain", true);
    home = await note("Home", [
      "![[2025-12-08 09.58.38.excalidraw]]",
      "![[Secret sketch]]",
      "![[Secret sketch|a picture]]",
      "![[About]]",
      "![[My Sketch]]",
    ].join("\n\n"), true);
  });

  it("publish freezes the published drawing's picture in the embedding note and makes the kept-off embed inert", async () => {
    const c = await buildCandidate(WS, { title: "Site" });
    const nodes = nodesOf(c.payload);
    const homeNode = nodes.find((n) => n.id === home)!;
    // Every embed of the drawing (by name, by alias) is one picture of the note; no alias, no name of it stays.
    expect(homeNode.markdown).toBe("![](onden-picture:p1)\n\n（未公開）\n\na picture\n\n![[About]]\n\n![](onden-picture:p1)");
    expect(homeNode.pictures).toEqual([{ key: "p1", source_node_id: shared, svg: expect.stringMatching(/^<svg /) }]);
    expect(JSON.stringify(c.payload)).not.toContain('"aliases"');
    expect(nodes.some((n) => n.id === secret)).toBe(false);
    const json = JSON.stringify(c.payload);
    expect(json).not.toContain("Secret sketch");
    expect(json).not.toContain('"s500"');
    expect(c.privateLinks.map((l) => [l.target, l.shownAs])).toEqual([["Secret sketch", "（未公開）"], ["Secret sketch", "a picture"]]);

    // Served: the picture as an inert image; other embeds as links.
    await q(
      `INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload, artifact_ref) VALUES ($1,$2,$3,$4,$5,'/site/')`,
      [WS, c.title, c.homeNodeId, c.eventCursor, c.payload],
    );
    const served = nodesOf((await loadServedSite(WS)).payload);
    const page = served.find((n) => n.id === home)!.markdown;
    const [image] = page.split("\n\n");
    expect(image).toMatch(/^!\[手繪圖\]\(data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+\)$/);
    const svg = Buffer.from(image!.slice(image!.indexOf(",") + 1, -1), "base64").toString("utf8");
    expect(svg).toBe(homeNode.pictures![0]!.svg);
    // An embed with no label of its own gets the site's word as alt, never the name it was written with.
    expect(page.split("\n\n")[4]).toBe(image);
    expect(page).not.toContain("My Sketch");
    expect(page).toContain("[[About]]");
    expect(page).not.toContain("![[About]]");
    expect(served.every((n) => !("pictures" in n) && !("drawing_svg" in n))).toBe(true);
    expect(JSON.stringify((await loadServedSite(WS)).payload)).not.toContain("onden-picture:");
  });

  it("a drawing taken down after the publish stops showing at once", async () => {
    await publish();
    expect(nodesOf((await loadServedSite(WS)).payload).find((n) => n.id === home)!.markdown).toContain("data:image");
    await seedQ(`UPDATE node_attributes SET value = 'false' WHERE node_id = $1 AND key = '_published'`, [shared]);
    const page = nodesOf((await loadServedSite(WS)).payload).find((n) => n.id === home)!.markdown;
    expect(page.split("\n\n")[0]).toBe("（未公開）");
    expect(page).not.toContain("data:image");
    await seedQ(`UPDATE node_attributes SET value = 'true' WHERE node_id = $1 AND key = '_published'`, [shared]);
  });

  it("a quoted region freezes only that part of a published drawing; an unpublished one reveals nothing", async () => {
    const quoter = await note("Quoter", [
      "![[2025-12-08 09.58.38.excalidraw|ink=page@0,0,400,300]]",
      "![[Secret sketch|ink=page@0,0,400,300]]",
      "![[My Sketch|ink=page@0,0,400,300]]",
      "![[2025-12-08 09.58.38.excalidraw|ink=page@800,800,100,100]]",
    ].join("\n\n"), true);
    const c = await buildCandidate(WS, { title: "Site" });
    const nodes = nodesOf(c.payload);
    const md = nodes.find((n) => n.id === quoter)!.markdown;
    const slug = nodes.find((n) => n.id === shared)!.slug;
    expect(md.split("\n\n")).toEqual([
      // The two quotes of the same area (by name, by alias) are one picture; an area with nothing in it stays an embed.
      "![](onden-picture:p1)", "（未公開）", "![](onden-picture:p1)", "![[2025-12-08 09.58.38.excalidraw|ink=page@800,800,100,100]]",
    ]);
    expect(md).not.toContain(slug);
    expect(JSON.stringify(c.payload)).not.toContain('"s500"');
    await q(
      `INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload, artifact_ref) VALUES ($1,$2,$3,$4,$5,'/site/')`,
      [WS, c.title, c.homeNodeId, c.eventCursor, c.payload],
    );
    const served = nodesOf((await loadServedSite(WS)).payload);
    const [first, secretLine, third, empty] = served.find((n) => n.id === quoter)!.markdown.split("\n\n");
    const svgOf = (line: string) => Buffer.from(line.slice(line.indexOf(",") + 1, -1), "base64").toString("utf8");
    expect(first).toMatch(/^!\[.*\]\(data:image\/svg\+xml;base64,/);
    expect(svgOf(first!)).toContain('viewBox="0.0 0.0 400.0 300.0"');
    expect(svgOf(first!)).not.toBe(inkToSvg(ink(10)));
    expect(secretLine).toBe("（未公開）");
    expect(third).toMatch(/^!\[/);
    expect(empty).toBe(""); // nothing drawn there: no picture, never the whole drawing
    expect(served.every((n) => !("pictures" in n) && !("drawing_regions" in n))).toBe(true);
  });

  it("a quoted area named by id (a title that cannot be written in a link) shows when its note is published, and stays inert when it is not", async () => {
    const odd = await note("Odd # title", "x", true, { ink: ink(10) });
    const hidden = await note("Hidden # title", "x", false, { ink: ink(10) });
    const quoter = await note("IdQuoter", `![[onden://node/${odd}|ink=page@0,0,400,300]]\n\n![[onden://node/${hidden}|ink=page@0,0,400,300]]`, true);
    const c = await buildCandidate(WS, { title: "Site" });
    await q(
      `INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload, artifact_ref) VALUES ($1,$2,$3,$4,$5,'/site/')`,
      [WS, c.title, c.homeNodeId, c.eventCursor, c.payload],
    );
    const [shown, inert] = nodesOf((await loadServedSite(WS)).payload).find((n) => n.id === quoter)!.markdown.split("\n\n");
    expect(shown).toMatch(/^!\[.*\]\(data:image\/svg\+xml;base64,/);
    expect(inert).not.toMatch(/data:image|onden:\/\/|ink=/);
    expect(JSON.stringify(c.payload)).not.toContain(hidden);
  });

  it("a quoted area with only a text box in it is drawn, text included", async () => {
    const texty = await note("Texty", "x", true, { ink: ink(700) });
    await attr(texty, "page_text", JSON.stringify({ v: 1, pages: { page: { boxes: [{ id: "b", x: 20, y: 20, w: 200, text: "公式推導", size: 22, color: "#1e1e1e", align: "left", updated_at: "" }] } } }));
    const quoter = await note("TextQuoter", "![[Texty|ink=page@0,0,400,300]]", true);
    const c = await buildCandidate(WS, { title: "Site" });
    await q(`INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload, artifact_ref) VALUES ($1,$2,$3,$4,$5,'/site/')`, [WS, c.title, c.homeNodeId, c.eventCursor, c.payload]);
    const line = nodesOf((await loadServedSite(WS)).payload).find((n) => n.id === quoter)!.markdown;
    expect(line).toMatch(/^!\[.*\]\(data:image\/svg\+xml;base64,/);
    expect(Buffer.from(line.slice(line.indexOf(",") + 1, -1), "base64").toString("utf8")).toContain("公式推導");
  });

  it("[[name.excalidraw]] links to the drawing titled name", async () => {
    const linker = await note("Linker", "see [[2025-12-08 09.58.38.excalidraw]]", false);
    await seedQ(`DELETE FROM node_attributes WHERE node_id = $1 AND key = 'aliases'`, [shared]); // by title alone
    const targets = await withTransaction(() => syncWikilinkEdges(WS, linker, "see [[2025-12-08 09.58.38.excalidraw]]"));
    expect(targets.map((t) => t.id)).toEqual([shared]);
  });
});
