// A published handwriting note draws its own handwriting on its own page
// (modules/website/publishing/handwritingPages.ts): publish freezes each page as
// a media file owned by the note, the served page shows them as images after
// the note's text, and a takedown stops them at once. A PDF note is unchanged,
// and the strokes of a note that is not published never reach the snapshot.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { Hono } from "hono";
import { encodeInk, INK_PAPER_COLOR, type InkDocument } from "@onden/markdown/ink";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import mediaRouter from "../routes/media.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import { buildAndEnqueueSnapshot, buildCandidate, warmHandwritingPages } from "../modules/website/publishing/snapshot.js";
import { noteSiteState } from "../modules/website/publishing/noteSiteState.js";
import { purgeDeleted, trashNode } from "../services/nodeTrash.js";
import { buildPublishPreview } from "../modules/website/publishing/preview.js";
import { loadServedSite } from "../modules/website/publishing/servedSite.js";
import { serveHandwritingPages } from "../modules/website/publishing/handwritingPages.js";
import type { ActorCtx } from "../types.js";
import { joinDefaultSpace, publishDefaultSpace } from "./helpers/spaceFixtures.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();

// Counts the pictures actually drawn (every page's `draw`), to prove a name is found without drawing.
let drawn = 0;
vi.mock("@onden/markdown/ink", async (original) => {
  const real = await original<typeof import("@onden/markdown/ink")>();
  return { ...real, inkPages: (value: string) => real.inkPages(value).map((page) => ({ ...page, draw: () => { drawn += 1; return page.draw(); } })) };
});

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let ws = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", null); await next(); });
app.route("/api/media", mediaRouter);

const ink = (id: string, y = 60): string => encodeInk({
  version: 1, erased: {}, page: { width: 1000 },
  strokes: [{ id, color: "#15130d", size: 4, toolId: "pen", points: [[100, y], [300, y + 50], [500, y + 10]] }],
} satisfies InkDocument);

type SiteNode = { id: string; title: string; markdown: string; ink_pages?: string[] };
let actor: ActorCtx;
let spaceId = "";
async function note(title: string, markdown: string, opts: { published?: boolean; ink?: string; pdf?: boolean } = {}): Promise<string> {
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
     VALUES ($1,'manual','content',$2,$3,$4,$5) RETURNING id`,
    [ws, title, `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 6)}`, markdown, spaceId],
  )).rows[0]!.id;
  const attr = (key: string, value: string, type = "text") =>
    seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1,$2,$3,$4,$5)`, [ws, id, key, value, type]);
  // The space publishes; an unpublished note is one kept off (「不發布」).
  await attr("_published", opts.published ? "true" : "false", "bool");
  if (opts.ink) await attr("ink_data", opts.ink);
  if (opts.pdf) await attr("pdf_url", "/api/media/x.pdf");
  return id;
}
const served = async () => (await loadServedSite(ws)).payload.nodes as SiteNode[];
const mediaOf = (markdown: string) => [...markdown.matchAll(/^!\[\]\[ink-page-(\d+)\]\n\n\[ink-page-\1\]: \/api\/media\/([^\s#]+)#ink-page-\1$/gm)].map((m) => ({ n: Number(m[1]), file: m[2]! }));

describe.skipIf(!isTestDb)("a published handwriting note draws its own pages (DB)", () => {
  let hand = "", plain = "", pdf = "", secret = "";

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Handwriting', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    await publishDefaultSpace(ws);
    const a = await q<{ id: string }>(`INSERT INTO actors (workspace_id, name, type) VALUES ($1,'Author','human') RETURNING id`, [ws]);
    actor = { id: a.rows[0]!.id, name: "Author", role: "admin", type: "human" };
    await joinDefaultSpace(ws, actor.id, "admin");
    spaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
    hand = await note("Lecture sketch", "Notes in words.", { published: true, ink: ink("hand-stroke") });
    plain = await note("Plain", "just text", { published: true });
    // A PDF's own page stays text only, even with a page-shaped ink value.
    pdf = await note("Slides", "pdf text", { published: true, ink: ink("pdf-stroke"), pdf: true });
    secret = await note("Private sketch", "", { ink: ink("secret-stroke") });
  });
  afterAll(async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [ws]);
    await q(`DELETE FROM publish_snapshots WHERE workspace_id = $1`, [ws]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [ws]);
    await pool.end();
  });

  it("the candidate names the pages and holds the pictures aside; the payload stays small", async () => {
    const c = await buildCandidate(ws, { title: "Site" });
    const nodes = c.payload.nodes as SiteNode[];
    const node = nodes.find((n) => n.id === hand)!;
    expect(node.ink_pages).toHaveLength(1);
    expect(node.ink_pages![0]).toMatch(/^\/api\/media\/ink-[0-9a-f]{64}\.svg$/);
    expect(JSON.stringify(c.payload)).not.toContain("<svg");
    expect([...c.handwritingPages.values()].map((p) => p.nodeId)).toEqual([hand]);
    expect([...c.handwritingPages.values()][0]!.render()).toContain(INK_PAPER_COLOR);
    // Not on notes without handwriting, a PDF's, or a private one's.
    for (const id of [plain, pdf]) expect(nodes.find((n) => n.id === id)!.ink_pages).toBeUndefined();
    expect(nodes.some((n) => n.id === secret)).toBe(false);
    expect(JSON.stringify(c.payload)).not.toContain("secret-stroke");
    expect([...c.handwritingPages.values()].map((p) => p.render()).join()).not.toContain("secret-stroke");
  });

  it("publish stores each page as the note's media; the page shows it after the text; a takedown stops it", async () => {
    await buildAndEnqueueSnapshot(ws, { id: actor.id, type: "human" }, { title: "Site" });
    const page = (await served()).find((n) => n.id === hand)!;
    expect(page.ink_pages).toBeUndefined();
    const [first, ...rest] = page.markdown.split("\n\n");
    expect(first).toBe("Notes in words.");
    const pages = mediaOf(page.markdown);
    expect(rest).toHaveLength(2); // the image, then its address
    expect(pages.map((p) => p.n)).toEqual([1]);
    expect((await served()).find((n) => n.id === pdf)!.markdown).toBe("pdf text");
    expect((await served()).find((n) => n.id === plain)!.markdown).toBe("just text");

    // The file is stored once, owned by the note, and an anonymous reader gets it.
    const file = pages[0]!.file;
    expect(readFileSync(join(MEDIA_DIR, file), "utf8")).toContain(INK_PAPER_COLOR);
    expect((await q(`SELECT 1 FROM media_uploads WHERE filename = $1 AND node_id = $2`, [file, hand])).rowCount).toBe(1);
    const res = await app.request(`/api/media/${file}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(await res.text()).toMatch(/^<svg /);

    // A second publish of the same drawing keeps the file; an edit gets a new one.
    await buildAndEnqueueSnapshot(ws, { id: actor.id, type: "human" }, { title: "Site" });
    expect(mediaOf((await served()).find((n) => n.id === hand)!.markdown)[0]!.file).toBe(file);

    // Taken down after the publish: the page and its picture go at once.
    await seedQ(`UPDATE node_attributes SET value = 'false' WHERE node_id = $1 AND key = '_published'`, [hand]);
    expect((await served()).some((n) => n.id === hand)).toBe(false);
    expect((await app.request(`/api/media/${file}`)).status).toBe(404);
    expect(existsSync(join(MEDIA_DIR, file))).toBe(true); // republished later, it is the same file
    await seedQ(`UPDATE node_attributes SET value = 'true' WHERE node_id = $1 AND key = '_published'`, [hand]);
  });

  it("an edited drawing is a changed note in the preview, and the preview shows the pictures inline", async () => {
    await buildAndEnqueueSnapshot(ws, { id: actor.id, type: "human" }, { title: "Site" });
    await seedQ(`UPDATE node_attributes SET value = $2 WHERE node_id = $1 AND key = 'ink_data'`, [hand, ink("hand-stroke", 400)]);
    const preview = await buildPublishPreview(ws, { title: "Site", actor });
    expect(preview.diff.changed.map((n) => n.id)).toContain(hand);
    const shown = (preview.site.payload.nodes as SiteNode[]).find((n) => n.id === hand)!;
    // By address, like the published ones — never the picture inline (22 MB each for a large drawing).
    expect(shown.markdown).toMatch(/!\[\]\[ink-page-1\]\n\n\[ink-page-1\]: \/api\/media\/ink-[0-9a-f]{64}\.svg#ink-page-1/);
    expect(shown.markdown).not.toContain("data:");
    expect(shown.ink_pages).toBeUndefined();
    const file = mediaOf(shown.markdown)[0]!.file;
    expect(existsSync(join(MEDIA_DIR, file))).toBe(true);
    // The owner's preview can open it; a reader outside the site cannot.
    expect((await app.request(`/api/media/${file}`)).status).toBe(404);
  });

  describe("drawing is the expensive part and happens once", () => {
    beforeEach(() => { drawn = 0; });

    it("buildCandidate, the Share menu state and a comparison draw nothing", async () => {
      await buildCandidate(ws, { title: "Site" });
      await buildCandidate(ws, { title: "Site" });
      await noteSiteState(ws, hand, actor);
      expect(drawn).toBe(0);
    });

    it("a preview draws a new drawing once; the preview again, and the publish after it, draw nothing", async () => {
      await seedQ(`UPDATE node_attributes SET value = $2 WHERE node_id = $1 AND key = 'ink_data'`, [hand, ink("hand-stroke", 700)]);
      await buildPublishPreview(ws, { title: "Site", actor });
      expect(drawn).toBe(1);
      await buildPublishPreview(ws, { title: "Site", actor });
      await warmHandwritingPages(ws, actor, { title: "Site" });
      await buildAndEnqueueSnapshot(ws, { id: actor.id, type: "human" }, { title: "Site" });
      expect(drawn).toBe(1);
    });

    it("the same drawing of another note, or a changed one, is another file", async () => {
      const a = (await buildCandidate(ws, { title: "Site" })).payload.nodes as SiteNode[];
      await seedQ(`UPDATE node_attributes SET value = $2 WHERE node_id = $1 AND key = 'ink_data'`, [hand, ink("hand-stroke", 710)]);
      const b = (await buildCandidate(ws, { title: "Site" })).payload.nodes as SiteNode[];
      expect(b.find((n) => n.id === hand)!.ink_pages).not.toEqual(a.find((n) => n.id === hand)!.ink_pages);
    });

    it("10 000 strokes: the name costs no drawing, one drawing stays under the size and time bound, and it is not drawn twice", async () => {
      const big = encodeInk({
        version: 1, erased: {}, page: { width: 1000 },
        strokes: Array.from({ length: 10_000 }, (_, i) => ({
          id: `b${i}`, color: "#15130d", size: 4, toolId: "pen",
          points: Array.from({ length: 12 }, (_, k): [number, number] => [(i * 7 + k * 9) % 900, (i * 3 + k * 5) % 1300]),
        })),
      } satisfies InkDocument);
      const bigNote = await note("Big sketch", "", { published: true, ink: big });
      const named = performance.now();
      const candidate = await buildCandidate(ws, { title: "Site" });
      const nameMs = performance.now() - named;
      expect(drawn).toBe(0);
      expect(nameMs).toBeLessThan(1500);
      const file = (candidate.payload.nodes as SiteNode[]).find((n) => n.id === bigNote)!.ink_pages![0]!.replace("/api/media/", "");
      const started = performance.now();
      await warmHandwritingPages(ws, actor, { title: "Site" });
      const drawMs = performance.now() - started;
      expect(drawn).toBeGreaterThanOrEqual(1);
      const bytes = readFileSync(join(MEDIA_DIR, file)).length;
      expect(bytes).toBeLessThan(40 * 1024 * 1024);
      expect(drawMs).toBeLessThan(30_000);
      drawn = 0;
      await warmHandwritingPages(ws, actor, { title: "Site" });
      await buildPublishPreview(ws, { title: "Site", actor });
      expect(drawn).toBe(0);
      await seedQ(`UPDATE node_attributes SET value = 'false' WHERE node_id = $1 AND key = '_published'`, [bigNote]);
    });
  });

  describe("pages a publish replaces, and a purged note's pages, are forgotten", () => {
    it("an edited drawing's old file goes with the publish that replaces it; the current one stays", async () => {
      await buildAndEnqueueSnapshot(ws, { id: actor.id, type: "human" }, { title: "Site" });
      const before = mediaOf((await served()).find((n) => n.id === hand)!.markdown)[0]!.file;
      await seedQ(`UPDATE node_attributes SET value = $2 WHERE node_id = $1 AND key = 'ink_data'`, [hand, ink("hand-stroke", 800)]);
      await buildAndEnqueueSnapshot(ws, { id: actor.id, type: "human" }, { title: "Site" });
      const after = mediaOf((await served()).find((n) => n.id === hand)!.markdown)[0]!.file;
      expect(after).not.toBe(before);
      await vi.waitFor(() => expect(existsSync(join(MEDIA_DIR, before))).toBe(false));
      expect((await q(`SELECT 1 FROM media_uploads WHERE filename = $1`, [before])).rowCount).toBe(0);
      expect(existsSync(join(MEDIA_DIR, after))).toBe(true);
      expect((await app.request(`/api/media/${after}`)).status).toBe(200);
    });

    it("purging the note removes its page files and their records, and nothing else's", async () => {
      const gone = await note("Gone sketch", "", { published: true, ink: ink("gone-stroke") });
      await buildAndEnqueueSnapshot(ws, { id: actor.id, type: "human" }, { title: "Site" });
      const file = mediaOf((await served()).find((n) => n.id === gone)!.markdown)[0]!.file;
      const keep = mediaOf((await served()).find((n) => n.id === hand)!.markdown)[0]!.file;
      expect(existsSync(join(MEDIA_DIR, file))).toBe(true);
      await trashNode(actor, ws, gone);
      await purgeDeleted(actor, ws, gone);
      await vi.waitFor(() => expect(existsSync(join(MEDIA_DIR, file))).toBe(false));
      expect((await q(`SELECT 1 FROM media_uploads WHERE filename = $1`, [file])).rowCount).toBe(0);
      expect(JSON.stringify((await loadServedSite(ws)).payload)).not.toContain(file);
      expect(existsSync(join(MEDIA_DIR, keep))).toBe(true);
    });
  });
});

describe("serveHandwritingPages", () => {
  it("puts the pages after the text in order, numbered, and drops the field", () => {
    const nodes: SiteNode[] = [
      { id: "a", title: "A", markdown: "words\n", ink_pages: ["/api/media/1.svg", "/api/media/2.svg"] },
      { id: "b", title: "B", markdown: "", ink_pages: ["/api/media/3.svg"] },
      { id: "c", title: "C", markdown: "none" },
    ];
    serveHandwritingPages(nodes);
    expect(nodes[0]!.markdown).toBe("words\n\n![][ink-page-1]\n\n[ink-page-1]: /api/media/1.svg#ink-page-1\n\n![][ink-page-2]\n\n[ink-page-2]: /api/media/2.svg#ink-page-2");
    expect(nodes[1]!.markdown).toBe("![][ink-page-1]\n\n[ink-page-1]: /api/media/3.svg#ink-page-1");
    expect(nodes[2]!.markdown).toBe("none");
    expect(nodes.every((n) => !("ink_pages" in n))).toBe(true);
  });
});
