// Realtime track integration tests, against a real Postgres:
//
//   1. /api/events/stream requires auth.
//   2. A spine mutation produces a blind tick whose payload contains ONLY
//      {kind, latest} — this PINS the leak-proof contract (no ids, no titles,
//      no event types may ever ride the channel).
//   3. A burst of mutations coalesces into fewer ticks (≤ one per ~250ms).
//   4. An outbox status transition produces an {kind:"effects"} tick (and
//      nothing more — same blindness pin).
//   5. Instant drain: enqueue → the effect performs WITHOUT anyone running the
//      periodic reconciler tick.
//   6. Concurrent enqueues coalesce into serialized drain passes — no effect
//      is double-performed.
//
// SAFETY: only runs against a *_test database (skips otherwise).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { pool, q, getWorkspaceId, migrate } from "../db.js";
import { mutate } from "../spine/mutate.js";
import eventsRouter from "../routes/events.js";
import {
  enqueueBackup,
  drainOutbox,
  _armInstantDrainForTests,
  _disarmInstantDrainForTests,
  type OutboxEffectKind,
} from "../services/outbox.js";
import { subscribeRealtime, type RealtimeTick } from "../services/realtime.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let admin: ActorCtx = { id: "rt-admin", name: "RT Admin", role: "admin", type: "human" };
let currentActor: ActorCtx | null = admin;

const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/events", eventsRouter);

let workspaceId = "";

// Emit one real mutation through the spine (event + commit + post-commit tick).
async function oneMutation(n: number): Promise<void> {
  await mutate({
    actor: admin,
    workspaceId,
    authority: { kind: "open", why: "realtime tick test fixture" },
    event: {
      type: "REALTIME_TEST_PING",
      targetType: "workspace",
      targetId: workspaceId,
      payload: { n },
    },
    apply: async () => null,
  });
}

// Read the next `data:` frame off an open SSE response, with a deadline.
async function nextDataFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 4_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(1, deadline - Date.now()))),
    ]);
    if (chunk === null || chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    const m = /^data: (.*)$/m.exec(buf);
    if (m) return m[1]!;
  }
  throw new Error(`no SSE data frame before timeout; raw buffer: ${JSON.stringify(buf)}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(50);
  }
  return false;
}

describe.skipIf(!isTestDb)("realtime: SSE blind ticks + instant outbox drain (DB)", () => {
  beforeAll(async () => {
    await migrate();
    workspaceId = await getWorkspaceId();
    admin = await persistActor(workspaceId, admin);
    currentActor = admin;
    // Determinism for the drain tests below: a leftover pending intent from an
    // earlier suite would be swept into our armed drain passes.
    await q(`DELETE FROM outbox WHERE status = 'pending'`);
  });

  afterAll(async () => {
    await _disarmInstantDrainForTests();
    await q(`DELETE FROM outbox WHERE dedup_key LIKE '%:rt-%'`);
    await pool.end();
  });

  it("the stream requires auth", async () => {
    currentActor = null;
    try {
      const res = await app.request("/api/events/stream");
      expect(res.status).toBe(401);
    } finally {
      currentActor = admin;
    }
  });

  it("a mutation produces a tick whose payload contains ONLY {kind, latest} — the leak-proof pin", async () => {
    const res = await app.request("/api/events/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    try {
      await oneMutation(1);
      const frame = await nextDataFrame(reader);
      const tick = JSON.parse(frame) as Record<string, unknown>;
      // The pin: exactly these two keys, nothing else may EVER ride the channel.
      expect(Object.keys(tick).sort()).toEqual(["kind", "latest"]);
      expect(tick.kind).toBe("changed");
      expect(typeof tick.latest).toBe("number");
      expect(tick.latest as number).toBeGreaterThan(0);
      // And the values carry no content: latest matches the log's high-water
      // mark (already public to every authed caller via /api/sync).
      const max = await q<{ max: string }>(`SELECT COALESCE(MAX(id), 0) AS max FROM domain_events`);
      expect(tick.latest as number).toBeLessThanOrEqual(Number(max.rows[0]!.max));
    } finally {
      await reader.cancel().catch(() => null);
    }
  });

  it("a burst of N mutations coalesces into fewer than N ticks", async () => {
    const ticks: RealtimeTick[] = [];
    const unsubscribe = subscribeRealtime((t) => { if (t.kind === "changed") ticks.push(t); });
    try {
      const N = 8;
      for (let i = 0; i < N; i++) await oneMutation(i);
      await sleep(700); // > coalesce window — every pending flush has fired
      expect(ticks.length).toBeGreaterThanOrEqual(1);
      expect(ticks.length).toBeLessThan(N); // the whole point of coalescing
      // latest is monotone non-decreasing across flushes.
      for (let i = 1; i < ticks.length; i++) {
        expect((ticks[i] as { latest: number }).latest)
          .toBeGreaterThanOrEqual((ticks[i - 1] as { latest: number }).latest);
      }
    } finally {
      unsubscribe();
    }
  });

  it("an outbox status transition produces a blind {kind:'effects'} tick", async () => {
    const effects: Record<string, unknown>[] = [];
    const unsubscribe = subscribeRealtime((t) => { if (t.kind === "effects") effects.push(t as Record<string, unknown>); });
    try {
      await enqueueBackup({ workspaceId, nodeId: randomUUID(), markdown: "x", message: "m" });
      await sleep(400); // enqueue itself raises an effects tick (new pending row)
      const before = effects.length;
      expect(before).toBeGreaterThanOrEqual(1);
      await drainOutbox({ workspaceId, perform: async () => {} }); // pending → done
      await sleep(400);
      expect(effects.length).toBeGreaterThan(before);
      // Blindness pin for the effects tick: the payload is {kind} alone.
      expect(Object.keys(effects[effects.length - 1]!)).toEqual(["kind"]);
    } finally {
      unsubscribe();
    }
  });

  it("instant drain: enqueue → effect performed without running the reconciler tick", async () => {
    const performed: string[] = [];
    _armInstantDrainForTests(async (kind: OutboxEffectKind, payload) => {
      performed.push(`${kind}:${(payload as { node_id?: string }).node_id ?? ""}`);
    });
    const instant = randomUUID();
    try {
      await enqueueBackup({ workspaceId, nodeId: instant, markdown: "x", message: "m" });
      // NOTE: nobody calls drainOutbox() here — the post-commit kick must do it.
      const done = await waitFor(async () => {
        const r = await q<{ n: string }>(
          `SELECT count(*) AS n FROM outbox WHERE dedup_key = ANY($1) AND status = 'done'`,
          [[`git_commit:${instant}`, `github_backup:${instant}`]],
        );
        return Number(r.rows[0]!.n) === 2; // git_commit + github_backup
      });
      expect(done).toBe(true);
      expect(performed).toContain(`git_commit:${instant}`);
      expect(performed).toContain(`github_backup:${instant}`);
    } finally {
      await _disarmInstantDrainForTests();
    }
  });

  it("concurrent enqueues coalesce — no effect is double-performed", async () => {
    const performed: string[] = [];
    _armInstantDrainForTests(async (kind: OutboxEffectKind, payload) => {
      performed.push(`${kind}:${(payload as { node_id?: string }).node_id ?? ""}`);
    });
    try {
      const ids = Array.from({ length: 6 }, () => randomUUID());
      const keys = ids.flatMap((id) => [`git_commit:${id}`, `github_backup:${id}`]);
      await Promise.all(ids.map((nodeId) =>
        enqueueBackup({ workspaceId, nodeId, markdown: "x", message: "m" }),
      ));
      const allDone = await waitFor(async () => {
        const r = await q<{ n: string }>(
          `SELECT count(*) AS n FROM outbox WHERE dedup_key = ANY($1) AND status = 'done'`, [keys],
        );
        return Number(r.rows[0]!.n) === ids.length * 2;
      }, 6_000);
      expect(allDone).toBe(true);
      await sleep(300); // let any (wrongly) queued extra pass land before counting
      const mine = performed.filter((p) => keys.includes(p));
      const counts = new Map<string, number>();
      for (const p of mine) counts.set(p, (counts.get(p) ?? 0) + 1);
      expect(mine.length).toBe(ids.length * 2);
      for (const [key, n] of counts) expect.soft(n, `${key} performed ${n}×`).toBe(1);
    } finally {
      await _disarmInstantDrainForTests();
    }
  });
});
