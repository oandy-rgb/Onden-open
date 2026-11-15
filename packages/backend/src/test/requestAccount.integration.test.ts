// Real better-auth cookies, assembled middleware, PostgreSQL writes and events.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as db from "../db.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";

let ws: string;
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
const { auth } = await import("../auth.js");
const { app } = await import("../app.js");

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("request account with real cookies", () => {
  const accounts: Array<{ userId: string; actorId: string; cookie: string }> = [];
  beforeAll(async () => {
    await (await auth.$context).runMigrations();
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Request account',$1) RETURNING id", [randomUUID()])).rows[0].id;
    for (const name of ["A", "B"]) {
      const email = `${randomUUID()}@request-account.test`;
      const password = `Test-${randomUUID()}!`;
      const signedUp = await auth.api.signUpEmail({ body: { name, email, password } });
      const signedIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
      expect(signedIn.status).toBe(200);
      const cookie = signedIn.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
      expect(cookie.length).toBeGreaterThan(0);
      const actor = await db.q<{ id: string }>("INSERT INTO actors(workspace_id,name,type,external_id) VALUES($1,$2,'human',$3) RETURNING id", [ws,name,signedUp.user.id]);
      // Default-space membership is explicit since migration 097.
      await joinDefaultSpace(ws, actor.rows[0].id, "editor");
      accounts.push({ userId: signedUp.user.id, actorId: actor.rows[0].id, cookie });
    }
  }, 20000);
  afterAll(async () => {
    if (!ws) return;
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [ws]);
    await deleteWorkspaceActors(ws);
  });

  function headers(cookieOwner: number, expectedOwner: number) {
    return { Cookie: accounts[cookieOwner].cookie, "X-Onden-Expected-User": accounts[expectedOwner].userId, "Content-Type": "application/json" };
  }
  // Spaces (docs/architecture/spaces.md): A creates in the workspace's default
  // space, so B — an editor there — can read and write it too.
  const defaultSpace = async () => (await db.q<{ id: string }>("SELECT id::text FROM spaces WHERE workspace_id=$1 AND is_default", [ws])).rows[0].id;
  async function create() {
    const id = randomUUID();
    const response = await app.request("/api/nodes", { method: "POST", headers: headers(0,0), body: JSON.stringify({ id, title: "Original A input", markdown: "A body", space_id: await defaultSpace() }) });
    expect(response.status, await response.clone().text()).toBe(201);
    return id;
  }

  it("rejects A work sent with B's cookie, leaves no event/claim, and retries under A with the same key", async () => {
    const id = await create();
    const key = randomUUID();
    const body = JSON.stringify({ title: "A confirmed edit" });
    const wrong = await app.request(`/api/nodes/${id}`, { method: "PATCH", headers: { ...headers(1,0), "Idempotency-Key": key }, body });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "account_changed" });
    expect((await db.q("SELECT title FROM content_nodes WHERE id=$1", [id])).rows[0].title).toBe("Original A input");
    expect((await db.q("SELECT actor_id FROM domain_events WHERE target_id=$1", [id])).rows).toEqual([{ actor_id: accounts[0].actorId }]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = await app.request(`/api/nodes/${id}`, { method: "PATCH", headers: { ...headers(0,0), "Idempotency-Key": key }, body });
      expect(retry.status, await retry.clone().text()).toBe(200);
    }
    expect((await db.q("SELECT title FROM content_nodes WHERE id=$1", [id])).rows[0].title).toBe("A confirmed edit");
    const events = (await db.q("SELECT actor_id,event_type FROM domain_events WHERE target_id=$1 ORDER BY id", [id])).rows;
    expect(events).toEqual([
      { actor_id: accounts[0].actorId, event_type: "NODE_CREATED" },
      { actor_id: accounts[0].actorId, event_type: "NODE_UPDATED" },
    ]);
  });

  it("checks reads as well as writes, while B's own requests still work", async () => {
    const id = await create();
    expect((await app.request(`/api/nodes/${id}`, { headers: headers(1,0) })).status).toBe(401);
    expect((await app.request(`/api/nodes/${id}`, { headers: headers(1,1) })).status).toBe(200);
    const own = await app.request(`/api/nodes/${id}`, { method: "PATCH", headers: headers(1,1), body: JSON.stringify({ title: "B own edit" }) });
    expect(own.status).toBe(200);
    expect((await db.q("SELECT actor_id FROM domain_events WHERE target_id=$1 AND event_type='NODE_UPDATED'", [id])).rows[0].actor_id).toBe(accounts[1].actorId);
  });

  it("a matching identity does not elevate a view-only member's permissions", async () => {
    const id = await create();
    // B becomes view-only in the space the note is in.
    const space = await defaultSpace();
    await db.q("UPDATE space_members SET permission='view' WHERE space_id=$1 AND actor_id=$2", [space, accounts[1].actorId]);
    try {
      const baseline = await app.request(`/api/nodes/${id}`, { method: "PATCH", headers: { Cookie: accounts[1].cookie, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Must be denied" }) });
      expect(baseline.status).toBe(403);
      const response = await app.request(`/api/nodes/${id}`, { method: "PATCH", headers: headers(1,1), body: JSON.stringify({ title: "Must be denied" }) });
      expect(response.status).toBe(403);
      expect((await db.q("SELECT title FROM content_nodes WHERE id=$1", [id])).rows[0].title).toBe("Original A input");
    } finally {
      await db.q("UPDATE space_members SET permission='edit' WHERE space_id=$1 AND actor_id=$2", [space, accounts[1].actorId]);
    }
  });
});
