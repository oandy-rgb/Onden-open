// D96 + D116, against a real Postgres (skips otherwise):
//   * D96 — the static site zip (GET /api/export-static) is self-contained:
//     every image the published pages show is bundled under media/, and each
//     page links to its bundled copy by a relative path, not /api/media/….
//   * D116 — the site's home is decided in one place (publishing/siteHome.ts):
//     an approved agent publish keeps the workspace's home; a workspace home
//     that isn't published falls back to the first published untagged page
//     (never a #paper that happens to be older); and the self-hosted site, the
//     zip and the static host push all open on the home page the site decided
//     (the frontend draws `/site/` from the served home; the copies save that page).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

const h = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("../modules/website/publishing/githubPages.js", () => ({
  pushToGitHubPages: async (files: Array<{ path: string; content: string | Buffer }>) => {
    h.paths = files.map((f) => f.path);
    return "https://example.test/";
  },
  expectedPagesUrl: () => "https://example.test/",
}));

import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import publishRouter from "../modules/website/routes.js";
import { performPagesPush } from "../modules/website/publishing/pagesPush.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { startFakeRenderer } from "./helpers/fakeRenderer.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishWithPreview } from "./helpers/publishWithPreview.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let currentActor: ActorCtx | null = null;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api", publishRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let owner: ActorCtx = { id: "site-home-owner", name: "Owner", role: "admin", type: "human" };
let space = "";
let paperTag = "";
let renderer: Awaited<ReturnType<typeof startFakeRenderer>> | null = null;

/** The zip's entries by name (stored or deflated). */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28), extraLength = zip.readUInt16LE(at + 30), commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataAt, dataAt + size);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function exportZip(): Promise<Map<string, Buffer>> {
  currentActor = owner;
  const res = await app.request("/api/export-static");
  expect(res.status).toBe(200);
  return unzip(Buffer.from(await res.arrayBuffer()));
}

/** A note in the publishing space, marked 「發布」; `publish: false` keeps it off (「不發布」). */
async function note(title: string, opts: { publish?: boolean; paper?: boolean; markdown?: string } = {}): Promise<{ id: string; slug: string }> {
  const slug = `${title.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,$4) RETURNING id::text`, [workspaceId, title, slug, opts.markdown ?? "body"])).rows[0]!.id;
  await putInSpace(id, space);
  if (opts.paper) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id, paperTag]);
  currentActor = owner;
  expect((await send(`/api/nodes/${id}/attributes/_published`, "PUT", { value: opts.publish === false ? "false" : "true", value_type: "bool" })).status).toBe(200);
  return { id, slug };
}
const setHome = (id: string | null) => q(`UPDATE workspaces SET home_node_id = $2 WHERE id = $1`, [workspaceId, id]);
const publish = async () => { currentActor = owner; expect((await publishWithPreview((p, b) => send(p, "POST", b))).status).toBe(201); };
const servedHome = async () => {
  currentActor = null;
  return ((await (await app.request("/api/site")).json()) as { home_node_id: string | null }).home_node_id;
};
/** Start each case from an empty site. */
async function reset() {
  await setHome(null);
  await q(`DELETE FROM publish_snapshots WHERE workspace_id = $1`, [workspaceId]);
  await seedQ(`UPDATE node_attributes SET value = 'false' WHERE key = '_published' AND workspace_id = $1`, [workspaceId]);
}

describe.skipIf(!isTestDb)("site home in one place; a self-contained static zip (D96, D116)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Site home',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(workspaceId, owner);
    currentActor = owner;
    space = await makeSpace(workspaceId, `pub-${randomUUID()}`, [{ id: owner.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
    paperTag = (await seedClassTag(workspaceId, { name: `Paper ${randomUUID().slice(0, 6)}` })).tagId;
    renderer = await startFakeRenderer(workspaceId); // the frontend's pages, for the static copy
  });
  afterAll(async () => { await renderer?.close(); });

  it("D96: the zip carries each image the pages show, linked by its bundled relative path", async () => {
    await reset();
    mkdirSync(MEDIA_DIR, { recursive: true });
    const image = `${randomUUID().replace(/-/g, "")}.png`;
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    writeFileSync(join(MEDIA_DIR, image), bytes);
    try {
      const page = await note("Figure", { markdown: `# Figure\n\n![fig](/api/media/${image})` });
      await publish();
      const files = await exportZip();
      expect(files.get(`media/${image}`)?.equals(bytes)).toBe(true);
      const html = files.get(`site/${page.slug}/index.html`)!.toString("utf8");
      expect(html).toContain(`../../media/${image}`);
      expect(html).not.toContain("/api/media/");
    } finally {
      rmSync(join(MEDIA_DIR, image), { force: true });
    }
  });

  it("D116: a publish that names no home keeps the workspace's home, not the oldest page", async () => {
    await reset();
    await note("Paper", { paper: true }); // oldest published page, tagged
    await note("Intro"); // the first untagged page: the fallback, not the home
    const home = await note("Welcome");
    await setHome(home.id);
    await publish(); // the owner's own publish: names no home, so the site decides
    expect(await servedHome()).toBe(home.id);
  });

  it("D116: an unpublished home falls back to the first published untagged page", async () => {
    await reset();
    await note("Paper", { paper: true }); // older, published, tagged
    const draftHome = await note("Draft", { publish: false }); // untagged but not on the site
    const untagged = await note("About");
    await setHome(draftHome.id);
    await publish();
    expect(await servedHome()).toBe(untagged.id);
  });

  it("D116: the self-hosted site, the zip and the static push all open on the home the site decided, also after a takedown", async () => {
    await reset();
    const paper = await note("Paper", { paper: true });
    const home = await note("Home page");
    const other = await note("Other");
    await setHome(home.id);
    await publish();

    const agree = async (expected: { id: string; slug: string }) => {
      expect(await servedHome()).toBe(expected.id);
      const files = await exportZip();
      // The copies open on site/index.html, the page the frontend draws from the served home.
      expect(files.get("index.html")!.toString("utf8")).toContain("url=site/index.html");
      expect(files.has("site/index.html")).toBe(true);
      expect(files.has(`site/${expected.slug}/index.html`)).toBe(true);
      h.paths = [];
      await performPagesPush({ workspaceId, snapshotId: "latest" });
      expect(h.paths).toContain("site/index.html");
      expect(h.paths).toContain(`site/${expected.slug}/index.html`);
    };
    await agree(home);

    // The home taken down after the publish: every copy falls back the same way,
    // to the first untagged page still on the site, not the older #paper.
    currentActor = owner;
    expect((await send(`/api/nodes/${home.id}/attributes/_published`, "PUT", { value: "false", value_type: "bool" })).status).toBe(200);
    await agree(other);
    expect(paper.id).not.toBe(other.id);
  });
});
