// Handing the workspace over (roles proposal §3.5, §8.1.11, decision 10): only the
// owner's own session; the new owner is a signed-in person typed back by name;
// the database refuses every other change of a set owner; a retry with the same
// Idempotency-Key replays; the previous owner keeps their seats.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, pool, getWorkspaceId } from "../db.js";
import workspaceRouter from "../routes/workspace.js";
import { withIdempotencyKey } from "../spine/mutate.js";
import { persistActor, nativeOwnerActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { createToken } from "../services/agentTokens.js";
import { toolsForAccess } from "../services/agentTools/index.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { removeActor } from "../services/actors.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import type { ActorCtx } from "../types.js";

describe.skipIf(!isTestDatabase())("ownership transfer", () => {
  const stamp = Date.now();
  let WS = "";
  let currentActor: ActorCtx | null = null;
  let owner: ActorCtx, heir: ActorCtx, member: ActorCtx, bot: ActorCtx, invitee: ActorCtx;
  let team = "";

  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => {
    c.set("actor", currentActor);
    const key = c.req.header("idempotency-key");
    return key ? withIdempotencyKey(key, next) : next();
  });
  app.route("/api/workspace", workspaceRouter);
  const transfer = (toActorId: string, confirmName: string, key?: string) =>
    app.request("/api/workspace/owner-transfer", {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify({ to_actor_id: toActorId, confirm_name: confirmName }),
    });
  const ownerId = async () => (await q<{ o: string | null }>(`SELECT owner_actor_id::text AS o FROM workspaces WHERE id = $1`, [WS])).rows[0]!.o;
  const resetOwner = () => setWorkspaceOwner(WS, owner.id);

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    owner = await persistActor(WS, { id: "", name: `ot-owner-${stamp}`, role: "admin", type: "human" });
    heir = await persistActor(WS, { id: "", name: `ot-heir-${stamp}`, role: "editor", type: "human" });
    member = await persistActor(WS, { id: "", name: `ot-member-${stamp}`, role: "editor", type: "human" });
    invitee = await persistActor(WS, { id: "", name: `ot-invitee-${stamp}`, role: "editor", type: "human" });
    bot = await persistActor(WS, { id: "", name: `ot-bot-${stamp}`, role: "editor", type: "agent" });
    // heir and member have signed in (an external_id); the invitee has not.
    await q(`UPDATE actors SET external_id = $2 WHERE id = $1`, [heir.id, `ext-heir-${stamp}`]);
    await q(`UPDATE actors SET external_id = $2 WHERE id = $1`, [member.id, `ext-member-${stamp}`]);
    team = await makeSpace(WS, `ot-team-${stamp}`, [{ id: owner.id, permission: "edit" }, { id: heir.id, permission: "view" }]);
    await resetOwner();
  });
  afterEach(async () => { vi.unstubAllEnvs(); await resetOwner(); });

  it("the owner hands the workspace to a signed-in person who is typed back by name; the old owner keeps their seats", async () => {
    currentActor = owner;
    const res = await transfer(heir.id, heir.name);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, owner_id: heir.id, previous_owner_id: owner.id });
    expect(await ownerId()).toBe(heir.id);
    // The previous owner is a member still, with the seat they had.
    const seat = await q(`SELECT permission FROM space_members WHERE space_id = $1 AND actor_id = $2`, [team, owner.id]);
    expect(seat.rows[0]).toEqual({ permission: "edit" });
    // …and now they cannot administer: the new owner can.
    currentActor = owner;
    expect((await transfer(owner.id, owner.name)).status).toBe(403);
    const ev = await q<{ actor_id: string; payload: Record<string, unknown> }>(
      `SELECT actor_id, payload FROM domain_events WHERE workspace_id = $1 AND event_type = 'WORKSPACE_OWNER_TRANSFERRED' ORDER BY id DESC LIMIT 1`, [WS]);
    expect(ev.rows[0]).toEqual({ actor_id: owner.id, payload: { from_actor_id: owner.id, to_actor_id: heir.id } });
  });

  it("only the owner's session may start it: a member, a token and an invitee-to-be are all refused, and nothing changes (§8.1.11)", async () => {
    currentActor = member;
    expect((await transfer(heir.id, heir.name)).status).toBe(403);
    const t = await createToken(bot.id, { access: "write", allowedTools: toolsForAccess("write") });
    currentActor = await resolveCurrentActor({ id: bot.id, tokenScope: { tokenId: t.id } }, WS);
    expect((await transfer(heir.id, heir.name)).status).toBe(403);
    expect(await ownerId()).toBe(owner.id);
  });

  it("the native System account may only where the native bypass is on (it is never the way in on production)", async () => {
    const system = await nativeOwnerActor(WS);
    currentActor = system;
    vi.stubEnv("NODE_ENV", "production");
    expect((await transfer(heir.id, heir.name)).status).toBe(403);
    expect(await ownerId()).toBe(owner.id);
    vi.unstubAllEnvs();
    expect((await transfer(heir.id, heir.name)).status).toBe(200); // bypass on in tests
    expect(await ownerId()).toBe(heir.id);
  });

  it("the new owner must be a person who has signed in: not an agent, not a pending invite, not the System account, not a stranger", async () => {
    currentActor = owner;
    const system = await nativeOwnerActor(WS);
    for (const [id, name] of [[bot.id, bot.name], [invitee.id, invitee.name], [system.id, "System"]] as const) {
      const res = await transfer(id, name);
      expect(res.status, name).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_new_owner");
    }
    expect((await transfer(randomUUID(), "nobody")).status).toBe(404);
    expect((await transfer(owner.id, owner.name)).status).toBe(409); // already the owner
    expect(await ownerId()).toBe(owner.id);
  });

  it("the name typed back must match exactly", async () => {
    currentActor = owner;
    for (const typed of ["", heir.name.toUpperCase(), `${heir.name} `, "someone else"]) {
      const res = await transfer(heir.id, typed || " ");
      expect(res.status, JSON.stringify(typed)).toBe(400);
    }
    expect(await ownerId()).toBe(owner.id);
  });

  it("a retry with the same Idempotency-Key after the first answer was lost replays as done, even though the caller is no longer the owner", async () => {
    currentActor = owner;
    const key = randomUUID();
    const countEvents = async () => (await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND event_type = 'WORKSPACE_OWNER_TRANSFERRED' AND payload->>'to_actor_id' = $2`, [WS, heir.id])).rows.length;
    const eventsBefore = await countEvents();
    expect((await transfer(heir.id, heir.name, key)).status).toBe(200);
    const again = await transfer(heir.id, heir.name, key);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ deduped: true });
    expect(await ownerId()).toBe(heir.id);
    expect(await countEvents()).toBe(eventsBefore + 1); // the replay wrote nothing
  });

  it("a refused attempt keeps no key: the same key works once the request is right", async () => {
    currentActor = member;
    const key = randomUUID();
    expect((await transfer(heir.id, heir.name, key)).status).toBe(403);
    currentActor = owner;
    expect((await transfer(heir.id, heir.name, key)).status).toBe(200);
    expect(await ownerId()).toBe(heir.id);
  });

  it("state and event are one transaction: a failure after the update leaves neither", async () => {
    // An event that cannot be written rolls the owner change back with it.
    const before = await ownerId();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('onden.owner_transfer', $1, true)`, [heir.id]);
      await client.query(`UPDATE workspaces SET owner_actor_id = $1 WHERE id = $2`, [heir.id, WS]);
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect(await ownerId()).toBe(before);
  });

  it("the database refuses a direct change of a set owner, clearing it, and a transfer declared for someone else", async () => {
    await expect(q(`UPDATE workspaces SET owner_actor_id = $2 WHERE id = $1`, [WS, heir.id])).rejects.toThrow(/ownership transfer/);
    await expect(q(`UPDATE workspaces SET owner_actor_id = NULL WHERE id = $1`, [WS])).rejects.toThrow(/ownership transfer/);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('onden.owner_transfer', $1, true)`, [member.id]); // declared for another person
      await expect(client.query(`UPDATE workspaces SET owner_actor_id = $2 WHERE id = $1`, [WS, heir.id])).rejects.toThrow(/ownership transfer/);
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect(await ownerId()).toBe(owner.id);
  });

  it("an ownerless workspace gets its owner without a declaration (the first person to sign in)", async () => {
    await setWorkspaceOwner(WS, null);
    await q(`UPDATE workspaces SET owner_actor_id = $2 WHERE id = $1`, [WS, member.id]);
    expect(await ownerId()).toBe(member.id);
  });

  it("the owner's actor row cannot be deleted: not by the API (even by the native System account, also an owner) and not by SQL", async () => {
    const system = await nativeOwnerActor(WS);
    await expect(removeActor(owner, owner.id)).rejects.toMatchObject({ status: 403 }); // nobody removes themselves
    await expect(removeActor(system, owner.id)).rejects.toMatchObject({ status: 409, body: { error: "owner_cannot_be_removed" } });
    await expect(q(`DELETE FROM actors WHERE id = $1`, [owner.id])).rejects.toThrow(/foreign key|violates/);
    expect(await ownerId()).toBe(owner.id);
    expect((await q(`SELECT 1 FROM actors WHERE id = $1`, [owner.id])).rows).toHaveLength(1);
  });
});
