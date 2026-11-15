import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { q, getWorkspaceId } from "../db.js";
import { apiOnError } from "../httpError.js";
import { withIdempotencyKey } from "../spine/idempotency.js";
import { mutate } from "../spine/mutate.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { assertTagNameAvailable, tagNameTaken, TagNameConflictError } from "../services/tagHierarchy.js";
import nodes from "../routes/nodes.js";
import tags from "../routes/tags.js";
import mcp from "../routes/mcp.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const admin: ActorCtx = { id: "tag-conflict-admin", name: "Test", type: "human", role: "admin" };
let ws: string;
const ids: string[] = [];
function appFor(actor = admin) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await withIdempotencyKey(c.req.header("Idempotency-Key") ?? randomUUID(), next);
  });
  app.route("/api/nodes", nodes);
  app.route("/api/tags", tags);
  app.route("/api/mcp", mcp);
  return app;
}
async function seed(title: string = randomUUID(), parent: string | null = null, kind = "class_tag", workspace = ws) {
  const id = randomUUID();
  await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown,parent_id)
    VALUES($1::uuid,$2,'manual',$3,$4,($1::uuid)::text,'original body',$5)`, [id, workspace, kind, title, parent]);
  ids.push(id);
  return { id, title };
}
const request = (path: string, body: unknown, actor = admin, key = randomUUID()) => appFor(actor).request(path, {
  method: path.includes("/mcp/") ? "POST" : "PATCH",
  headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body),
});
async function state(id: string) {
  return (await q(`SELECT title,slug,markdown,parent_id,tag_color,updated_at FROM content_nodes WHERE id=$1`, [id])).rows[0];
}
async function successfulEvents(id: string) {
  return (await q<{ n: number }>(`SELECT count(*)::int AS n FROM domain_events
    WHERE target_id=$1 AND event_type IN ('NODE_UPDATED','TAG_UPDATED')`, [id])).rows[0].n;
}
async function expectConflict(response: Response) {
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "tag_name_conflict",
    detail: "A tag with this name already exists in this parent. Choose another name or parent.",
  });
}

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("tag name conflict contract", () => {
  beforeAll(async () => {
    ws = await getWorkspaceId();
    Object.assign(admin, await persistActor(ws, admin));
  });
  afterEach(async () => { await awaitAllDispatchers(); });
  afterAll(async () => {
    await awaitAllDispatchers();
    await seedQ("DELETE FROM content_nodes WHERE id=ANY($1::uuid[])", [ids]);
  });

  for (const surface of ["node", "tag", "agent", "dry-run"] as const) {
    it(`${surface} rejects a sibling name without changing content or recording success`, async () => {
      const existing = await seed(), edited = await seed();
      const before = await state(edited.id);
      const path = surface === "node" ? `/api/nodes/${edited.id}` : surface === "tag" ? `/api/tags/${edited.id}`
        : `/api/mcp/tools/updateNode${surface === "dry-run" ? "?dryRun=true" : ""}`;
      const body = surface === "tag" ? { name: existing.title, color: "#ff0000" }
        : { ...(surface === "node" ? {} : { id: edited.id, base_markdown: "original body" }), title: existing.title, markdown: "unsaved draft" };
      await expectConflict(await request(path, body));
      expect(await state(edited.id)).toEqual(before);
      expect(await successfulEvents(edited.id)).toBe(0);
      expect((await q("SELECT count(*)::int AS n FROM outbox WHERE payload->>'nodeId'=$1", [edited.id])).rows[0].n).toBe(0);
    });
  }

  it("rejects a reparent collision, including a move to root", async () => {
    const root = await seed(), parent = await seed();
    const child = await seed(root.title, parent.id);
    const before = await state(child.id);
    await expectConflict(await request(`/api/nodes/${child.id}`, { parent_id: null }));
    expect(await state(child.id)).toEqual(before);
    await expectConflict(await request(`/api/nodes/${root.id}`, { parent_id: parent.id }));
    expect((await state(root.id)).parent_id).toBeNull();
  });

  it("checks the resulting name and parent together", async () => {
    const parent = await seed(), occupied = await seed(randomUUID(), parent.id), moved = await seed();
    await expectConflict(await request(`/api/nodes/${moved.id}`, { title: occupied.title, parent_id: parent.id }));
    expect((await request(`/api/nodes/${moved.id}`, { title: `${occupied.title}-free`, parent_id: parent.id })).status).toBe(200);
  });

  it("allows same-title ordinary notes, another parent, a deleted tag and the tag itself", async () => {
    const tag = await seed(), parent = await seed(), child = await seed(randomUUID(), parent.id);
    const content = await seed(randomUUID(), null, "content");
    expect((await request(`/api/nodes/${content.id}`, { title: tag.title })).status).toBe(200);
    expect((await request(`/api/nodes/${child.id}`, { title: tag.title })).status).toBe(200);
    expect((await request(`/api/nodes/${tag.id}`, { title: tag.title, markdown: "new body" })).status).toBe(200);
    await seedQ("UPDATE content_nodes SET deleted_at=now() WHERE id=$1", [tag.id]);
    const fresh = await seed();
    expect((await request(`/api/nodes/${fresh.id}`, { title: tag.title })).status).toBe(200);
  });

  it("does not consume the failed request's idempotency key", async () => {
    const occupied = await seed(), edited = await seed(), key = randomUUID();
    await expectConflict(await request(`/api/nodes/${edited.id}`, { title: occupied.title }, admin, key));
    expect((await q("SELECT * FROM idempotency_keys WHERE key=$1", [key])).rowCount).toBe(0);
    const correction = { title: randomUUID() };
    expect((await request(`/api/nodes/${edited.id}`, correction, admin, key)).status).toBe(200);
    expect(await (await request(`/api/nodes/${edited.id}`, correction, admin, key)).json()).toEqual({ deduped: true });
    expect(await successfulEvents(edited.id)).toBe(1);
  });

  it("does not reserve names across workspaces or fold their case", async () => {
    const otherWs = randomUUID(), title = `Case-${randomUUID()}`;
    await q("INSERT INTO workspaces(id,name,slug) VALUES($1::uuid,'tag conflict test',($1::uuid)::text)", [otherWs]);
    try {
      await seed(title, null, "class_tag", otherWs);
      const edited = await seed();
      await expect(assertTagNameAvailable(ws, edited.id, { title, parentId: null })).resolves.toBeUndefined();
      expect((await request(`/api/nodes/${edited.id}`, { title })).status).toBe(200);
      const lower = await seed();
      expect((await request(`/api/nodes/${lower.id}`, { title: title.toLowerCase() })).status).toBe(200);
    } finally { await q("DELETE FROM workspaces WHERE id=$1", [otherWs]); }
  });

  it("serializes competing renames and commits only one success", async () => {
    const a = await seed(), b = await seed(), title = randomUUID();
    const results = await Promise.all([a, b].map(tag => request(`/api/nodes/${tag.id}`, { title })));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    await expectConflict(results.find(r => r.status === 409)!);
    expect(await successfulEvents(a.id) + await successfulEvents(b.id)).toBe(1);
  });

  it("keeps the admin gate and token space scope ahead of name checks", async () => {
    const occupied = await seed(), edited = await seed();
    const editor = await persistActor(ws, { ...admin, role: "editor" });
    expect((await request(`/api/tags/${edited.id}`, { name: occupied.title }, editor)).status).toBe(403);
    const scoped = await persistActor(ws, { ...admin, type: "agent", tokenScope: {
      tokenId: randomUUID(), allowedTools: null, access: "read", writeMode: "apply", expiresAt: null,
    } });
    for (const suffix of ["", "?dryRun=true"]) {
      expect((await request(`/api/mcp/tools/updateNode${suffix}`, { id: edited.id, title: occupied.title }, scoped)).status).toBe(403);
    }
    expect(await successfulEvents(edited.id)).toBe(0);
  });

  it("maps the actual database backstop after rolling back a write and its event", async () => {
    const occupied = await seed(), edited = await seed(), before = await state(edited.id);
    const app = appFor();
    app.patch("/backstop", async c => {
      await mutate({
        actor: admin, workspaceId: ws, authority: { kind: "node", nodeId: edited.id, op: "write_node" },
        event: { type: "NODE_UPDATED", targetType: "node", targetId: edited.id, payload: { title: occupied.title } },
        apply: async () => { await seedQ("UPDATE content_nodes SET title=$2,markdown='must roll back' WHERE id=$1", [edited.id, occupied.title]); },
      });
      return c.json({ ok: true });
    });
    await expectConflict(await app.request("/backstop", { method: "PATCH" }));
    expect(await state(edited.id)).toEqual(before);
    expect(await successfulEvents(edited.id)).toBe(0);
  });

  it("does not reinterpret unrelated uniqueness or storage failures as a name conflict", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const error of [
        Object.assign(new Error("primary key failure"), { code: "23505", constraint: "content_nodes_pkey" }),
        Object.assign(new Error("storage failure"), { code: "XX000", constraint: "content_nodes_class_tag_workspace_parent_title_uq" }),
      ]) {
        const app = appFor();
        app.get("/failure", () => { throw error; });
        const response = await app.request("/failure");
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "internal" });
      }
    } finally { errorLog.mockRestore(); }
  });
  // T6: pack installs (owner import, agent proposal) ask the same rule as a
  // rename. A pack lands at the root, so only a root sibling takes its name.
  const post = (path: string, body: unknown) => appFor().request(path, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify(body),
  });

  it("pack import answers the shared 409 for a root name and installs a name used only under another parent", async () => {
    const root = await seed(), parent = await seed();
    await expectConflict(await post("/api/tags/import", { name: root.title, fields: [] }));
    const child = await seed(randomUUID(), parent.id);
    const installed = await post("/api/tags/import", { name: child.title, fields: [] });
    expect(installed.status).toBe(201);
    const { id } = await installed.json() as { id: string };
    ids.push(id);
    expect((await state(id)).parent_id).toBeNull();
  });

  it("proposeTagPack refuses a taken root name with the shared 409, not a tool failure", async () => {
    const root = await seed(), parent = await seed(), child = await seed(randomUUID(), parent.id);
    await expectConflict(await post("/api/mcp/tools/proposeTagPack?dryRun=true", { args: { name: root.title } }));
    const free = await post("/api/mcp/tools/proposeTagPack?dryRun=true", { args: { name: child.title } });
    expect(free.status).toBe(200);
    expect((await free.json() as { result: { status: string } }).result.status).toBe("pending_approval");
  });

  it("tagNameTaken is exact and per parent, and ignores the excepted tag", async () => {
    const parent = await seed(), tag = await seed(`Name-${randomUUID()}`, parent.id);
    expect(await tagNameTaken(ws, parent.id, tag.title)).toBe(true);
    expect(await tagNameTaken(ws, parent.id, tag.title.toLowerCase())).toBe(false);
    expect(await tagNameTaken(ws, parent.id, ` ${tag.title}`)).toBe(false);
    expect(await tagNameTaken(ws, null, tag.title)).toBe(false);
    expect(await tagNameTaken(ws, parent.id, tag.title, { exceptId: tag.id })).toBe(false);
    await expect(assertTagNameAvailable(ws, null, { title: tag.title, parentId: parent.id })).rejects.toBeInstanceOf(TagNameConflictError);
  });
});
