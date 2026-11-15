// D52: a single note's Download/Copy Markdown is the file the Markdown zip
// writes for it — POST /api/nodes/:id/export-preview with format "markdown"
// answers it. The repro: a note imported with `status: draft`, set to done in
// the properties panel and tagged #book exported raw (status: draft, no tags,
// no title). Media links are the one planned difference: the zip points them
// into its attachments folder, the single file keeps the server path.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID as ownWorkspaceUuid } from "node:crypto";
import { Hono } from "hono";
import { inflateRawSync } from "node:zlib";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, pool, q } from "../db.js";

// A workspace of its own: a backup or export reads the whole workspace, so in
// the shared default workspace its cost would grow with every other test's
// notes (on a reused DB the export query alone took 1–2 s).
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import nodeRouter from "../routes/nodes.js";
import exportRouter from "../routes/export.js";
import { rewriteMediaLinks } from "../services/exportZip.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();

function appFor(actor: ActorCtx) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/nodes", nodeRouter);
  app.route("/api/export", exportRouter);
  return app;
}
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** The text files of a zip, by name (read from its central directory). */
function unzip(zip: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let at = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(at + 10);
  at = zip.readUInt32LE(at + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    files.set(name, (method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

describe.skipIf(!isTestDatabase())("single-note Markdown export = the zip's file (D52)", () => {
  let ws = "";
  const stamp = Date.now();
  const alice: ActorCtx = { id: "", name: "Alice", role: "admin", type: "human" };
  let note = "", target = "", tag = "";

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Test', $1) RETURNING id::text`, [`single-export-${ownWorkspaceUuid()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    Object.assign(alice, await persistActor(ws, alice));
    // Out of 共用: Alice's notes land in her personal space and the whole-vault
    // zip holds only what she reads — this test's notes, not every other
    // test's in the shared database (whose size would otherwise set its cost).
    await q(`DELETE FROM space_members m USING spaces s WHERE s.id = m.space_id AND s.workspace_id = $1 AND s.is_default AND m.actor_id = $2`, [ws, alice.id]);
    const app = appFor(alice);
    target = (await (await app.request("/api/nodes", json("POST", { title: `D52 target ${stamp}`, markdown: "" }))).json() as { id: string }).id;
    note = (await (await app.request("/api/nodes", json("POST", {
      title: `D52 book ${stamp}`,
      markdown: `---\nstatus: draft\n---\nSee [the target](onden://node/${target}) and ![](/api/media/${stamp}-cover.png).\n`,
    }))).json() as { id: string }).id;
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, $2, 'status', 'draft', 'frontmatter')
             ON CONFLICT DO NOTHING`, [ws, note]);
    expect((await app.request(`/api/nodes/${note}/attributes/status`, json("PUT", { value: "done" }))).status).toBe(200);
    ({ tagId: tag } = await seedClassTag(ws, { name: `d52-book-${stamp}` }));
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [note, tag]);
  });

  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE id = ANY($1::uuid[])`, [[note, target, tag].filter(Boolean)]);
    await pool.end();
  });

  async function single(markdown?: string): Promise<string> {
    const saved = (await q<{ title: string; markdown: string }>(`SELECT title, markdown FROM content_nodes WHERE id = $1`, [note])).rows[0]!;
    const res = await appFor(alice).request(`/api/nodes/${note}/export-preview`, json("POST", { title: saved.title, markdown: markdown ?? saved.markdown, format: "markdown" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    return (await res.json() as { markdown: string }).markdown;
  }

  it("writes the zip's file for the note: title, tags, the current status, rewritten note links", async () => {
    const zip = unzip(Buffer.from(await (await appFor(alice).request("/api/export/markdown.zip")).arrayBuffer()));
    const zipped = zip.get(`D52 book ${stamp}.md`)!;
    const file = await single();
    expect(rewriteMediaLinks(file)).toBe(zipped);
    expect(file).toContain(`title: D52 book ${stamp}`);
    expect(file).toContain("status: done");
    expect(file).not.toContain("draft");
    expect(file).toContain(`tags:\n  - d52-book-${stamp}\n`);
    const targetTitle = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [target])).rows[0]!.title;
    expect(file).toContain(`[the target](./${targetTitle.replace(/ /g, "%20")}.md)`);
    // The media link stays the server path; the client makes it absolute.
    expect(file).toContain(`![](/api/media/${stamp}-cover.png)`);
    expect(zipped).toContain(`![](./attachments/${stamp}-cover.png)`);
  });

  it("exports the caller's unsaved text, without writing it", async () => {
    const file = await single("---\nstatus: draft\n---\nA draft not saved yet\n");
    expect(file).toContain("A draft not saved yet");
    expect(file).toContain("status: done");
    expect((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [note])).rows[0]!.markdown).not.toContain("not saved");
  });
});
