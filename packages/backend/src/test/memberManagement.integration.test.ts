// Who may manage spaces and members after the owner/member change (roles proposal
// §8.1 items 6–8, decisions 2–3): only the workspace owner creates shared spaces
// and manages their members and switches; a member — however much they edit — does
// not; a person manages their own personal space; the owner never does for
// someone else's. Every refusal is the server's, not a hidden button.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import spacesRouter from "../routes/spaces.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { createToken } from "../services/agentTokens.js";
import { toolsForAccess } from "../services/agentTools/index.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { purgeSpaceDeleted } from "../services/nodeTrash.js";
import { AuthorityError } from "../spine/mutate.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import type { ActorCtx } from "../types.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";

describe.skipIf(!isTestDatabase())("member management is the owner's", () => {
  const stamp = Date.now();
  let WS = "";
  let currentActor: ActorCtx | null = null;
  let owner: ActorCtx, editor: ActorCtx, viewer: ActorCtx, newcomer: ActorCtx, bot: ActorCtx;
  let team = "";

  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
  app.route("/api/spaces", spacesRouter);
  const as = (actor: ActorCtx) => { currentActor = actor; };
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const permissionOf = async (spaceId: string, actorId: string) =>
    (await q<{ permission: string }>(`SELECT permission FROM space_members WHERE space_id = $1 AND actor_id = $2`, [spaceId, actorId])).rows[0]?.permission ?? null;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    owner = await persistActor(WS, { id: "", name: `mm-owner-${stamp}`, role: "admin", type: "human" });
    editor = await persistActor(WS, { id: "", name: `mm-editor-${stamp}`, role: "editor", type: "human" });
    viewer = await persistActor(WS, { id: "", name: `mm-viewer-${stamp}`, role: "viewer", type: "human" });
    newcomer = await persistActor(WS, { id: "", name: `mm-new-${stamp}`, role: "editor", type: "human" });
    bot = await persistActor(WS, { id: "", name: `mm-bot-${stamp}`, role: "editor", type: "agent" });
    team = await makeSpace(WS, `mm-team-${stamp}`, [
      { id: owner.id, permission: "edit" }, { id: editor.id, permission: "edit" }, { id: viewer.id, permission: "view" }]);
  });

  it("the owner creates a shared space and starts in it as an editing member (decision 8: the owner reads a space only as a member)", async () => {
    as(owner);
    const res = await call("POST", "/api/spaces", { name: `mm-created-${stamp}` });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(await permissionOf(id, owner.id)).toBe("edit");
    expect(await permissionOf(id, editor.id)).toBeNull();
  });

  it("a member cannot create a shared space, however much they edit (decision 2)", async () => {
    for (const actor of [editor, viewer]) {
      as(actor);
      expect((await call("POST", "/api/spaces", { name: `mm-nope-${stamp}` })).status).toBe(403);
    }
    const spaces = await q(`SELECT 1 FROM spaces WHERE name = $1`, [`mm-nope-${stamp}`]);
    expect(spaces.rows).toHaveLength(0);
  });

  it("a delegated token cannot create a space either", async () => {
    await setWorkspaceOwner(WS, owner.id);
    const issued = await createToken(bot.id, { access: "write", allowedTools: toolsForAccess("write") });
    as(await resolveCurrentActor({ id: bot.id, tokenScope: { tokenId: issued.id } }, WS));
    expect((await call("POST", "/api/spaces", { name: `mm-bot-${stamp}` })).status).toBe(403);
  });

  it("an editing member cannot add, change or remove members (decision 3: the old manager is just an editor now)", async () => {
    as(editor);
    const newcomerBefore = await permissionOf(team, newcomer.id);
    expect((await call("PUT", `/api/spaces/${team}/members/${newcomer.id}`, { permission: "edit" })).status).toBe(403);
    expect((await call("PUT", `/api/spaces/${team}/members/${viewer.id}`, { permission: "edit" })).status).toBe(403);
    expect((await call("DELETE", `/api/spaces/${team}/members/${viewer.id}`)).status).toBe(403);
    expect(await permissionOf(team, newcomer.id)).toBe(newcomerBefore);
    expect(await permissionOf(team, viewer.id)).toBe("view");
    expect((await call("GET", `/api/spaces/${team}/candidates`)).status).toBe(403);
  });

  it("an editing member cannot change the space's name or switches, nor delete it", async () => {
    as(editor);
    expect((await call("PATCH", `/api/spaces/${team}`, { name: "renamed by an editor" })).status).toBe(403);
    expect((await call("PATCH", `/api/spaces/${team}`, { capabilities: { external_ai: true } })).status).toBe(403);
    expect((await call("GET", `/api/spaces/${team}/delete-preview`)).status).toBe(403);
    expect((await call("DELETE", `/api/spaces/${team}`)).status).toBe(403);
    const row = await q<{ name: string; capabilities: Record<string, boolean> }>(`SELECT name, capabilities FROM spaces WHERE id = $1`, [team]);
    expect(row.rows[0]!.name).toBe(`mm-team-${stamp}`);
    expect(row.rows[0]!.capabilities.external_ai).toBe(true); // makeSpace's default; unchanged
  });

  it("an editing member cannot permanently delete a space's trash", async () => {
    await expect(withEventTransaction(WS, async () => purgeSpaceDeleted(await resolveCurrentActor(editor, WS), WS, team)))
      .rejects.toBeInstanceOf(AuthorityError);
  });

  it("the owner manages the space they are not even a member of", async () => {
    const elsewhere = await makeSpace(WS, `mm-elsewhere-${stamp}`, [{ id: editor.id, permission: "edit" }]);
    as(owner);
    expect((await call("PUT", `/api/spaces/${elsewhere}/members/${newcomer.id}`, {})).status).toBe(200);
    expect(await permissionOf(elsewhere, newcomer.id)).toBe("view"); // decision 6: a member joins as view
    expect((await call("PUT", `/api/spaces/${elsewhere}/members/${newcomer.id}`, { permission: "edit" })).status).toBe(200);
    expect(await permissionOf(elsewhere, newcomer.id)).toBe("edit");
    expect((await call("PATCH", `/api/spaces/${elsewhere}`, { capabilities: { external_ai: false } })).status).toBe(200);
    expect((await call("DELETE", `/api/spaces/${elsewhere}/members/${newcomer.id}`)).status).toBe(200);
    expect(await permissionOf(elsewhere, newcomer.id)).toBeNull();
    // Being manager does not make it readable: the owner is not in it.
    const readable = await q(`SELECT 1 FROM space_members WHERE space_id = $1 AND actor_id = $2`, [elsewhere, owner.id]);
    expect(readable.rows).toHaveLength(0);
  });

  it("the member's permission is view or edit and nothing else; no role field", async () => {
    as(owner);
    const before = await permissionOf(team, newcomer.id);
    expect((await call("PUT", `/api/spaces/${team}/members/${newcomer.id}`, { permission: "manager" })).status).toBe(400);
    expect((await call("PUT", `/api/spaces/${team}/members/${newcomer.id}`, { role: "editor" })).status).toBe(400);
    expect(await permissionOf(team, newcomer.id)).toBe(before);
  });

  it("recording a change names the previous permission", async () => {
    as(owner);
    await call("PUT", `/api/spaces/${team}/members/${newcomer.id}`, { permission: "view" });
    await call("PUT", `/api/spaces/${team}/members/${newcomer.id}`, { permission: "edit" });
    const events = await q<{ payload: { actor_id: string; permission: string | null; previous_permission: string | null } }>(
      `SELECT payload FROM domain_events WHERE workspace_id = $1 AND event_type = 'SPACE_MEMBER_SET' AND target_id = $2 ORDER BY id`, [WS, team]);
    const mine = events.rows.map((r) => r.payload).filter((p) => p.actor_id === newcomer.id);
    expect(mine.map((p) => [p.previous_permission, p.permission])).toEqual([[null, "view"], ["view", "edit"]]);
    expect(JSON.stringify(mine)).not.toContain("role");
  });

  it("a person manages their own personal space's switches; the owner cannot touch someone else's", async () => {
    const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [editor.id])).rows[0]!.id;
    as(editor);
    expect((await call("PATCH", `/api/spaces/${personal}`, { capabilities: { backup: false } })).status).toBe(200);
    as(owner);
    expect((await call("PATCH", `/api/spaces/${personal}`, { capabilities: { backup: true } })).status).toBe(404);
    expect((await call("PUT", `/api/spaces/${personal}/members/${newcomer.id}`, { permission: "view" })).status).toBe(409);
    const caps = await q<{ capabilities: Record<string, boolean> }>(`SELECT capabilities FROM spaces WHERE id = $1`, [personal]);
    expect(caps.rows[0]!.capabilities.backup).toBe(false);
  });
});
