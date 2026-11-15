// The built-in System actor (external_id 'system') is the account the native
// bypass signs in as — a development / test convenience that production forces
// off (nativeBypass.ts). The owner asked for it to be removable there, and for
// it never to hold an owner-level token:
//   - while the bypass is on, removing it is an honest 409, not a fake success;
//   - with the bypass off (the production branch, stubbed here), it is removed
//     like any other member — its tokens and space seats go, the tokens it
//     issued are revoked, ACTOR_DELETED is logged — and the app keeps working;
//   - boot (migrate) does not re-create it where the bypass is off;
//   - no token can be minted or re-scoped for it, and one it already holds is
//     refused at authentication.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const bypass = vi.hoisted(() => ({ on: true }));
vi.mock("../nativeBypass.js", () => ({
  nativeBypassEnabled: () => bypass.on,
  nativeBypassState: () => (bypass.on ? "on" : "off_production"),
}));
// A workspace of the file's own: every test hands its ownership to a fresh
// owner and removes its System actor, which on the shared 'default' workspace
// would leak into every later file. The routes find it through getWorkspaceId.
const own = vi.hoisted(() => ({ ws: "" }));
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => own.ws }));

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, migrate } from "../db.js";
import actorsRouter from "../routes/actors.js";
import spacesRouter from "../routes/spaces.js";
import eventsRouter from "../routes/events.js";
import { createToken, resolveBearerActor } from "../services/agentTokens.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { isWorkspaceOwner } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";
import { nativeOwnerActor, persistActor } from "./helpers/persistActor.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/actors", actorsRouter);
app.route("/api/spaces", spacesRouter);
app.route("/api/events", eventsRouter);

const json = (body: unknown) => ({ body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const systemRows = async (ws: string) =>
  (await q<{ id: string }>(`SELECT id::text FROM actors WHERE workspace_id = $1 AND external_id = 'system'`, [ws])).rows;

describe.skipIf(!isTestDb)("the built-in System actor (DB)", () => {
  let WS = "";
  let owner: ActorCtx;
  let deputy: ActorCtx;
  let system: ActorCtx;
  let bot: ActorCtx;
  let systemHeldToken = "";
  let systemTokenId = "";
  let botTokenId = "";

  beforeAll(async () => {
    WS = own.ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('System actor', $1) RETURNING id::text`,
      [`system-actor-${randomUUID()}`])).rows[0]!.id;
  });

  // Every test starts from the same story, whatever ran before it: the bypass
  // on, System present (re-created if an earlier test removed it), a fresh
  // owner who owns the workspace, a second member (Deputy), and Bot.
  beforeEach(async () => {
    bypass.on = true;
    owner = await persistActor(WS, { id: "", name: "Owner", role: "admin", type: "human" });
    deputy = await persistActor(WS, { id: "", name: "Deputy", role: "editor", type: "human" });
    await setWorkspaceOwner(WS, owner.id); // Deputy is not the owner
    system = await nativeOwnerActor(WS);
    bot = await persistActor(WS, { id: "", name: "Bot", role: "editor", type: "agent" });
    // A token held by System, minted before the rule (straight to the table).
    const held = await createToken(system.id, { allowedTools: null, issuedBy: system.id });
    systemHeldToken = held.plaintext;
    systemTokenId = held.id;
    // A token System issued to another agent (the native app minted it).
    botTokenId = (await createToken(bot.id, { allowedTools: null, issuedBy: system.id })).id;
    // Something System did, so the event feed has a row attributed to it.
    await q(
      `INSERT INTO domain_events (workspace_id, event_type, target_type, target_id, actor_type, actor_id, payload)
       VALUES ($1, 'ACTOR_UPDATED', 'actor', $2, 'ai_agent', $3, '{}'::jsonb)`,
      [WS, bot.id, system.id],
    );
  });

  // What production does: with the bypass off, the owner removes System.
  const removeSystem = async () => {
    bypass.on = false;
    currentActor = owner;
    return app.request(`/api/actors/${system.id}`, { method: "DELETE" });
  };

  it("the roster labels the System row and says the bypass state", async () => {
    currentActor = owner;
    const rows = await (await app.request("/api/actors")).json() as Array<{ id: string; is_system: boolean; native_bypass?: string }>;
    const sys = rows.find((r) => r.id === system.id)!;
    expect(sys.is_system).toBe(true);
    expect(sys.native_bypass).toBe("on");
    const other = rows.find((r) => r.id === bot.id)!;
    expect(other.is_system).toBe(false);
    expect(other.native_bypass).toBeUndefined();
  });

  it("no token can be minted or re-leveled for System (403 system_actor_no_tokens)", async () => {
    currentActor = owner;
    const minted = await app.request(`/api/actors/${system.id}/tokens`, { method: "POST", ...json({ name: "x", access: "write" }) });
    expect(minted.status).toBe(403);
    expect((await minted.json()).error).toBe("system_actor_no_tokens");
    const tokens = async () => (await q(`SELECT 1 FROM agent_tokens WHERE actor_id = $1`, [system.id])).rows.length;
    const before = await tokens();
    const tokenId = systemTokenId;
    const rescoped = await app.request(`/api/actors/${system.id}/tokens/${tokenId}`, { method: "PATCH", ...json({ access: "write" }) });
    expect(rescoped.status).toBe(403);
    expect((await rescoped.json()).error).toBe("system_actor_no_tokens");
    expect(await tokens()).toBe(before);
    expect((await q(`SELECT 1 FROM agent_tokens WHERE id = $1`, [tokenId])).rows.length).toBe(1);
  });

  it("a token System already holds is refused at authentication (row kept)", async () => {
    expect(await resolveBearerActor(systemHeldToken, WS)).toBeNull();
    const tokenId = systemTokenId;
    await expect(resolveCurrentActor({ id: system.id, tokenScope: { tokenId } }, WS)).rejects.toMatchObject({ name: "UnauthorizedError" });
    // System without a token (the native bypass) still resolves.
    expect((await resolveCurrentActor({ id: system.id }, WS)).id).toBe(system.id);
  });

  it("while the bypass is on, removal is refused with 409 system_actor_in_use", async () => {
    currentActor = owner;
    const res = await app.request(`/api/actors/${system.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("system_actor_in_use");
    expect(await systemRows(WS)).toHaveLength(1);
  });

  it("with the bypass off (production), the owner removes System like any member", async () => {
    const res = await removeSystem();
    expect(res.status).toBe(200);
    expect(await systemRows(WS)).toHaveLength(0);
    // Its space seats and the tokens it held went with the row.
    expect((await q(`SELECT 1 FROM space_members WHERE actor_id = $1`, [system.id])).rows).toHaveLength(0);
    expect((await q(`SELECT 1 FROM agent_tokens WHERE actor_id = $1`, [system.id])).rows).toHaveLength(0);
    // The token it issued to Bot is revoked (issuer removed), as for any issuer.
    const botToken = (await q<{ revoked_at: Date | null; issuer_removed_at: Date | null }>(
      `SELECT revoked_at, issuer_removed_at FROM agent_tokens WHERE id = $1`, [botTokenId])).rows[0]!;
    expect(botToken.revoked_at).not.toBeNull();
    expect(botToken.issuer_removed_at).not.toBeNull();
    // Logged, attributed to the owner.
    const ev = (await q<{ actor_id: string }>(
      `SELECT actor_id FROM domain_events WHERE event_type = 'ACTOR_DELETED' AND target_id = $1`, [system.id])).rows;
    expect(ev).toEqual([{ actor_id: owner.id }]);
  });

  it("after the removal the app keeps working: owner checks, spaces, the roster and the event feed", async () => {
    expect((await removeSystem()).status).toBe(200);
    expect(await isWorkspaceOwner(owner)).toBe(true);
    expect(await isWorkspaceOwner(deputy)).toBe(false);
    expect(await isWorkspaceOwner({ ...system })).toBe(false); // a stale context keeps nothing

    currentActor = owner;
    const spaces = await (await app.request("/api/spaces")).json() as { spaces: Array<{ is_default: boolean; permission: string | null }>; is_owner: boolean };
    expect(spaces.is_owner).toBe(true);
    expect(spaces.spaces.some((s) => s.is_default)).toBe(true);

    const roster = await app.request("/api/actors");
    expect(roster.status).toBe(200);
    expect((await roster.json() as Array<{ id: string }>).some((r) => r.id === system.id)).toBe(false);

    const feed = await app.request("/api/events?limit=50");
    expect(feed.status).toBe(200);
    const body = await feed.json() as { events?: Array<{ actor_id: string }> } | Array<{ actor_id: string }>;
    const events = Array.isArray(body) ? body : body.events ?? [];
    // The rows System wrote are still there, attributed to the vanished id.
    expect(events.some((e) => e.actor_id === system.id)).toBe(true);
  });

  // The one test that needs the shared 'default' workspace: boot (migrate)
  // reconciles System only there (slug 'default'), so "boot re-creates it"
  // cannot be shown on a workspace of the file's own. It takes default's System
  // away and the finally block puts it (and default's owner, in case the
  // delete cleared it) back, so a failure here cannot leak to later files.
  it("boot does not re-create System where the bypass is off; it does where it is on", async () => {
    expect((await removeSystem()).status).toBe(200);
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Onden MVP', 'default') ON CONFLICT (slug) DO NOTHING`);
    const { id: DEFAULT, owner_actor_id: defaultOwner } = (await q<{ id: string; owner_actor_id: string | null }>(
      `SELECT id::text, owner_actor_id::text FROM workspaces WHERE slug = 'default'`)).rows[0]!;
    try {
      // Removed the product way on this file's workspace above; on 'default'
      // directly (the removal path is what the tests above cover).
      await q(`DELETE FROM actors WHERE workspace_id = $1 AND external_id = 'system'`, [DEFAULT]);
      await migrate();
      expect(await systemRows(DEFAULT)).toHaveLength(0);
      expect(await systemRows(WS)).toHaveLength(0);
      await migrate({ seedNativeActor: false });
      expect(await systemRows(DEFAULT)).toHaveLength(0);
      expect(await systemRows(WS)).toHaveLength(0);

      bypass.on = true;
      await migrate();
      const [row] = await systemRows(DEFAULT);
      expect(row).toBeDefined();
      // ...and seats it as an editor of the default space again.
      expect((await q(
        `SELECT 1 FROM space_members m JOIN spaces s ON s.id = m.space_id
          WHERE m.actor_id = $1 AND s.is_default AND m.permission = 'edit'`, [row!.id])).rows).toHaveLength(1);
    } finally {
      bypass.on = true;
      await nativeOwnerActor(DEFAULT);
      const stillThere = defaultOwner === null || (await q(`SELECT 1 FROM actors WHERE id = $1`, [defaultOwner])).rows.length > 0;
      if (stillThere) await setWorkspaceOwner(DEFAULT, defaultOwner);
    }
  });
});
