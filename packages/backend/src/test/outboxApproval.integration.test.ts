// D7 approve-before-apply (held outbox effects) against a real Postgres.
// A delegated agent's tag-pack proposal (proposeTagPack, the one held effect
// today) sits as status='pending_approval' — the reconciler never picks it
// up, nothing is installed — until a human principal decides in the inbox:
//
//   - proposeTagPack files the held request (no tag exists yet);
//   - the reconciler's pending-drain skips it;
//   - GET /api/inbox/approvals surfaces it;
//   - a delegated token cannot decide; a reviewer-role human cannot approve,
//     nor can an admin who is not the workspace owner (owner tier: the
//     request is not even listed to them); the owner can;
//   - approve → 'pending', and performing it installs the pack attributed
//     to the REQUESTING agent;
//   - reject → 'dead', and the request never runs;
//   - duplicate requests collapse into one decision.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import { callTool } from "../services/agentTools/index.js";
import { drainOutbox } from "../services/outbox.js";
import inboxRouter from "../routes/inbox.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

// A workspace of its own: the approval queue lists the workspace's requests,
// so the shared default workspace's other held rows must not be in play —
// and this file must not delete them. The routes read it via getWorkspaceId.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

registerShippedModules();

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/inbox", inboxRouter);

const owner: ActorCtx = { id: "owner", name: "Owner", role: "admin", type: "human" };
const reviewer: ActorCtx = { id: "rev", name: "Reviewer", role: "reviewer", type: "human" };
const deputy: ActorCtx = { id: "deputy", name: "Deputy", role: "admin", type: "human" };
const agent: ActorCtx = {
  id: "pack-agent", name: "Pack Bot", role: "editor", type: "agent",
  tokenScope: { tokenId: "t-pack", allowedTools: ["proposeTagPack"], access: "write", writeMode: "apply", expiresAt: null },
};

const post = (path: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

describe.skipIf(!isTestDb)("D7 approve-before-apply: held tag-pack proposals (DB)", () => {
  let seq = 0;
  const packName = () => `d7pack-${randomUUID().slice(0, 8)}-${++seq}`;
  const propose = (name: string, description = "a pack") =>
    callTool("proposeTagPack", { name, description, fields: [{ name: "due", type: "date" }] }, { actor: agent, workspaceId: WS }) as Promise<{ status: string }>;
  const heldRow = async (name: string) =>
    (await q<{ id: string; status: string; payload: { pack?: { description?: string } } }>(
      `SELECT id::text, status, payload FROM outbox
        WHERE workspace_id = $1 AND effect_kind = 'tag_pack' AND payload->'pack'->>'name' = $2
        ORDER BY outbox.id DESC LIMIT 1`,
      [WS, name],
    )).rows[0];
  const installedTag = async (name: string) =>
    (await q(`SELECT 1 FROM content_nodes WHERE workspace_id=$1 AND title=$2 AND node_type='class_tag' AND deleted_at IS NULL`, [WS, name])).rows.length;

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Held publish', $1) RETURNING id::text`, [`d7-${randomUUID()}`])).rows[0]!.id;
    await setModulesOn(WS, null);
    // Another admin first: the last human admin persisted is the owner.
    Object.assign(deputy, await persistActor(WS, deputy));
    Object.assign(owner, await persistActor(WS, owner));
    Object.assign(reviewer, await persistActor(WS, reviewer));
    Object.assign(agent, await persistActor(WS, agent));
  });

  it("proposeTagPack files a HELD request — nothing installed, reconciler skips it", async () => {
    const name = packName();
    const res = await propose(name);
    expect(res.status).toBe("pending_approval");

    const row = await heldRow(name);
    expect(row?.status).toBe("pending_approval");

    // The pending-drain must not touch it.
    const seen: string[] = [];
    await drainOutbox({ workspaceId: WS, perform: async (kind) => { seen.push(kind); } });
    expect(seen).not.toContain("tag_pack");
    expect((await heldRow(name))?.status).toBe("pending_approval");

    // And crucially: nothing was installed before approval.
    expect(await installedTag(name)).toBe(0);
  });

  it("duplicate agent requests collapse into ONE pending decision", async () => {
    const name = packName();
    await propose(name, "v1");
    await propose(name, "v2-latest");
    const rows = await q(`SELECT id FROM outbox WHERE workspace_id=$1 AND effect_kind='tag_pack' AND status='pending_approval' AND payload->'pack'->>'name'=$2`, [WS, name]);
    expect(rows.rows.length).toBe(1);
    expect((await heldRow(name))?.payload.pack?.description).toBe("v2-latest"); // newest request wins
  });

  it("the approval queue surfaces it; deciding is principal-gated and risk-tiered", async () => {
    const name = packName();
    await propose(name);
    const row = await heldRow(name);

    currentActor = owner;
    const list = await (await app.request("/api/inbox/approvals")).json();
    expect((list.approvals as Array<{ id: string }>).some((a) => a.id === row!.id)).toBe(true);

    // Held payloads are only listed to people who can decide on them: an
    // editor, a viewer and the agent itself see an empty queue.
    for (const who of [{ ...owner, id: "ed", role: "editor" }, { ...owner, id: "vw", role: "viewer" }, agent]) {
      currentActor = who;
      const res = await app.request("/api/inbox/approvals");
      expect(res.status).toBe(200);
      expect((await res.json()).approvals).toEqual([]);
    }

    // A delegated token must not review at all.
    currentActor = agent;
    expect((await post(`/api/inbox/approvals/${row!.id}/approve`)).status).toBe(403);
    // A reviewer-role human can review edits, but an approval is the owner's.
    currentActor = reviewer;
    expect((await post(`/api/inbox/approvals/${row!.id}/approve`)).status).toBe(403);
    // So is it for an admin who is not the owner: not listed, not approvable.
    currentActor = deputy;
    expect(((await (await app.request("/api/inbox/approvals")).json()).approvals as Array<{ id: string }>)
      .some((a) => a.id === row!.id)).toBe(false);
    expect((await post(`/api/inbox/approvals/${row!.id}/approve`)).status).toBe(403);
    expect((await post(`/api/inbox/approvals/${row!.id}/reject`)).status).toBe(403);
    expect((await heldRow(name))?.status).toBe("pending_approval"); // still held
  });

  it("approve → pending → performing installs the pack attributed to the agent", async () => {
    const name = packName();
    await propose(name);
    const row = await heldRow(name);

    currentActor = owner;
    const res = await post(`/api/inbox/approvals/${row!.id}/approve`);
    expect(res.status).toBe(200);

    // The decision is an attributed audit event.
    const decided = await q<{ actor_id: string }>(
      `SELECT actor_id FROM domain_events WHERE event_type='EFFECT_APPROVED' AND target_id=$1`, [row!.id]);
    expect(decided.rows[0]?.actor_id).toBe(owner.id);

    // The route kicks an id-scoped real drain (fire-and-forget). Drive the row
    // to terminal deterministically: keep polling, re-draining while it sits
    // 'pending' — the module-level `draining` guard may no-op our call while
    // the route's own drain is still in flight, so never give up after one try.
    let status = "";
    for (let i = 0; i < 50 && status !== "done"; i++) {
      status = (await q<{ status: string }>(`SELECT status FROM outbox WHERE id=$1::bigint`, [row!.id])).rows[0]!.status;
      if (status === "pending") await drainOutbox({ id: row!.id });
      if (status !== "done") await new Promise((r) => setTimeout(r, 100));
    }
    status = (await q<{ status: string }>(`SELECT status FROM outbox WHERE id=$1::bigint`, [row!.id])).rows[0]!.status;
    expect(status).toBe("done");

    // Performing it installed the pack ATTRIBUTED TO THE AGENT, via approval.
    expect(await installedTag(name)).toBe(1);
    const ev = await q<{ actor_type: string; actor_id: string; payload: { via_approval?: boolean } }>(
      `SELECT actor_type, actor_id, payload FROM domain_events
        WHERE workspace_id=$1 AND event_type='TAG_IMPORTED' AND payload->>'name'=$2
        ORDER BY id DESC LIMIT 1`, [WS, name]);
    expect(ev.rows[0]?.actor_type).toBe("ai_agent");
    expect(ev.rows[0]?.actor_id).toBe(agent.id);
    expect(ev.rows[0]?.payload.via_approval).toBe(true);
  });

  it("reject → dead; the request never runs and re-deciding 409s", async () => {
    const name = packName();
    await propose(name);
    const row = await heldRow(name);

    currentActor = owner;
    expect((await post(`/api/inbox/approvals/${row!.id}/reject`)).status).toBe(200);
    expect((await heldRow(name))?.status).toBe("dead");
    expect(await installedTag(name)).toBe(0);
    const rejected = await q(`SELECT 1 FROM domain_events WHERE event_type='EFFECT_REJECTED' AND target_id=$1`, [row!.id]);
    expect(rejected.rows.length).toBe(1);

    expect((await post(`/api/inbox/approvals/${row!.id}/approve`)).status).toBe(404); // no longer awaiting
  });
});
