// Integration test for the transactional outbox (migration 046, wired
// 2026-06-07). Exercises the state machine against a real Postgres — enqueue,
// the pending-collapse partial-unique index, and the reconciler's
// done/backoff/dead transitions — using an injected performer so it doesn't
// depend on real git/GitHub I/O.
//
// SAFETY: only runs against a *_test database (skips otherwise).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import { enqueueBackup, drainOutbox, type OutboxEffectKind } from "../services/outbox.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// A synthetic workspace id for this run (outbox.workspace_id has no FK);
// fresh per run so its wipes below only ever touch this run's rows.
const WS = randomUUID();
// Note ids for the state-machine tests: an intent names its note by id, and
// these name no note (the performer is injected).
const OB = { a: randomUUID(), done: randomUUID(), lock: randomUUID(), fail: randomUUID() };

async function pending(dedupKey: string) {
  const r = await q<{ id: string; payload: { markdown: string }; attempts: number; next_attempt_at: string }>(
    `SELECT id, payload, attempts, next_attempt_at FROM outbox WHERE dedup_key = $1 AND status = 'pending'`,
    [dedupKey],
  );
  return r.rows;
}

describe.skipIf(!isTestDb)("transactional outbox (DB)", () => {
  // A real workspace + two nodes for the per-node egress opt-out tests (the
  // local_only check JOINs content_nodes + node_attributes, so those need real
  // rows — unlike the synthetic WS used by the state-machine tests).
  let realWs = "";
  let plain = "";
  let secret = "";
  beforeAll(async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
    // A real workspace of its own: the shared default workspace's outbox
    // holds other tests' intents.
    realWs = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Outbox', $1) RETURNING id`, [`outbox-${randomUUID()}`],
    )).rows[0]!.id;
    const notes = await seedQ<{ id: string; slug: string }>(
      `INSERT INTO content_nodes (workspace_id, node_type, source_type, title, slug, markdown)
       VALUES ($1, 'content', 'manual', 'Plain', 'lo-plain', 'p'),
              ($1, 'content', 'manual', 'Secret', 'lo-secret', 's')
       RETURNING id::text, slug`,
      [realWs],
    );
    plain = notes.rows.find((n) => n.slug === "lo-plain")!.id;
    secret = notes.rows.find((n) => n.slug === "lo-secret")!.id;
    await seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, source)
       SELECT $1, id, 'local_only', 'true', 'explicit'
         FROM content_nodes WHERE workspace_id = $1 AND slug = 'lo-secret'`,
      [realWs],
    );
  });
  afterAll(async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [realWs]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND slug IN ('lo-plain','lo-secret')`, [realWs]);
    await pool.end();
  });

  // ── Per-node egress opt-out (local_only) ─────────────────────────────────
  // A node flagged `local_only` must NEVER enqueue the REMOTE github_backup
  // intent (the only effect crossing the deployment boundary). The LOCAL
  // git_commit still runs — in-container redundancy, not egress.
  it("a plain node enqueues BOTH git_commit and github_backup", async () => {
    await enqueueBackup({ workspaceId: realWs, nodeId: plain, markdown: "v1", message: "m" });
    const rows = await q<{ effect_kind: string }>(
      `SELECT effect_kind FROM outbox WHERE workspace_id = $1 AND payload->>'node_id' = $2 AND status = 'pending'`,
      [realWs, plain],
    );
    expect(rows.rows.map((r) => r.effect_kind).sort()).toEqual(["git_commit", "github_backup"]);
  });

  it("a local_only node enqueues ONLY git_commit — never the remote github_backup", async () => {
    await enqueueBackup({ workspaceId: realWs, nodeId: secret, markdown: "v1", message: "m" });
    const rows = await q<{ effect_kind: string }>(
      `SELECT effect_kind FROM outbox WHERE workspace_id = $1 AND payload->>'node_id' = $2 AND status = 'pending'`,
      [realWs, secret],
    );
    expect(rows.rows.map((r) => r.effect_kind)).toEqual(["git_commit"]);
    const gh = await q(
      `SELECT 1 FROM outbox WHERE workspace_id = $1 AND payload->>'node_id' = $2 AND effect_kind = 'github_backup'`,
      [realWs, secret],
    );
    expect(gh.rows.length).toBe(0);
  });

  it("enqueue creates one pending intent per effect kind", async () => {
    await enqueueBackup({ workspaceId: WS, nodeId: OB.a, markdown: "v1", message: "m1", triggeredByEventId: undefined });
    const git = await pending(`git_commit:${OB.a}`);
    const gh = await pending(`github_backup:${OB.a}`);
    expect(git.length).toBe(1);
    expect(gh.length).toBe(1);
    expect(gh[0]!.payload.markdown).toBe("v1");
  });

  it("re-enqueue collapses onto the single pending row with the latest content", async () => {
    await enqueueBackup({ workspaceId: WS, nodeId: OB.a, markdown: "v2-latest", message: "m2" });
    await enqueueBackup({ workspaceId: WS, nodeId: OB.a, markdown: "v3-latest", message: "m3" });
    const gh = await pending(`github_backup:${OB.a}`);
    expect(gh.length).toBe(1); // partial-unique index keeps exactly one pending
    expect(gh[0]!.payload.markdown).toBe("v3-latest"); // superseded to newest
  });

  it("drain performs each effect and marks it done", async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
    await enqueueBackup({ workspaceId: WS, nodeId: OB.done, markdown: "x", message: "m" });
    const seen: OutboxEffectKind[] = [];
    const res = await drainOutbox({ workspaceId: WS, perform: async (kind) => { seen.push(kind); } });
    expect(res.done).toBe(2); // git_commit + github_backup
    expect(seen.sort()).toEqual(["git_commit", "github_backup"]);
    const left = await q(`SELECT status FROM outbox WHERE dedup_key = $1`, [`github_backup:${OB.done}`]);
    expect((left.rows[0] as { status: string }).status).toBe("done");
  });

  it("a row re-dirtied mid-drain stays pending with the NEWER payload — not buried done (H6)", async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
    await q(
      `INSERT INTO outbox (workspace_id, effect_kind, dedup_key, payload)
       VALUES ($1, 'github_backup', 'github_backup:ob-race', '{"slug":"ob-race","markdown":"v1"}'::jsonb)`,
      [WS],
    );
    const performed: string[] = [];
    // Drain #1: WHILE performing v1, a concurrent save folds a NEWER payload (v2)
    // into the SAME pending row (the real ON CONFLICT (dedup_key) WHERE status=
    // 'pending' DO UPDATE path) — changing its xmin. The unconditional done-mark
    // would bury v2 in a done row, never pushing it; the xmin-guarded mark must
    // leave the row pending so v2 still drains.
    const res1 = await drainOutbox({
      workspaceId: WS,
      perform: async (_kind, payload) => {
        performed.push(String(payload.markdown));
        if (payload.markdown === "v1") {
          await q(
            `UPDATE outbox SET payload = '{"slug":"ob-race","markdown":"v2"}'::jsonb, updated_at = now()
               WHERE dedup_key = 'github_backup:ob-race' AND status = 'pending'`,
          );
        }
      },
    });
    expect(performed).toEqual(["v1"]);
    expect(res1.done).toBe(0); // NOT marked done — it was superseded mid-drain
    const mid = await q<{ status: string; payload: { markdown: string } }>(
      `SELECT status, payload FROM outbox WHERE dedup_key = 'github_backup:ob-race'`,
    );
    expect(mid.rows[0]!.status).toBe("pending"); // the bug marked it 'done'
    expect(mid.rows[0]!.payload.markdown).toBe("v2"); // carrying the newest content

    // Drain #2: the newer payload is performed and the row finally settles done.
    const res2 = await drainOutbox({
      workspaceId: WS,
      perform: async (_kind, payload) => { performed.push(String(payload.markdown)); },
    });
    expect(res2.done).toBe(1);
    expect(performed).toEqual(["v1", "v2"]); // v2 was NOT lost
    expect((await q<{ status: string }>(`SELECT status FROM outbox WHERE dedup_key = 'github_backup:ob-race'`)).rows[0]!.status).toBe("done");
  });

  it.skipIf(needsSecondConnection)("skips the drain while another connection holds the advisory lock (cross-instance guard)", async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
    await enqueueBackup({ workspaceId: WS, nodeId: OB.lock, markdown: "x", message: "m" });
    // Simulate a SECOND backend instance's reconciler already draining: it holds
    // the session-level advisory lock on its own connection.
    const OUTBOX_DRAIN_LOCK_KEY = 4_242_046_046; // must match services/outbox.ts
    const holder = await pool.connect();
    try {
      const got = await holder.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked", [OUTBOX_DRAIN_LOCK_KEY],
      );
      expect(got.rows[0]!.locked).toBe(true);
      // This instance's drain must NOT perform — the row stays pending for the holder.
      const seen: OutboxEffectKind[] = [];
      const res = await drainOutbox({ workspaceId: WS, perform: async (k) => { seen.push(k); } });
      expect(res).toEqual({ done: 0, retried: 0, dead: 0 });
      expect(seen).toEqual([]);
      expect((await pending(`github_backup:${OB.lock}`)).length).toBe(1);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [OUTBOX_DRAIN_LOCK_KEY]).catch(() => {});
      holder.release();
    }
    // Lock released → the next drain proceeds normally.
    const seen2: OutboxEffectKind[] = [];
    const res2 = await drainOutbox({ workspaceId: WS, perform: async (k) => { seen2.push(k); } });
    expect(res2.done).toBe(2);
    expect(seen2.sort()).toEqual(["git_commit", "github_backup"]);
  });

  it("a failing effect is retried with backoff (stays pending, attempt bumped, next_attempt pushed out)", async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
    await enqueueBackup({ workspaceId: WS, nodeId: OB.fail, markdown: "x", message: "m" });
    const res = await drainOutbox({ workspaceId: WS, perform: async () => { throw new Error("boom"); } });
    expect(res.retried).toBe(2);
    expect(res.dead).toBe(0);
    const rows = await q<{ attempts: number; last_error: string; status: string; due_in: number }>(
      `SELECT attempts, last_error, status,
              EXTRACT(EPOCH FROM (next_attempt_at - now())) AS due_in
         FROM outbox WHERE dedup_key = $1`,
      [`github_backup:${OB.fail}`],
    );
    expect(rows.rows[0]!.attempts).toBe(1);
    expect(rows.rows[0]!.status).toBe("pending");
    expect(rows.rows[0]!.last_error).toContain("boom");
    expect(Number(rows.rows[0]!.due_in)).toBeGreaterThan(0); // backoff pushed it into the future
    // It is NOT due now, so an immediate re-drain skips it.
    const again = await drainOutbox({ workspaceId: WS, perform: async () => { throw new Error("boom2"); } });
    expect(again.retried + again.dead).toBe(0);
  });

  it("an intent that exhausts max_attempts is buried as dead", async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
    // Seed a row already at the brink (max_attempts=1) so one failure kills it.
    await q(
      `INSERT INTO outbox (workspace_id, effect_kind, dedup_key, payload, max_attempts)
       VALUES ($1, 'github_backup', 'github_backup:ob-dead', '{"slug":"ob-dead","markdown":"x","message":"m"}'::jsonb, 1)`,
      [WS],
    );
    const res = await drainOutbox({ workspaceId: WS, perform: async () => { throw new Error("permanent"); } });
    expect(res.dead).toBe(1);
    const row = await q<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM outbox WHERE dedup_key = 'github_backup:ob-dead'`,
    );
    expect(row.rows[0]!.status).toBe("dead");
    expect(row.rows[0]!.last_error).toContain("permanent");
  });
});
