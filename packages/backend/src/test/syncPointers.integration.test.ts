// Real PostgreSQL, real /api/pointers and /api/sync: sidebar pointers created or
// removed on one device reach the others through the delta, and a pointer is
// never shipped to an actor who cannot read both of its endpoints.
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import syncRouter from "../routes/sync.js";
import pointerRouter from "../routes/pointers.js";
import { mutate } from "../spine/mutate.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

let ws: string;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
let admin: ActorCtx = { id: "pointer-admin", name: "Test", role: "admin", type: "human" };
let viewer: ActorCtx = { ...admin, id: "pointer-viewer", role: "viewer" };

type Pointer = { id: string; parent_id: string | null; target_id: string };
type Delta = { pointers?: { upsert: Pointer[]; delete: string[]; replace_for?: string[] } };

function appFor(actor: ActorCtx) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/sync", syncRouter);
  app.route("/api/pointers", pointerRouter);
  return app;
}
async function post(actor: ActorCtx, path: string, body: unknown) {
  return appFor(actor).request(path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
async function pull(actor: ActorCtx, since: string): Promise<Delta> {
  // /api/sync parses `since` as a JS number. In a shared test DB the event id
  // sequence may already be past 2^53 (eventRestoreAtomicity moves it there), where
  // Number() can round the cursor UP past this test's own events. Back off a
  // margin larger than the rounding error; re-shipping older rows is harmless.
  const safe = BigInt(since) - 256n;
  const res = await post(actor, "/api/sync", { since: Number(safe < 0n ? 0n : safe) });
  expect(res.status).toBe(200);
  return res.json() as Promise<Delta>;
}
async function cursor(): Promise<string> {
  return (await db.q<{ id: string }>("SELECT COALESCE(MAX(id),0)::text AS id FROM domain_events WHERE workspace_id=$1", [ws])).rows[0].id;
}
async function createNote(title: string): Promise<string> {
  const id = randomUUID();
  await mutate({
    actor: admin, workspaceId: ws, authority: { kind: "principal_admin" },
    event: { type: "NODE_CREATED", targetType: "node", targetId: id, payload: { title } },
    apply: async () => {
      await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown)
        VALUES($1::uuid,$2,'manual','content',$3,$4,'')`, [id, ws, title, `${title}-${id}`]);
    },
  });
  return id;
}
async function pin(targetId: string, parentId: string): Promise<string> {
  const res = await post(admin, "/api/pointers", { target_id: targetId, parent_id: parentId });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("sidebar pointers in sync", () => {
  let target: string, folder: string, secret: string;

  beforeAll(async () => {
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Sync pointers',$1) RETURNING id", [randomUUID()])).rows[0].id;
    admin = await persistActor(ws, admin);
    viewer = await persistActor(ws, viewer);
    target = await createNote("target");
    folder = await createNote("folder");
    secret = await createNote("secret");
    // The admin's notes start in their personal space: share target and folder
    // through the default space, and keep secret in an admin-only space.
    const shared = (await db.q<{ id: string }>("SELECT id FROM spaces WHERE workspace_id=$1 AND is_default", [ws])).rows[0].id;
    await putInSpace(target, shared);
    await putInSpace(folder, shared);
    await putInSpace(secret, await adminOnlySpace(ws, `restricted-${randomUUID()}`, [admin.id]));
  });
  afterAll(async () => { await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [ws]); });

  it("ships a new pointer and retires it after deletion", async () => {
    let since = await cursor();
    const pointerId = await pin(target, folder);
    let delta = await pull(viewer, since);
    expect(delta.pointers?.replace_for).toContain(target);
    expect(delta.pointers?.upsert).toContainEqual(expect.objectContaining({ id: pointerId, parent_id: folder, target_id: target }));

    since = await cursor();
    const removed = await appFor(admin).request(`/api/pointers/${pointerId}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    delta = await pull(viewer, since);
    // The pointed-to note is in scope, so a client drops its now-absent pointer.
    expect(delta.pointers?.replace_for).toContain(target);
    expect(delta.pointers?.upsert.map((p) => p.id)).not.toContain(pointerId);
  });

  it("never ships a pointer whose parent the reader cannot see", async () => {
    const since = await cursor();
    const hiddenPin = await pin(target, secret);
    const viewerDelta = await pull(viewer, since);
    expect(viewerDelta.pointers?.replace_for).toContain(target);
    expect(viewerDelta.pointers?.upsert.map((p) => p.id)).not.toContain(hiddenPin);
    expect(JSON.stringify(viewerDelta)).not.toContain(secret);

    const adminDelta = await pull(admin, since);
    expect(adminDelta.pointers?.upsert.map((p) => p.id)).toContain(hiddenPin);
  });

  it("includes pointers when hydrating newly readable nodes", async () => {
    const version = await db.q<{ epoch: string }>("SELECT membership_epoch::text AS epoch FROM workspaces WHERE id=$1", [ws]);
    const res = await post(viewer, "/api/sync/nodes", {
      ids: [target, folder], expected_epoch: Number(version.rows[0].epoch), expected_event_cursor: await cursor(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { pointers?: Pointer[] };
    expect(body.pointers?.every((p) => p.parent_id !== secret)).toBe(true);
  });
});
