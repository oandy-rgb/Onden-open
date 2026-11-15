// GET /api/spaces/overview (roles proposal §5, §8.1.12): what each member can
// actually do in each shared space and the first thing that stops an agent —
// derived from the gate itself, owner only, never a personal space.
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
import { currentAccessSnapshot } from "./helpers/accessSnapshot.js";
import { explainAccess, type AgentAccessFacts } from "../spine/spaceAccess.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import type { ActorCtx } from "../types.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";

type Reach = { ok: boolean; blocked_by: string | null };
type Member = { actor_id: string; name: string; type: string; permission: string; effective?: { read: Reach; write: Reach } };
type Overview = {
  owner_id: string | null;
  spaces: Array<{ id: string; name: string; kind: string; capabilities: Record<string, boolean>; members: Member[] }>;
  unplaced: Array<{ actor_id: string; name: string; type: string; spaces: number; invite_pending: boolean; blocked_by?: string }>;
  agents: Array<{ actor_id: string; live_tokens: number; write_tokens: number }>;
};

describe.skipIf(!isTestDatabase())("space overview: effective access with reasons", () => {
  const stamp = Date.now();
  let WS = "";
  let currentActor: ActorCtx | null = null;
  let owner: ActorCtx, human: ActorCtx;
  const bots: Record<string, ActorCtx> = {};
  let open = "", closed = "", viewing = "";

  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
  app.route("/api/spaces", spacesRouter);
  const overview = async (): Promise<Overview> => {
    currentActor = owner;
    const res = await app.request("/api/spaces/overview");
    expect(res.status).toBe(200);
    return (await res.json()) as Overview;
  };
  const memberIn = (o: Overview, spaceId: string, actorId: string) =>
    o.spaces.find((s) => s.id === spaceId)!.members.find((m) => m.actor_id === actorId)!;
  const mint = (agent: ActorCtx, access: "read" | "write", extra: { revoked?: boolean; expired?: boolean } = {}) =>
    createToken(agent.id, { access, allowedTools: toolsForAccess(access), expiresAt: extra.expired ? new Date(Date.now() - 60_000) : null })
      .then(async (t) => { if (extra.revoked) await q(`UPDATE agent_tokens SET revoked_at = now() WHERE id = $1`, [t.id]); return t.id; });
  const botNamed = (n: string) => persistActor(WS, { id: "", name: `so-${n}-${stamp}`, role: "editor", type: "agent" })
    .then(async (a) => { await q(`DELETE FROM space_members WHERE actor_id = $1`, [a.id]); bots[n] = a; return a; });

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    owner = await persistActor(WS, { id: "", name: `so-owner-${stamp}`, role: "admin", type: "human" });
    human = await persistActor(WS, { id: "", name: `so-human-${stamp}`, role: "editor", type: "human" });
    await setWorkspaceOwner(WS, owner.id);
    for (const n of ["none", "writer", "reader", "both", "stale", "unplacedNoToken", "unplacedToken"]) await botNamed(n);
    open = await makeSpace(WS, `so-open-${stamp}`, [{ id: owner.id, permission: "edit" }, { id: human.id, permission: "edit" }]);
    closed = await makeSpace(WS, `so-closed-${stamp}`, [{ id: owner.id, permission: "edit" }], { publish: false, external_ai: false, backup: true });
    viewing = await makeSpace(WS, `so-viewing-${stamp}`, [{ id: owner.id, permission: "edit" }]);
    const join = (space: string, a: ActorCtx, permission: "view" | "edit") =>
      q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, $3)`, [space, a.id, permission]);
    // none: member of open and closed, no token at all.
    await join(open, bots.none!, "edit"); await join(closed, bots.none!, "edit");
    // writer: edit in open and closed (AI off), view in viewing; one write token.
    await join(open, bots.writer!, "edit"); await join(closed, bots.writer!, "edit"); await join(viewing, bots.writer!, "view");
    await mint(bots.writer!, "write");
    // reader: edit in open but only a read token.
    await join(open, bots.reader!, "edit");
    await mint(bots.reader!, "read");
    // both: a read token and a write token -> the most permissive wins.
    await join(open, bots.both!, "edit");
    await mint(bots.both!, "read"); await mint(bots.both!, "write");
    // stale: only a revoked and an expired token -> none is live.
    await join(open, bots.stale!, "edit");
    await mint(bots.stale!, "write", { revoked: true }); await mint(bots.stale!, "write", { expired: true });
    // unplacedToken: has a live token but no space; unplacedNoToken: neither.
    await mint(bots.unplacedToken!, "write");
  });

  it("says what each agent can do in each space and why not — the gate's own answer", async () => {
    const o = await overview();
    const reach = (space: string, bot: string) => memberIn(o, space, bots[bot]!.id).effective!;
    // no live token: everything is blocked by that, first.
    expect(reach(open, "none")).toEqual({ read: { ok: false, blocked_by: "no_live_token" }, write: { ok: false, blocked_by: "no_live_token" } });
    expect(reach(closed, "none").read.blocked_by).toBe("no_live_token"); // before the switch
    // writer: ok where AI is on and it edits; the switch stops it where it is off; view stops writing.
    expect(reach(open, "writer")).toEqual({ read: { ok: true, blocked_by: null }, write: { ok: true, blocked_by: null } });
    expect(reach(closed, "writer")).toEqual({ read: { ok: false, blocked_by: "external_ai_off" }, write: { ok: false, blocked_by: "external_ai_off" } });
    expect(reach(viewing, "writer")).toEqual({ read: { ok: true, blocked_by: null }, write: { ok: false, blocked_by: "view_only" } });
    // reader: a read token reads but never writes.
    expect(reach(open, "reader")).toEqual({ read: { ok: true, blocked_by: null }, write: { ok: false, blocked_by: "token_read_only" } });
    // both: the widest token counts.
    expect(reach(open, "both")).toEqual({ read: { ok: true, blocked_by: null }, write: { ok: true, blocked_by: null } });
    // stale: revoked and expired tokens are not tokens.
    expect(reach(open, "stale").read).toEqual({ ok: false, blocked_by: "no_live_token" });
  });

  it("the answer equals what the token can really reach (no second copy of the rule)", async () => {
    const o = await overview();
    for (const bot of ["writer", "reader", "both"]) {
      const tokenId = (await q<{ id: string }>(
        `SELECT id::text FROM agent_tokens WHERE actor_id = $1 AND revoked_at IS NULL ORDER BY (access = 'write') DESC LIMIT 1`, [bots[bot]!.id])).rows[0]!.id;
      const real = await currentAccessSnapshot(WS, { actorId: bots[bot]!.id, tokenId });
      for (const space of o.spaces) {
        const m = space.members.find((x) => x.actor_id === bots[bot]!.id);
        if (!m) continue;
        expect(m.effective!.read.ok, `${bot} read ${space.name}`).toBe(real.read.includes(space.id));
        expect(m.effective!.write.ok, `${bot} write ${space.name}`).toBe(real.write.includes(space.id));
        expect(m.effective!.read.ok).toBe(m.effective!.read.blocked_by === null);
        expect(m.effective!.write.ok).toBe(m.effective!.write.blocked_by === null);
      }
    }
  });

  it("lists members who are in no shared space, and the reason for an agent", async () => {
    const o = await overview();
    const row = (b: string) => o.unplaced.find((u) => u.actor_id === bots[b]!.id);
    expect(row("unplacedNoToken")).toMatchObject({ type: "agent", spaces: 0, blocked_by: "no_live_token" });
    expect(row("unplacedToken")).toMatchObject({ type: "agent", spaces: 0, blocked_by: "not_member" });
    expect(o.unplaced.find((u) => u.actor_id === bots.writer!.id)).toBeUndefined();
    expect(o.agents.find((a) => a.actor_id === bots.both!.id)).toEqual({ actor_id: bots.both!.id, live_tokens: 2, write_tokens: 1 });
    expect(o.agents.find((a) => a.actor_id === bots.stale!.id)).toEqual({ actor_id: bots.stale!.id, live_tokens: 0, write_tokens: 0 });
  });

  it("carries permissions and switches, but no effective block for people", async () => {
    const o = await overview();
    expect(o.owner_id).toBe(owner.id);
    expect(memberIn(o, open, human.id)).toMatchObject({ type: "human", permission: "edit" });
    expect(memberIn(o, open, human.id).effective).toBeUndefined();
    expect(o.spaces.find((s) => s.id === closed)!.capabilities.external_ai).toBe(false);
  });

  it("never shows a personal space, its name or its members (§8.1.12)", async () => {
    const o = await overview();
    const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE kind = 'personal' AND workspace_id = $1`, [WS])).rows.map((r) => r.id);
    expect(personal.length).toBeGreaterThan(0);
    for (const s of o.spaces) { expect(s.kind).toBe("shared"); expect(personal).not.toContain(s.id); }
    expect(JSON.stringify(o)).not.toMatch(/"kind":"personal"/);
  });

  it("is the owner's: a member and a token get 403", async () => {
    currentActor = human;
    expect((await app.request("/api/spaces/overview")).status).toBe(403);
    const t = await createToken(bots.writer!.id, { access: "write", allowedTools: toolsForAccess("write") });
    currentActor = await resolveCurrentActor({ id: bots.writer!.id, tokenScope: { tokenId: t.id } }, WS);
    expect((await app.request("/api/spaces/overview")).status).toBe(403);
  });

  it("explainAccess keeps the proposal's order and never explains a yes", () => {
    const facts = (over: Partial<AgentAccessFacts>): AgentAccessFacts => ({ liveTokens: 1, writeTokens: 1, externalAi: true, permission: "edit", ...over });
    // Every combination: a reason appears exactly where the gate says no.
    for (const liveTokens of [0, 1]) for (const writeTokens of [0, 1]) for (const externalAi of [true, false]) for (const permission of [null, "view", "edit"] as const) {
      const f = facts({ liveTokens, writeTokens: liveTokens ? writeTokens : 0, externalAi, permission });
      const read = liveTokens > 0 && permission !== null && externalAi;
      const write = read && permission === "edit" && f.writeTokens > 0;
      const why = explainAccess(f, { read, write });
      expect(why.readBlockedBy === null, JSON.stringify(f)).toBe(read);
      expect(why.writeBlockedBy === null, JSON.stringify(f)).toBe(write);
    }
    // The order: token, then membership, then the switch, then permission, then token access.
    expect(explainAccess(facts({ liveTokens: 0, externalAi: false, permission: null }), { read: false, write: false }))
      .toEqual({ readBlockedBy: "no_live_token", writeBlockedBy: "no_live_token" });
    expect(explainAccess(facts({ externalAi: false, permission: null }), { read: false, write: false }).readBlockedBy).toBe("not_member");
    expect(explainAccess(facts({ externalAi: false, permission: "view" }), { read: false, write: false }).readBlockedBy).toBe("external_ai_off");
    expect(explainAccess(facts({ permission: "view", writeTokens: 0 }), { read: true, write: false }).writeBlockedBy).toBe("view_only");
    expect(explainAccess(facts({ writeTokens: 0 }), { read: true, write: false }).writeBlockedBy).toBe("token_read_only");
  });
});
