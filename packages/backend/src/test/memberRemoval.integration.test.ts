// GAP-237: removing a member must revoke their access. Session actor
// resolution creates an actor on first sight of a signed-in user, so before the
// fix a deleted member's next request re-created them as viewer. Real
// better-auth cookies + the assembled app; isolated *_test database only.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as db from "../db.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { deleteWorkspaceActors, setWorkspaceOwner } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";

let ws: string;
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
const { auth } = await import("../auth.js");
const { app } = await import("../app.js");

type Account = { userId: string; email: string; password: string; cookie: string };

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("member removal sticks (GAP-237)", () => {
  let owner: Account, newcomer: Account;
  let ownerActorId: string, nodeId: string;

  async function signIn(email: string, password: string): Promise<string> {
    const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    expect(res.status).toBe(200);
    return res.headers.getSetCookie().map(v => v.split(";", 1)[0]).join("; ");
  }
  async function account(name: string): Promise<Account> {
    const email = `${randomUUID()}@member-removal.test`, password = `Test-${randomUUID()}!`;
    const up = await auth.api.signUpEmail({ body: { name, email, password } });
    return { userId: up.user.id, email, password, cookie: await signIn(email, password) };
  }
  const as = (a: Account | string, init: RequestInit = {}) => ({
    ...init,
    headers: { Cookie: typeof a === "string" ? a : a.cookie, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  // Each test gets its own member of 共用 (an account plus an actor), so none
  // depends on another having removed or re-added someone.
  async function joinedMember(): Promise<{ member: Account; memberActorId: string }> {
    const member = await account("Member");
    const memberActorId = (await db.q<{ id: string }>("INSERT INTO actors(workspace_id,name,type,external_id) VALUES($1,'Member','human',$2) RETURNING id", [ws, member.userId])).rows[0].id;
    await joinDefaultSpace(ws, memberActorId, "editor");
    return { member, memberActorId };
  }
  async function removedMember(): Promise<Account> {
    const { member, memberActorId } = await joinedMember();
    expect((await app.request(`/api/actors/${memberActorId}`, as(owner, { method: "DELETE" }))).status).toBe(200);
    return member;
  }
  const actorRows = async (userId: string) =>
    (await db.q("SELECT id FROM actors WHERE workspace_id=$1 AND external_id=$2", [ws, userId])).rows;

  beforeAll(async () => {
    await (await auth.$context).runMigrations();
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Member removal',$1) RETURNING id", [randomUUID()])).rows[0].id;
    owner = await account("Owner");
    newcomer = await account("Newcomer");
    ownerActorId = (await db.q<{ id: string }>("INSERT INTO actors(workspace_id,name,type,external_id) VALUES($1,'Owner','human',$2) RETURNING id", [ws, owner.userId])).rows[0].id;
    // The first human inserted into an ownerless workspace becomes its owner (trigger); say so explicitly.
    await setWorkspaceOwner(ws, ownerActorId);
    // Default-space membership is explicit since migration 097 (the owner,
    // the first human, joined it by trigger); joinedMember() adds
    // each test's member.
    nodeId = (await seedQ<{ id: string }>(
      "INSERT INTO content_nodes(workspace_id,source_type,node_type,title,slug,markdown) VALUES($1,'manual','content','Shared','shared-'||$2,'team notes') RETURNING id",
      [ws, randomUUID()])).rows[0].id;
  }, 30000);

  afterAll(async () => {
    if (!ws) return;
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [ws]);
    await deleteWorkspaceActors(ws);
    await db.q("DELETE FROM member_removals WHERE workspace_id=$1", [ws]);
  });

  it("a member reads before removal", async () => {
    const { member } = await joinedMember();
    expect((await app.request(`/api/nodes/${nodeId}`, as(member))).status).toBe(200);
  });

  it("only the owner can remove; removal records the identity and ends the member's sessions", async () => {
    const { member, memberActorId } = await joinedMember();
    const denied = await app.request(`/api/actors/${ownerActorId}`, as(member, { method: "DELETE" }));
    expect(denied.status).toBe(403);
    const res = await app.request(`/api/actors/${memberActorId}`, as(owner, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(await actorRows(member.userId)).toEqual([]);
    expect((await db.q("SELECT 1 FROM member_removals WHERE workspace_id=$1 AND external_id=$2", [ws, member.userId])).rows).toHaveLength(1);
    // The member's sessions are gone, so the old cookie names no session.
    expect((await db.q(`SELECT 1 FROM "session" WHERE "userId"=$1`, [member.userId])).rows).toHaveLength(0);
    expect((await app.request(`/api/nodes/${nodeId}`, as(member))).status).toBe(401);
    expect(await actorRows(member.userId)).toEqual([]);
  });

  it("signing in again does not re-create the actor or read anything", async () => {
    const member = await removedMember();
    const fresh = await signIn(member.email, member.password);
    const res = await app.request(`/api/nodes/${nodeId}`, as(fresh));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "membership_removed" });
    const sync = await app.request("/api/sync?since=0", as(fresh));
    expect(sync.status).toBe(401);
    expect(await actorRows(member.userId)).toEqual([]);
    // Anonymous-public paths stay anonymous: no actor is created there either.
    await app.request("/api/site", as(fresh));
    expect(await actorRows(member.userId)).toEqual([]);
  });

  it("someone never removed still bootstraps as a plain member (self-signup floor, not the owner), outside 共用", async () => {
    // Since migration 097 a new member gets only a personal space: the shared
    // note in the default space stays out of reach until the owner adds them.
    expect((await app.request(`/api/nodes/${nodeId}`, as(newcomer))).status).toBe(404);
    expect(await actorRows(newcomer.userId)).toHaveLength(1);
    const newcomerId = (await actorRows(newcomer.userId))[0].id;
    expect((await db.q("SELECT owner_actor_id::text AS o FROM workspaces WHERE id=$1", [ws])).rows[0].o).toBe(ownerActorId);
    expect((await db.q("SELECT 1 FROM space_members m JOIN spaces s ON s.id=m.space_id WHERE m.actor_id=$1 AND s.kind='shared'", [newcomerId])).rows).toEqual([]);
  });

  it("the owner adding the person back lifts the removal", async () => {
    const member = await removedMember();
    const res = await app.request("/api/actors", as(owner, { method: "POST", body: JSON.stringify({ name: "Member", type: "human", external_id: member.userId }) }));
    expect(res.status).toBe(201);
    expect((await db.q("SELECT 1 FROM member_removals WHERE workspace_id=$1 AND external_id=$2", [ws, member.userId])).rows).toHaveLength(0);
    const fresh = await signIn(member.email, member.password);
    // Re-adding restores the membership, not the old space access: the
    // shared note stays hidden until the owner adds them to 共用 again.
    expect((await app.request(`/api/nodes/${nodeId}`, as(fresh))).status).toBe(404);
    const [readded] = await actorRows(member.userId);
    const defaultSpace = (await db.q<{ id: string }>("SELECT id::text FROM spaces WHERE workspace_id=$1 AND is_default", [ws])).rows[0].id;
    const joined = await app.request(`/api/spaces/${defaultSpace}/members/${readded.id}`, as(owner, { method: "PUT", body: JSON.stringify({ permission: "edit" }) }));
    expect(joined.status).toBe(200);
    expect((await app.request(`/api/nodes/${nodeId}`, as(fresh))).status).toBe(200);
    expect(await actorRows(member.userId)).toHaveLength(1);
    expect((await db.q("SELECT permission FROM space_members WHERE space_id=$1 AND actor_id=$2", [defaultSpace, readded.id])).rows).toEqual([{ permission: "edit" }]);
  });
});
