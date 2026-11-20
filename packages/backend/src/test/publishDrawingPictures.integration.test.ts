// The picture of a drawing that a published note embeds goes out with that
// note even when the drawing lives in a space that does not publish (owner
// 2026-11-20, after Quartz; modules/website/publishing/drawingEmbeds.ts). Only
// the picture of exactly what is embedded leaves: not the drawing's title,
// slug, id, text, strokes outside a quoted area, nor a page or a link of its
// own. A plain [[link]] to it still reads as the placeholder; 「不發布」 on the
// drawing and unpublishing the embedding note both take the picture down at
// once, without a new publish; a drawing in another member's personal space,
// one the publisher cannot read, and a PDF never lend a picture.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { encodeInk, inkRegionToSvg, inkToSvg, type InkDocument } from "@onden/markdown/ink";
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { buildCandidate } from "../modules/website/publishing/snapshot.js";
import { loadServedSite } from "../modules/website/publishing/servedSite.js";
import { buildPublishPreview } from "../modules/website/publishing/preview.js";
import { pictureSourceIds } from "../modules/website/publishing/publishedSet.js";
import { recordTakedowns } from "../modules/website/publishing/takenDown.js";
import { websiteModule } from "../modules/website/index.js";
import { withoutNodes } from "../services/purgedContent.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishDefaultSpace } from "./helpers/spaceFixtures.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let WS = "";
let stamp = "";
let owner: ActorCtx;

const NEAR = { id: "sNear", color: "#1e1e1e", size: 4, toolId: "pen", points: [[20, 20], [80, 60], [140, 40]] as Array<[number, number]> };
const FAR = { id: "sFar", color: "#1e1e1e", size: 4, toolId: "pen", points: [[700, 900], [777, 950], [820, 930]] as Array<[number, number]> };
const doc = (strokes: InkDocument["strokes"]): string => encodeInk({ version: 1, erased: {}, page: { width: 1000 }, strokes } satisfies InkDocument);
const REGION = { page: "page", x: 0, y: 0, w: 400, h: 300 };

type SiteNode = { id: string; title: string; slug: string; markdown: string; pictures?: Array<{ key: string; source_node_id: string; svg: string }> };
const nodesOf = (payload: Record<string, unknown>) => payload.nodes as SiteNode[];
const svgOf = (line: string) => Buffer.from(line.slice(line.indexOf(",") + 1, -1), "base64").toString("utf8");

async function attr(id: string, key: string, value: string, type = "text") {
  await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1, $2, $3, $4, $5)`, [WS, id, key, value, type]);
}
async function note(title: string, markdown: string, opts: { space?: string; ink?: string; keptOff?: boolean } = {}): Promise<{ id: string; slug: string }> {
  const slug = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${stamp}`;
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
     VALUES ($1,'manual','content',$2,$3,$4, coalesce($5::uuid, (SELECT id FROM spaces WHERE workspace_id = $1 AND is_default))) RETURNING id`,
    [WS, title, slug, markdown, opts.space ?? null],
  )).rows[0]!.id;
  if (opts.keptOff) await attr(id, "_published", "false", "bool");
  if (opts.ink) await attr(id, "ink_data", opts.ink);
  return { id, slug };
}
async function personalSpaceOf(actorId: string): Promise<string> {
  return (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND kind = 'personal' AND owner_actor_id = $2`, [WS, actorId])).rows[0]!.id;
}
async function publish() {
  const c = await buildCandidate(WS, { title: "Site", actor: owner });
  const row = (await q<{ id: string }>(
    `INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload, artifact_ref) VALUES ($1,$2,$3,$4,$5,'/site/') RETURNING id::text`,
    [WS, c.title, c.homeNodeId, c.eventCursor, c.payload],
  )).rows[0]!;
  return { c, stored: (await q<{ payload: string }>(`SELECT payload::text AS payload FROM publish_snapshots WHERE id = $1`, [row.id])).rows[0]!.payload };
}
const servedJson = async () => JSON.stringify(await loadServedSite(WS));

describe.skipIf(!isTestDb)("pictures of embedded drawings from spaces that do not publish (DB)", () => {
  // As the owner's import looks: the drawing (an Obsidian Excalidraw import) in 「只有我」, a published note that is only the embed.
  const TITLE = "2025-12-16 05.51.08";
  let drawing = { id: "", slug: "" }, embedder = "", quoter = "", linker = "", mine = "";
  beforeEach(async () => {
    stamp = randomUUID().slice(0, 8);
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Pictures', $1) RETURNING id::text`, [`pictures-${stamp}`])).rows[0]!.id;
    await publishDefaultSpace(WS);
    owner = await persistActor(WS, { id: "", name: `Picture owner ${stamp}`, role: "admin", type: "human" });
    mine = await personalSpaceOf(owner.id);
    drawing = await note(TITLE, "the drawing's own private words", { space: mine, ink: doc([NEAR, FAR]) });
    await attr(drawing.id, "aliases", JSON.stringify([`${TITLE}.excalidraw`]));
    embedder = (await note("正交化與QR", `![[${TITLE}.excalidraw]]`)).id;
    quoter = (await note("1b雙指標", `![[${TITLE}.excalidraw|ink=page@0,0,400,300]]`)).id;
    linker = (await note("Linker", `see [[${TITLE}.excalidraw]]`)).id;
  });

  it("(a) the embedding note carries exactly the embedded picture; nothing else of the drawing is in the snapshot or the served site", async () => {
    const { c, stored } = await publish();
    const nodes = nodesOf(c.payload);
    expect(nodes.map((n) => n.id)).not.toContain(drawing.id); // no page of its own
    const whole = nodes.find((n) => n.id === embedder)!;
    expect(whole.markdown).toBe("![](onden-picture:p1)");
    expect(whole.pictures).toEqual([{ key: "p1", source_node_id: drawing.id, svg: inkToSvg(doc([NEAR, FAR])) }]);
    const area = nodes.find((n) => n.id === quoter)!;
    expect(area.markdown).toBe("![](onden-picture:p1)");
    // The quoted area is drawn as if the far stroke did not exist: only what is in the area leaves.
    const onlyNear = inkRegionToSvg(doc([NEAR]), REGION);
    expect(onlyNear.kind).toBe("picture");
    expect(area.pictures![0]!.svg).toBe((onlyNear as { svg: string }).svg);

    for (const json of [JSON.stringify(c.payload), stored]) {
      expect(json).not.toContain(TITLE);
      expect(json).not.toContain(drawing.slug);
      expect(json).not.toContain("private words");
      expect(json).not.toContain("sNear");
      expect(json).not.toContain("excalidraw");
    }

    const served = await loadServedSite(WS);
    const json = JSON.stringify(served);
    expect(json).not.toContain(TITLE);
    expect(json).not.toContain(drawing.slug);
    expect(json).not.toContain(drawing.id); // the bookkeeping that names the drawing stays on the server
    expect(json).not.toContain("onden-picture:");
    const page = nodesOf(served.payload).find((n) => n.id === embedder)!.markdown;
    expect(page).toMatch(/^!\[手繪圖\]\(data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+\)$/);
    expect(svgOf(page)).toBe(inkToSvg(doc([NEAR, FAR])));
    expect(svgOf(nodesOf(served.payload).find((n) => n.id === quoter)!.markdown)).toBe((onlyNear as { svg: string }).svg);
  });

  it("(b) a plain link to the same drawing still reads as the placeholder, in the site's language", async () => {
    const { c } = await publish();
    expect(nodesOf(c.payload).find((n) => n.id === linker)!.markdown).toBe("see （未公開）");
    expect(c.privateLinks).toEqual([expect.objectContaining({ nodeId: linker, shownAs: "（未公開）" })]);
    expect(nodesOf((await loadServedSite(WS)).payload).find((n) => n.id === linker)!.markdown).toBe("see （未公開）");
  });

  it("(c) 「不發布」 on the drawing takes the picture down at once, and it stays down until the next publish", async () => {
    await publish();
    expect(await servedJson()).toContain("data:image/svg+xml");
    await attr(drawing.id, "_published", "false", "bool");
    await recordTakedowns(WS); // what the attribute hook does in the same transaction (website module)
    const served = nodesOf((await loadServedSite(WS)).payload);
    expect(served.find((n) => n.id === embedder)!.markdown).toBe("（未公開）");
    expect(served.find((n) => n.id === quoter)!.markdown).toBe("（未公開）");
    expect(await servedJson()).not.toContain("data:image/svg+xml");
    // 「放回網站」: the picture waits for the next publish, as a taken-down page does.
    await seedQ(`DELETE FROM node_attributes WHERE node_id = $1 AND key = '_published'`, [drawing.id]);
    await recordTakedowns(WS);
    expect(await servedJson()).not.toContain("data:image/svg+xml");
    await publish();
    expect(await servedJson()).toContain("data:image/svg+xml");
  });

  it("(c) without the hook's record, the serve-time check alone already hides it", async () => {
    await publish();
    await attr(drawing.id, "_published", "false", "bool");
    expect(await servedJson()).not.toContain("data:image/svg+xml");
  });

  it("(c) unpublishing the embedding note removes the picture with it", async () => {
    await publish();
    await attr(embedder, "_published", "false", "bool");
    await attr(quoter, "_published", "false", "bool");
    const json = await servedJson();
    expect(json).not.toContain("data:image/svg+xml");
    expect(nodesOf((await loadServedSite(WS)).payload).map((n) => n.id)).not.toContain(embedder);
  });

  it("a trashed drawing lends no picture, and the served site drops it at once", async () => {
    await publish();
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [drawing.id]);
    expect(await servedJson()).not.toContain("data:image/svg+xml");
  });

  it("trashing a drawing that lends a picture asks for the static copy to be pushed again, and records the takedown", async () => {
    await publish();
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [drawing.id]);
    await websiteModule.nodeHooks!.lifecycleCommitted!({ workspaceId: WS, actor: owner, nodeIds: [drawing.id], change: "trashed" } as never);
    const rebuild = await q(`SELECT 1 FROM outbox WHERE workspace_id = $1 AND effect_kind = 'site_rebuild'`, [WS]);
    expect(rebuild.rowCount).toBe(1);
    const gone = await q<{ gone: unknown }>(`SELECT payload->'pictures_taken_down' AS gone FROM publish_snapshots WHERE workspace_id = $1`, [WS]);
    expect(gone.rows[0]!.gone).toEqual([{ source_node_id: drawing.id }]);
  });

  it("a permanent delete of the drawing takes its picture out of the stored snapshot", async () => {
    const { c } = await publish();
    const left = withoutNodes(c.payload, new Set([drawing.id]));
    expect(JSON.stringify(left)).not.toContain("<svg");
    expect(JSON.stringify(left)).not.toContain(drawing.id);
  });

  it("a drawing marked 「不發布」 before the publish is never carried", async () => {
    await attr(drawing.id, "_published", "false", "bool");
    const { c, stored } = await publish();
    expect(nodesOf(c.payload).find((n) => n.id === embedder)!.markdown).toBe("（未公開）");
    expect(stored).not.toContain("<svg");
    expect(stored).not.toContain(drawing.id);
  });

  it("another member's personal space and a drawing the publisher cannot read lend nothing", async () => {
    const member = await persistActor(WS, { id: "", name: `Member ${stamp}`, role: "editor", type: "human" });
    const theirs = await note("Their sketch", "x", { space: await personalSpaceOf(member.id), ink: doc([NEAR]) });
    const host = (await note("Host", "![[Their sketch]]")).id;
    // The site is the owner's: even the member's own publish could not carry it.
    expect([...await pictureSourceIds(WS, [theirs.id, drawing.id])]).toEqual([drawing.id]);
    const { c, stored } = await publish();
    expect(nodesOf(c.payload).find((n) => n.id === host)!.markdown).toBe("（未公開）");
    expect(stored).not.toContain(theirs.id);
    // With no publisher to read as, nothing outside the published set is carried.
    const anonymous = await buildCandidate(WS, { title: "Site" });
    expect(JSON.stringify(anonymous.payload)).not.toContain("<svg");
  });

  it("an embedded PDF note is not drawn and its file is not published", async () => {
    const pdf = await note("paper.pdf", "extracted text of the paper", { space: mine, ink: doc([NEAR]) });
    await attr(pdf.id, "pdf_url", "/api/media/secret-paper.pdf");
    const host = (await note("Reading", "![[paper.pdf]]")).id;
    const { c, stored } = await publish();
    expect(nodesOf(c.payload).find((n) => n.id === host)!.markdown).toBe("（未公開）");
    expect(stored).not.toContain("secret-paper");
    expect(stored).not.toContain("extracted text");
  });

  it("the preview lists each picture once, with the notes that show it, as the snapshot will hold it", async () => {
    await note("Again", `![[${TITLE}.excalidraw]]\n\n![[${TITLE}.excalidraw]]`);
    const preview = await buildPublishPreview(WS, { title: "Site", actor: owner });
    const candidate = await buildCandidate(WS, { title: "Site", actor: owner });
    const held = [...new Set(nodesOf(candidate.payload).flatMap((n) => (n.pictures ?? []).map((p) => p.svg)))];
    expect(preview.embedded_pictures!.map((p) => svgOf(`(${p.picture})`)).sort()).toEqual(held.sort());
    expect(preview.embedded_pictures!.every((p) => p.source_id === drawing.id)).toBe(true);
    const whole = preview.embedded_pictures!.find((p) => svgOf(`(${p.picture})`) === inkToSvg(doc([NEAR, FAR])))!;
    expect(whole.node_ids).toHaveLength(2); // 正交化與QR and Again; 1b雙指標 quotes an area, another picture
    expect(preview.private_links.map((l) => l.shown_as)).toEqual(["（未公開）"]);
  });
});
