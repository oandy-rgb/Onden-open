// Outbox delivery guarantees (W27) against a real Postgres:
//   - a stuck effect times out and the next row still runs;
//   - a row survives a day of failures, not four minutes (10 failures in a row
//     leave it pending; only the default 35th buries it);
//   - the owner lists dead deliveries and requeues one, or settles it when a
//     newer pending row of the same key already carries the intent; a
//     reviewer's rejection is a decision, never listed or requeued;
//   - approving a held intent whose key already has a pending row folds into
//     that row (200) instead of a unique-index 500.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
// The file's own workspace (the routes resolve it through getWorkspaceId), so
// the per-test outbox reset below touches no one else's rows.
const context = vi.hoisted(() => ({ workspaceId: "", drains: new Set<Promise<void>>() }));
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => context.workspaceId }));
// The inbox routes fire `void drainOutbox(...)` in the background. Every call
// through the module's export (the routes' and this file's) is tracked until
// it settles, so a test can wait for a background pass before its own
// drainOutbox call, which would otherwise be a silent no-op behind the
// in-process guard. All of them, not just the latest: a call made while
// another pass runs returns at once, and remembering only that one let the
// running pass leak into the next test (seed 111).
vi.mock("../services/outbox.js", async (original) => {
  const mod = await original<typeof import("../services/outbox.js")>();
  return {
    ...mod,
    drainOutbox: (opts?: Parameters<typeof mod.drainOutbox>[0]) => {
      const pass = mod.drainOutbox(opts);
      const settled = pass.then(() => {}, () => {});
      context.drains.add(settled);
      void settled.then(() => context.drains.delete(settled));
      return pass;
    },
  };
});
/** Wait until no drain started through the module's export is still running. */
async function settleDrains(): Promise<void> {
  while (context.drains.size > 0) await Promise.all([...context.drains]);
}
import { q } from "../db.js";
import { _abandonedSettledForTests, drainOutbox, enqueueEffect, registerOutboxEffect, RETRY_DAY_ATTEMPTS } from "../services/outbox.js";
import inboxRouter from "../routes/inbox.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// A held kind the owner may approve; performing it does nothing.
const KIND = "w27_probe";
registerOutboxEffect({ kind: KIND, parse: (p) => p, perform: async () => {} });

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/inbox", inboxRouter);
const post = (path: string) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

const owner: ActorCtx = { id: "w27-owner", name: "Owner", role: "admin", type: "human" };
const reviewer: ActorCtx = { id: "w27-rev", name: "Reviewer", role: "reviewer", type: "human" };

describe.skipIf(!isTestDb)("outbox delivery guarantees (DB)", () => {
  let WS = "";
  // The unique index on pending dedup keys spans workspaces, and a kept test database
  // still holds the pending rows earlier runs left (their next attempt is an hour away).
  const k = (name: string) => `w27:${WS}:${name}`;
  const row = async (id: string) => (await q<{ status: string; attempts: number; last_error: string | null; payload: Record<string, unknown> }>(
    `SELECT status, attempts, last_error, payload FROM outbox WHERE id = $1::bigint`, [id])).rows[0]!;
  const insert = async (dedupKey: string, status: string, extra: { payload?: object; lastError?: string } = {}) =>
    (await q<{ id: string }>(
      `INSERT INTO outbox (workspace_id, effect_kind, dedup_key, payload, status, last_error)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id::text`,
      [WS, KIND, dedupKey, JSON.stringify(extra.payload ?? { v: 1 }), status, extra.lastError ?? null],
    )).rows[0]!.id;

  beforeAll(async () => {
    WS = context.workspaceId = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Outbox delivery', $1) RETURNING id::text`, [`w27-${randomUUID()}`])).rows[0]!.id;
    Object.assign(reviewer, await persistActor(WS, reviewer));
    // The last human admin persisted is the owner.
    Object.assign(owner, await persistActor(WS, owner));
  });
  beforeEach(async () => {
    // The inbox routes start a drain in the background; one still running
    // from the previous test would make this test's drainOutbox a no-op.
    await settleDrains();
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
  });

  it("a stuck effect times out as a failed attempt and the next row runs", async () => {
    const stuck = await enqueueEffect({ workspaceId: WS, kind: KIND, dedupKey: k("stuck"), payload: { stuck: true } });
    await q(`UPDATE outbox SET next_attempt_at = now() - interval '1 minute' WHERE id = $1::bigint`, [stuck]);
    const next = await enqueueEffect({ workspaceId: WS, kind: KIND, dedupKey: k("next"), payload: { stuck: false } });
    let aborted = false;
    const result = await drainOutbox({
      workspaceId: WS, timeoutMs: 200,
      perform: (_kind, payload, signal) => payload.stuck
        ? new Promise<void>(() => { signal.addEventListener("abort", () => { aborted = true; }); })
        : Promise.resolve(),
    });
    expect(result).toMatchObject({ done: 1, retried: 1, dead: 0 });
    expect(aborted).toBe(true);
    expect(await row(stuck)).toMatchObject({ status: "pending", attempts: 1 });
    expect((await row(stuck)).last_error).toMatch(/timed out/);
    expect((await row(next)).status).toBe("done");
  });

  it("a timed-out attempt still running holds its row: a payload folded in meanwhile runs after it, never alongside", async () => {
    let outside = "";
    const finished: string[] = [];
    const perform = async (_kind: string, payload: Record<string, unknown>) => {
      const v = String(payload.v);
      if (v === "A") await new Promise((r) => setTimeout(r, 600));
      outside = v; // a force push: the last one to finish wins
      finished.push(v);
    };
    const id = await enqueueEffect({ workspaceId: WS, kind: KIND, dedupKey: k("race"), payload: { v: "A" } });
    expect(await drainOutbox({ id, timeoutMs: 100, perform })).toMatchObject({ retried: 1 });
    // A new save folds B into the same pending row and makes it due now.
    await enqueueEffect({ workspaceId: WS, kind: KIND, dedupKey: k("race"), payload: { v: "B" } });
    // While A still runs, the row is not handed to another attempt.
    expect(await drainOutbox({ id, timeoutMs: 100, perform })).toEqual({ done: 0, retried: 0, dead: 0 });
    await _abandonedSettledForTests(id); // A finishes; its late success cannot settle B
    expect((await row(id)).status).toBe("pending");
    expect(await drainOutbox({ id, timeoutMs: 1000, perform })).toMatchObject({ done: 1 });
    expect(finished).toEqual(["A", "B"]);
    expect(outside).toBe("B");
    expect(await row(id)).toMatchObject({ status: "done", payload: { v: "B" } });
  });

  it("when the timed-out attempt was the row's last, a newer row on its key waits for it too", async () => {
    let outside = "";
    const finished: string[] = [];
    const perform = async (_kind: string, payload: Record<string, unknown>) => {
      const v = String(payload.v);
      if (v === "A") await new Promise((r) => setTimeout(r, 600));
      outside = v; // a force push: the last one to finish wins
      finished.push(v);
    };
    const a = await enqueueEffect({ workspaceId: WS, kind: KIND, dedupKey: k("last"), payload: { v: "A" } });
    await q(`UPDATE outbox SET max_attempts = 1 WHERE id = $1::bigint`, [a]);
    expect(await drainOutbox({ workspaceId: WS, timeoutMs: 100, perform })).toMatchObject({ dead: 1 });
    // The row is dead, so a new save opens a NEW pending row on the same key.
    const b = await enqueueEffect({ workspaceId: WS, kind: KIND, dedupKey: k("last"), payload: { v: "B" } });
    expect(b).not.toBe(a);
    // While A still runs, that row waits as well.
    expect(await drainOutbox({ workspaceId: WS, timeoutMs: 100, perform })).toEqual({ done: 0, retried: 0, dead: 0 });
    await _abandonedSettledForTests(a); // A finished and let go of the key
    expect(await drainOutbox({ workspaceId: WS, timeoutMs: 1000, perform })).toMatchObject({ done: 1 });
    expect(finished).toEqual(["A", "B"]);
    expect(outside).toBe("B");
  });

  it("a timed-out attempt that later succeeds settles its row without a second delivery", async () => {
    let performed = 0;
    const id = await enqueueEffect({ workspaceId: WS, kind: KIND, dedupKey: k("late"), payload: {} });
    await drainOutbox({ id, timeoutMs: 50, perform: async () => { await new Promise((r) => setTimeout(r, 200)); performed++; } });
    await _abandonedSettledForTests(id);
    expect(performed).toBe(1);
    expect((await row(id)).status).toBe("done");
  });

  it("ten failures in a row leave a row pending; only the default budget's last attempt buries it", async () => {
    const id = await enqueueEffect({ workspaceId: WS, kind: KIND, dedupKey: k("flaky"), payload: {} });
    const fail = async () => {
      await q(`UPDATE outbox SET next_attempt_at = now() WHERE id = $1::bigint`, [id]);
      return drainOutbox({ id, perform: async () => { throw new Error("github unreachable"); } });
    };
    for (let i = 0; i < 10; i++) await fail();
    expect(await row(id)).toMatchObject({ status: "pending", attempts: 10 });
    // Backoff so far: 2+4+…+1024 s, about 34 minutes — well inside an hour.
    const due = await q<{ minutes: number }>(
      `SELECT EXTRACT(EPOCH FROM (next_attempt_at - created_at)) / 60 AS minutes FROM outbox WHERE id = $1::bigint`, [id]);
    expect(Number(due.rows[0]!.minutes)).toBeLessThan(60);
    for (let i = 10; i < RETRY_DAY_ATTEMPTS - 1; i++) await fail();
    expect((await row(id)).status).toBe("pending");
    await fail();
    expect(await row(id)).toMatchObject({ status: "dead", attempts: RETRY_DAY_ATTEMPTS });
  });

  it("the owner lists a dead delivery and requeues it with a fresh budget", async () => {
    const dead = await insert(k("dead"), "dead", { lastError: "github unreachable" });
    await insert(k("rejected"), "dead", { lastError: "rejected_by_reviewer" });

    currentActor = reviewer;
    expect(await (await app.request("/api/inbox/failed-effects")).json()).toEqual({ failed: [], count: 0, groups: [], total: 0 });
    expect((await post(`/api/inbox/failed-effects/${dead}/retry`)).status).toBe(403);

    currentActor = owner;
    const listed = await (await app.request("/api/inbox/failed-effects")).json() as { failed: Array<{ id: string; last_error: string }> };
    expect(listed.failed.map((f) => f.id)).toEqual([dead]);
    expect(listed.failed[0]).not.toHaveProperty("payload");

    const res = await post(`/api/inbox/failed-effects/${dead}/retry`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: dead, status: "requeued" });
    const requeued = await q<{ status: string; attempts: number; max_attempts: number }>(
      `SELECT status, attempts, max_attempts FROM outbox WHERE id = $1::bigint`, [dead]);
    expect(requeued.rows[0]!.attempts).toBe(0);
    expect(requeued.rows[0]!.max_attempts).toBe(RETRY_DAY_ATTEMPTS);
    expect(["pending", "done"]).toContain(requeued.rows[0]!.status); // the route kicks a drain
  });

  it("a reviewer's rejection cannot be requeued", async () => {
    const rejected = await insert(k("rejected"), "dead", { lastError: "rejected_by_reviewer" });
    currentActor = owner;
    expect((await post(`/api/inbox/failed-effects/${rejected}/retry`)).status).toBe(404);
    expect((await row(rejected)).status).toBe("dead");
  });

  it("requeueing a dead delivery whose key already has a newer pending row settles it instead", async () => {
    const dead = await insert(k("note"), "dead", { payload: { v: "old" }, lastError: "boom" });
    const newer = await insert(k("note"), "pending", { payload: { v: "new" } });
    await q(`UPDATE outbox SET next_attempt_at = now() + interval '1 hour' WHERE id = $1::bigint`, [newer]);
    currentActor = owner;
    const res = await post(`/api/inbox/failed-effects/${dead}/retry`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "superseded", superseded_by: newer });
    expect((await row(dead)).status).toBe("done");
    expect((await row(newer)).payload).toEqual({ v: "new" });
  });

  it("requeueing an old dead delivery after a newer one of that key was delivered settles it, never resends old content", async () => {
    const old = await insert(k("site"), "dead", { payload: { snapshot: "s1-old" }, lastError: "boom" });
    const newer = await insert(k("site"), "done", { payload: { snapshot: "s2-new" } });
    const sent: unknown[] = [];
    currentActor = owner;
    const res = await post(`/api/inbox/failed-effects/${old}/retry`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "superseded", superseded_by: newer });
    expect((await row(old)).status).toBe("done");
    // The route kicked a drain in the background; behind it this one would be
    // a no-op and prove nothing.
    await settleDrains();
    await drainOutbox({ workspaceId: WS, perform: async (_k, payload) => { sent.push(payload); } });
    expect(sent).toEqual([]);
  });

  it("requeueing a dead delivery newer than the waiting pending row folds its payload into that row", async () => {
    const older = await insert(k("doc"), "pending", { payload: { v: "older" } });
    await q(`UPDATE outbox SET next_attempt_at = now() + interval '1 hour' WHERE id = $1::bigint`, [older]);
    const dead = await insert(k("doc"), "dead", { payload: { v: "newer" }, lastError: "boom" });
    currentActor = owner;
    const res = await post(`/api/inbox/failed-effects/${dead}/retry`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "merged", merged_into: older });
    expect((await row(dead)).status).toBe("done");
    expect((await row(older)).payload).toEqual({ v: "newer" });
  });

  it("approving a held intent whose key already has a pending row merges into it (200, not 500)", async () => {
    const waiting = await insert(k("publish"), "pending", { payload: { title: "first" } });
    await q(`UPDATE outbox SET attempts = 3, next_attempt_at = now() + interval '1 hour' WHERE id = $1::bigint`, [waiting]);
    const held = await insert(k("publish"), "pending_approval", { payload: { title: "second" } });
    currentActor = owner;
    const res = await post(`/api/inbox/approvals/${held}/approve`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: held, decision: "approved", merged_into: waiting });
    expect((await row(held)).status).toBe("done");
    const merged = await row(waiting);
    expect(merged.payload).toEqual({ title: "second" });
    expect(merged.attempts === 0 || merged.status === "done").toBe(true);
    // Deciding again finds nothing held.
    expect((await post(`/api/inbox/approvals/${held}/approve`)).status).toBe(404);
  });

  it("approving with no pending row of that key flips the held row to pending as before", async () => {
    const held = await insert(k("solo"), "pending_approval");
    currentActor = owner;
    const res = await post(`/api/inbox/approvals/${held}/approve`);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("merged_into");
    expect(["pending", "done"]).toContain((await row(held)).status);
  });
  // Settings › System status: failed deliveries grouped by kind, retried or
  // cleared a kind at a time. Clearing sets dead rows aside as 'dismissed';
  // nothing pending, held or rejected changes.
  it("the owner sees failed deliveries grouped by kind with counts, last error and times", async () => {
    const first = await insert(k("g1"), "dead", { lastError: "first error" });
    const second = await insert(k("g2"), "dead", { lastError: "newest error" });
    await q(`UPDATE outbox SET updated_at = now() - interval '2 hours' WHERE id = $1::bigint`, [first]);
    await insert(k("rej"), "dead", { lastError: "rejected_by_reviewer" });
    await insert(k("p"), "pending");
    currentActor = reviewer;
    expect(await (await app.request("/api/inbox/failed-effects")).json()).toEqual({ failed: [], count: 0, groups: [], total: 0 });
    currentActor = owner;
    const body = await (await app.request("/api/inbox/failed-effects")).json() as {
      total: number; groups: Array<{ effect_kind: string; count: number; last_error: string; oldest_at: string; newest_at: string }>;
    };
    expect(body.total).toBe(2);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toMatchObject({ effect_kind: KIND, count: 2, last_error: "newest error" });
    expect(Date.parse(body.groups[0]!.oldest_at)).toBeLessThan(Date.parse(body.groups[0]!.newest_at));
    expect(second).toBeTruthy();
  });

  it("clear all dismisses only the kind's dead rows; owner only", async () => {
    const deadA = await insert(k("c1"), "dead", { lastError: "boom" });
    const deadB = await insert(k("c2"), "dead", { lastError: "boom" });
    const rejected = await insert(k("c3"), "dead", { lastError: "rejected_by_reviewer" });
    const pending = await insert(k("c4"), "pending");
    await q(`UPDATE outbox SET next_attempt_at = now() + interval '1 hour' WHERE id = $1::bigint`, [pending]);
    const held = await insert(k("c5"), "pending_approval");
    const other = await q<{ id: string }>(
      `INSERT INTO outbox (workspace_id, effect_kind, dedup_key, payload, status, last_error)
       VALUES ($1, 'other_kind', 'w27:o', '{}'::jsonb, 'dead', 'x') RETURNING id::text`, [WS]);

    const audits = async () => (await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM domain_events WHERE event_type = 'EFFECTS_DISMISSED' AND target_id = $1`, [KIND])).rows[0]!.n;
    const auditsBefore = await audits();
    currentActor = reviewer;
    expect((await post(`/api/inbox/failed-effects/kinds/${KIND}/dismiss`)).status).toBe(403);
    expect((await row(deadA)).status).toBe("dead");

    currentActor = owner;
    expect((await post(`/api/inbox/failed-effects/kinds/Bad-Kind!/dismiss`)).status).toBe(400);
    const res = await post(`/api/inbox/failed-effects/kinds/${KIND}/dismiss`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ effect_kind: KIND, dismissed: 2 });
    expect(await row(deadA)).toMatchObject({ status: "dismissed", last_error: "boom" });
    expect((await row(deadB)).status).toBe("dismissed");
    expect((await row(rejected)).status).toBe("dead");
    expect((await row(pending)).status).toBe("pending");
    expect((await row(held)).status).toBe("pending_approval");
    expect((await row(other.rows[0]!.id)).status).toBe("dead");
    const listed = await (await app.request("/api/inbox/failed-effects")).json() as { failed: Array<{ id: string }>; total: number };
    expect(listed.failed.map((f) => f.id)).toEqual([other.rows[0]!.id]);
    expect(listed.total).toBe(1);
    // A dismissed row is not a failed delivery any more: it cannot be retried.
    expect((await post(`/api/inbox/failed-effects/${deadA}/retry`)).status).toBe(404);
    expect(await audits()).toBe(auditsBefore + 1);
  });

  it("retry all requeues the kind's failed deliveries; an older row of a key is superseded by the newer", async () => {
    const older = await insert(k("r1"), "dead", { payload: { v: "old" }, lastError: "boom" });
    const newer = await insert(k("r1"), "dead", { payload: { v: "new" }, lastError: "boom" });
    const lone = await insert(k("r2"), "dead", { lastError: "boom" });
    currentActor = reviewer;
    expect((await post(`/api/inbox/failed-effects/kinds/${KIND}/retry`)).status).toBe(403);
    currentActor = owner;
    const res = await post(`/api/inbox/failed-effects/kinds/${KIND}/retry`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ effect_kind: KIND, requeued: 2, superseded: 1 });
    expect((await row(older)).status).toBe("done");
    expect(["pending", "done"]).toContain((await row(newer)).status);
    expect(["pending", "done"]).toContain((await row(lone)).status);
    expect((await row(newer)).payload).toEqual({ v: "new" });
  });

  it("the reaper removes old dismissed rows with the dead ones", async () => {
    const { reapOutbox } = await import("../services/outbox.js");
    const dismissed = await insert(k("reap"), "dismissed", { lastError: "boom" });
    await q(`UPDATE outbox SET updated_at = now() - interval '40 days' WHERE id = $1::bigint`, [dismissed]);
    await reapOutbox();
    expect((await q(`SELECT 1 FROM outbox WHERE id = $1::bigint`, [dismissed])).rows).toHaveLength(0);
  });
});
