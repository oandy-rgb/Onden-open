// T11: a tag has one rename (TAG_UPDATED, a `tag-` slug, an undo that puts
// name and slug back) whether the UI renames its node (PATCH /api/nodes/:id)
// or calls PATCH /api/tags/:id, and one name shape (tagHierarchy.ts
// assertTagNameShape) at every create, rename, rename undo and pack import.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { q, getWorkspaceId } from "../db.js";
import { apiOnError } from "../httpError.js";
import { withIdempotencyKey } from "../spine/idempotency.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import { importMarkdownNote } from "../modules/importers/markdown/note.js";
import nodes from "../routes/nodes.js";
import tags from "../routes/tags.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerNodeHooks } from "../spine/nodeHooks.js";
import { seedQ } from "./helpers/seedQ.js";

const admin: ActorCtx = { id: "tag-rename-shape-admin", name: "Test", type: "human", role: "admin" };
let ws: string;
const ids: string[] = [];

const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => {
  c.set("actor", admin);
  await withIdempotencyKey(randomUUID(), next);
});
app.route("/api/nodes", nodes);
app.route("/api/tags", tags);

const send = (method: string, path: string, body: unknown) => app.request(path, {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const unique = (name: string) => `${name}-${randomUUID().slice(0, 8)}`;

async function createTag(name: string): Promise<string> {
  const response = await send("POST", "/api/tags", { name });
  expect(response.status).toBe(201);
  const { id } = await response.json() as { id: string };
  ids.push(id);
  return id;
}
async function row(id: string) {
  return (await q<{ title: string; slug: string; markdown: string }>(
    "SELECT title, slug, markdown FROM content_nodes WHERE id = $1", [id])).rows[0]!;
}
async function events(id: string) {
  return (await q<{ id: string; event_type: string; tx_meta: Record<string, unknown> | null }>(
    `SELECT id::text, event_type, tx_meta FROM domain_events
      WHERE target_id = $1 AND event_type IN ('NODE_UPDATED', 'TAG_UPDATED') ORDER BY domain_events.id`, [id])).rows;
}

// Each is a character a tag name cannot hold (see tagHierarchy.ts).
const INVALID = ["a/b", "C#", "x, y", "key:value", "{a}", "line\nbreak", " padded"];

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("tag rename and name shape (T11)", () => {
  beforeAll(async () => {
    ws = await getWorkspaceId();
    Object.assign(admin, await persistActor(ws, admin));
  });
  afterEach(async () => { await awaitAllDispatchers(); });
  afterAll(async () => {
    await awaitAllDispatchers();
    await seedQ("DELETE FROM content_nodes WHERE id = ANY($1::uuid[])", [ids]);
  });

  it("a node rename of a tag records TAG_UPDATED, keeps the tag- slug and answers the node", async () => {
    const id = await createTag(unique("before"));
    const name = unique("after");
    const response = await send("PATCH", `/api/nodes/${id}`, { title: name });
    expect(response.status).toBe(200);
    const node = await response.json() as Record<string, unknown>;
    expect(node).toMatchObject({ id, title: name, node_type: "class_tag" });
    expect(node.slug).toMatch(/^tag-after-/);
    expect((await row(id)).slug).toBe(node.slug);
    expect((await events(id)).map((e) => e.event_type)).toEqual(["TAG_UPDATED"]);
  });

  it("a rename, and its undo, hand the new title to the content hooks (search embedding)", async () => {
    const seen: Array<{ nodeId: string; text: string }> = [];
    registerNodeHooks(`t11-probe-${randomUUID()}`, { contentCommitted: async (c) => { seen.push(c); } });
    const original = unique("embed");
    const id = await createTag(original);
    const name = unique("embedded");
    expect((await send("PATCH", `/api/nodes/${id}`, { title: name })).status).toBe(200);
    expect(seen.filter((c) => c.nodeId === id).at(-1)?.text).toMatch(new RegExp(`^${name}\\n`));
    const [rename] = await events(id);
    await restoreEvent(rename!.id, { actor: admin, workspaceId: ws });
    expect(seen.filter((c) => c.nodeId === id).at(-1)?.text).toMatch(new RegExp(`^${original}\\n`));
  });

  it("undoing that rename puts the old name and slug back", async () => {
    const original = unique("undo");
    const id = await createTag(original);
    const before = await row(id);
    expect((await send("PATCH", `/api/nodes/${id}`, { title: unique("renamed") })).status).toBe(200);
    const [rename] = await events(id);
    expect(await restoreEvent(rename!.id, { actor: admin, workspaceId: ws })).toMatchObject({ restored: true });
    const after = await row(id);
    expect({ title: after.title, slug: after.slug }).toEqual({ title: before.title, slug: before.slug });
  });

  it("the other fields of the same PATCH still apply, and an unchanged title keeps the slug", async () => {
    const id = await createTag(unique("both"));
    const name = unique("both-renamed");
    const response = await send("PATCH", `/api/nodes/${id}`, { title: name, markdown: "tag page body" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ title: name, markdown: "tag page body" });
    const recorded = await events(id);
    expect(recorded.map((e) => e.event_type)).toEqual(["NODE_UPDATED", "TAG_UPDATED"]);
    expect(recorded[0]!.tx_meta?.prev_field_values).toEqual({});
    const slug = (await row(id)).slug;
    expect((await send("PATCH", `/api/nodes/${id}`, { title: name, markdown: "again" })).status).toBe(200);
    expect(await row(id)).toMatchObject({ slug, markdown: "again" });
  });

  it("a name with spaces and CJK stays valid everywhere", async () => {
    const id = await createTag(unique("閱讀 清單"));
    expect((await send("PATCH", `/api/nodes/${id}`, { title: unique("研究 筆記") })).status).toBe(200);
    expect((await send("PATCH", `/api/tags/${id}`, { name: unique("C++ 與 Rust") })).status).toBe(200);
    const imported = await send("POST", "/api/tags/import", { name: unique("讀書 會"), fields: [] });
    expect(imported.status).toBe(201);
    ids.push((await imported.json() as { id: string }).id);
  });

  for (const name of INVALID) {
    it(`refuses ${JSON.stringify(name)} at create, both renames and pack import`, async () => {
      // POST /api/tags trims the name first, and answers its own 400 for "/".
      if (name.trim() === name) {
        const created = await send("POST", "/api/tags", { name: unique(name) });
        expect(created.status).toBe(400);
        if (!name.includes("/")) expect(await created.json()).toMatchObject({ error: "tag_name_invalid" });
      }
      const id = await createTag(unique("valid"));
      const before = await row(id);
      for (const [method, path, body] of [
        ["PATCH", `/api/nodes/${id}`, { title: unique(name), markdown: "must not save" }],
        ["PATCH", `/api/tags/${id}`, { name: unique(name) }],
      ] as const) {
        const response = await send(method, path, body);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "tag_name_invalid" });
      }
      expect(await row(id)).toEqual(before);
      expect(await events(id)).toEqual([]);
      expect((await send("POST", "/api/tags/import", { name: unique(name), fields: [] })).status).toBe(400);
    });
  }

  it("refuses a hashtag-invalid segment of a path", async () => {
    const response = await send("POST", "/api/tags/resolve-path", { path: `${unique("ok")}/C#` });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "tag_name_invalid" });
  });

  it("a Markdown import whose frontmatter would create a hashtag-invalid tag skips that note", async () => {
    const title = unique("import-invalid-tag");
    const result = await importMarkdownNote({
      actor: admin, workspaceId: ws, source: { id: randomUUID(), name: "t11" }, parentId: null, reuse: false,
      file: { path: `${title}.md`, content: `---\ntitle: ${title}\ntags: [${unique("ok")}, "${unique("key:value")}"]\n---\nbody` },
    });
    expect(result).toEqual({ status: "refused", reason: "invalid_tag_name" });
    expect((await q("SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND title = $2", [ws, title])).rowCount).toBe(0);
  });

  it("a tag whose name predates the rule still edits and renames, but the rename is not undone back to it", async () => {
    const legacy = unique("legacy:name");
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, 'manual', 'class_tag', $2, $3, '') RETURNING id::text`,
      [ws, legacy, `tag-${randomUUID()}`],
    )).rows[0]!.id;
    ids.push(id);
    expect((await send("PATCH", `/api/nodes/${id}`, { title: legacy, markdown: "kept" })).status).toBe(200);
    expect((await send("PATCH", `/api/nodes/${id}`, { title: unique("legacy-fixed") })).status).toBe(200);
    const rename = (await events(id)).find((e) => e.event_type === "TAG_UPDATED")!;
    expect(await restoreEvent(rename.id, { actor: admin, workspaceId: ws })).toMatchObject({ code: "state_conflict" });
  });
});
