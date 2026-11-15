// Agent tokens are `read` or `write` (roles proposal §3.4, §8.1 items 2, 4, 10):
// the token's access expands to a stored tool list, a token reaches its agent's
// space membership and nothing else, a `write` token still cannot write where
// the agent only views, and the old ways of describing a token (tool lists,
// templates, space lists, a member role) are refused instead of ignored.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import actorsRouter from "../routes/actors.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { createToken } from "../services/agentTokens.js";
import { listTools, registerTool, toolsForAccess } from "../services/agentTools/index.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { removeActor } from "../services/actors.js";
import { assertAuthority } from "../spine/authority.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import type { ActorCtx } from "../types.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();

describe.skipIf(!isTestDatabase())("token access: read / write", () => {
  const stamp = Date.now();
  let WS = "";
  let currentActor: ActorCtx | null = null;
  let owner: ActorCtx, member: ActorCtx, bot: ActorCtx;
  let editSpace = "", viewSpace = "";
  let editNote = "", viewNote = "";

  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
  app.route("/api/actors", actorsRouter);
  const as = (actor: ActorCtx) => { currentActor = actor; };
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const tokenCount = async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM agent_tokens WHERE actor_id = $1`, [bot.id])).rows[0]!.n);
  const mintOk = async (body: unknown) => {
    const res = await call("POST", `/api/actors/${bot.id}/tokens`, body);
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; token: string; access: string; allowed_tools: string[] };
  };
  const mkNote = async (spaceId: string, title: string) => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
     VALUES ($1,'manual','content',$2,$2,'x',$3) RETURNING id::text`, [WS, `${title}-${stamp}`, spaceId])).rows[0]!.id;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    owner = await persistActor(WS, { id: "", name: `ta-owner-${stamp}`, role: "admin", type: "human" });
    member = await persistActor(WS, { id: "", name: `ta-member-${stamp}`, role: "editor", type: "human" });
    bot = await persistActor(WS, { id: "", name: `ta-bot-${stamp}`, role: "editor", type: "agent" });
    await q(`DELETE FROM space_members WHERE actor_id = $1`, [bot.id]);
    editSpace = await makeSpace(WS, `ta-edit-${stamp}`, [{ id: owner.id, permission: "edit" }, { id: bot.id, permission: "edit" }]);
    viewSpace = await makeSpace(WS, `ta-view-${stamp}`, [{ id: owner.id, permission: "edit" }, { id: bot.id, permission: "view" }]);
    editNote = await mkNote(editSpace, "ta-edit-note");
    viewNote = await mkNote(viewSpace, "ta-view-note");
    await setWorkspaceOwner(WS, owner.id);
  });

  it("minting needs an explicit access: read or write", async () => {
    as(owner);
    const before = await tokenCount();
    for (const body of [{}, { access: "admin" }, { access: null }, { name: "no access" }]) {
      const res = await call("POST", `/api/actors/${bot.id}/tokens`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_access");
    }
    expect(await tokenCount()).toBe(before);
  });

  it("access expands to the registry's tool list and stores it (decision 4)", async () => {
    as(owner);
    const read = await mintOk({ access: "read", name: "reader" });
    const write = await mintOk({ access: "write", name: "writer" });
    expect(read.allowed_tools).toEqual(toolsForAccess("read"));
    expect(write.allowed_tools).toEqual(toolsForAccess("write"));
    expect(read.allowed_tools).not.toEqual(write.allowed_tools);
    const rows = (await q<{ id: string; access: string; allowed_tools: string[]; issued_by: string }>(
      `SELECT id::text, access, allowed_tools, issued_by::text FROM agent_tokens WHERE id = ANY($1::uuid[])`, [[read.id, write.id]])).rows;
    expect(rows.find((r) => r.id === read.id)).toMatchObject({ access: "read", allowed_tools: toolsForAccess("read"), issued_by: owner.id });
    expect(rows.find((r) => r.id === write.id)).toMatchObject({ access: "write", allowed_tools: toolsForAccess("write") });
    const events = await q<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM domain_events WHERE workspace_id = $1 AND event_type = 'TOKEN_CREATED' AND target_id = $2`, [WS, write.id]);
    expect(events.rows[0]!.payload).toMatchObject({ actor_id: bot.id, access: "write" });
    expect(JSON.stringify(events.rows[0]!.payload)).not.toContain(write.token); // never the secret
  });

  it("the old ways to describe a token are refused with a pointer, and nothing is minted (§8.1.10)", async () => {
    as(owner);
    const before = await tokenCount();
    const refused: Array<[unknown, string]> = [
      [{ access: "write", allowed_tools: ["createNode"] }, "custom_tools_removed"],
      [{ access: "write", template: "researcher" }, "custom_tools_removed"],
      [{ access: "read", read_space_ids: [editSpace] }, "token_scope_removed"],
      [{ access: "read", write_space_ids: [] }, "token_scope_removed"],
      [{ access: "read", role: "admin" }, "role_removed"],
    ];
    for (const [body, error] of refused) {
      const res = await call("POST", `/api/actors/${bot.id}/tokens`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }
    expect(await tokenCount()).toBe(before);
  });

  it("a member role is refused when adding or renaming a member", async () => {
    as(owner);
    for (const role of ["admin", "reviewer", "editor", "viewer"]) {
      const res = await call("POST", "/api/actors", { name: `ta-new-${role}-${stamp}`, type: "agent", role });
      expect(res.status, role).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("role_removed");
      const patch = await call("PATCH", `/api/actors/${member.id}`, { role });
      expect(patch.status, role).toBe(400);
    }
    const created = await q(`SELECT 1 FROM actors WHERE name LIKE $1`, [`ta-new-%-${stamp}`]);
    expect(created.rows).toHaveLength(0);
    // The roster carries no role.
    const roster = (await (await call("GET", "/api/actors")).json()) as Array<Record<string, unknown>>;
    expect(roster.length).toBeGreaterThan(0);
    for (const row of roster) expect(row).not.toHaveProperty("role");
    expect(roster.find((r) => r.id === owner.id)).toMatchObject({ is_owner: true });
  });

  it("only the owner mints or changes a token", async () => {
    as(member);
    expect((await call("POST", `/api/actors/${bot.id}/tokens`, { access: "write" })).status).toBe(403);
    const t = await createToken(bot.id, { access: "read", allowedTools: toolsForAccess("read") });
    expect((await call("PATCH", `/api/actors/${bot.id}/tokens/${t.id}`, { access: "write" })).status).toBe(403);
    expect((await q<{ access: string }>(`SELECT access FROM agent_tokens WHERE id = $1`, [t.id])).rows[0]!.access).toBe("read");
  });

  it("access can be changed in place without a new secret; the tool list is expanded again", async () => {
    as(owner);
    const t = await mintOk({ access: "write", name: "flip" });
    const res = await call("PATCH", `/api/actors/${bot.id}/tokens/${t.id}`, { access: "read" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: t.id, access: "read", allowed_tools: toolsForAccess("read") });
    const ev = await q<{ payload: { from: string; to: string } }>(
      `SELECT payload FROM domain_events WHERE workspace_id = $1 AND event_type = 'TOKEN_ACCESS_CHANGED' AND target_id = $2`, [WS, t.id]);
    expect(ev.rows.map((r) => [r.payload.from, r.payload.to])).toEqual([["write", "read"]]);
    // Old fields do not sneak in through the same route.
    expect((await call("PATCH", `/api/actors/${bot.id}/tokens/${t.id}`, { allowed_tools: ["createNode"] })).status).toBe(400);
    expect((await call("PATCH", `/api/actors/${bot.id}/tokens/${t.id}`, {})).status).toBe(400);
  });

  it("a token with the legacy 'every tool' list becomes a standard one when its access is set; a revoked token is never revived", async () => {
    as(owner);
    const legacy = await createToken(bot.id, { access: "write", allowedTools: null });
    expect((await q<{ allowed_tools: string[] | null }>(`SELECT allowed_tools FROM agent_tokens WHERE id = $1`, [legacy.id])).rows[0]!.allowed_tools).toBeNull();
    expect((await call("PATCH", `/api/actors/${bot.id}/tokens/${legacy.id}`, { access: "write" })).status).toBe(200);
    expect((await q<{ allowed_tools: string[] | null }>(`SELECT allowed_tools FROM agent_tokens WHERE id = $1`, [legacy.id])).rows[0]!.allowed_tools).toEqual(toolsForAccess("write"));
    await q(`UPDATE agent_tokens SET revoked_at = now() WHERE id = $1`, [legacy.id]);
    expect((await call("PATCH", `/api/actors/${bot.id}/tokens/${legacy.id}`, { access: "read" })).status).toBe(404);
    expect((await q<{ revoked_at: Date | null }>(`SELECT revoked_at FROM agent_tokens WHERE id = $1`, [legacy.id])).rows[0]!.revoked_at).not.toBeNull();
  });

  it("a write token still cannot write where its agent only views (§8.1.4); a read token writes nowhere", async () => {
    const writeTok = await createToken(bot.id, { access: "write", allowedTools: toolsForAccess("write") });
    const readTok = await createToken(bot.id, { access: "read", allowedTools: toolsForAccess("read") });
    const asToken = (id: string) => resolveCurrentActor({ id: bot.id, tokenScope: { tokenId: id } }, WS);
    const w = await asToken(writeTok.id);
    const r = await asToken(readTok.id);
    const may = (actor: ActorCtx, nodeId: string, op: "read" | "write_node") =>
      assertAuthority(actor, { kind: "node", nodeId, op }).then(() => true, () => false);
    expect(w.tokenScope?.access).toBe("write");
    expect(await may(w, editNote, "write_node")).toBe(true);
    expect(await may(w, viewNote, "read")).toBe(true);
    expect(await may(w, viewNote, "write_node")).toBe(false); // the agent's own permission there is view
    expect(await may(r, editNote, "read")).toBe(true);
    expect(await may(r, editNote, "write_node")).toBe(false); // read token: no write anywhere
  });

  it("the issuer no longer bounds a token (§3.4), but removing the issuer still revokes every token they issued", async () => {
    // A view-only issuer with no access to the spaces: the token still has the agent's reach.
    const issuer = await persistActor(WS, { id: "", name: `ta-issuer-${stamp}`, role: "viewer", type: "human" });
    await q(`DELETE FROM space_members WHERE actor_id = $1`, [issuer.id]);
    const issued = await createToken(bot.id, { access: "write", allowedTools: toolsForAccess("write"), issuedBy: issuer.id });
    const actor = await resolveCurrentActor({ id: bot.id, tokenScope: { tokenId: issued.id } }, WS);
    expect(await assertAuthority(actor, { kind: "node", nodeId: editNote, op: "write_node" }).then(() => true, () => false)).toBe(true);
    await removeActor(owner, issuer.id);
    const row = await q<{ revoked_at: Date | null }>(`SELECT revoked_at FROM agent_tokens WHERE id = $1`, [issued.id]);
    expect(row.rows[0]!.revoked_at).not.toBeNull();
    await expect(resolveCurrentActor({ id: bot.id, tokenScope: { tokenId: issued.id } }, WS)).rejects.toThrow();
  });

  it("a tool the registry gains later does not widen an existing token", async () => {
    const t = await createToken(bot.id, { access: "read", allowedTools: toolsForAccess("read") });
    const before = (await resolveCurrentActor({ id: bot.id, tokenScope: { tokenId: t.id } }, WS)).tokenScope!.allowedTools;
    const name = `ta-late-${stamp}`;
    registerTool({ name, access: "read", description: "added after the token", inputSchema: z.object({}), handler: async () => ({ ok: true }) });
    expect(listTools().some((tool) => tool.name === name)).toBe(true);
    expect(toolsForAccess("read")).toContain(name);   // a token minted now would carry it…
    const after = (await resolveCurrentActor({ id: bot.id, tokenScope: { tokenId: t.id } }, WS)).tokenScope!.allowedTools;
    expect(after).toEqual(before);                    // …this one does not
    expect(after).not.toContain(name);
  });
});
