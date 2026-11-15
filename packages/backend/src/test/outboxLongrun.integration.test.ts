// Long-running backend stability (長時間運作, backend side) against a real
// Postgres: the outbox reconciler must survive a long uptime without (a) the
// table growing without bound — old done/dead history is reaped; (b) drifting
// or overlapping — the `draining` guard makes a slow drain skip the next tick
// rather than pile up; (c) leaking pool connections under sustained load.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import { drainOutbox, reapOutbox, enqueueBackup } from "../services/outbox.js";
import { needsPostgresServer } from "./helpers/pgliteSkips.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);
const WS = "00000000-0000-0000-0000-0000000a1000";

describe.skipIf(!isTestDb)("outbox long-running stability (DB)", () => {
  beforeAll(async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1 OR dedup_key LIKE 'reap:%'`, [WS]);
  });
  afterAll(async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1 OR dedup_key LIKE 'reap:%'`, [WS]);
  });

  // (a) Reaper keeps the table bounded: old done + old dead go, recent done +
  // pending stay. Asserted by dedup_key so it's independent of other rows.
  it("reapOutbox drops old done/dead history but keeps recent + pending", async () => {
    await q(
      `INSERT INTO outbox (workspace_id, effect_kind, dedup_key, payload, status, done_at, updated_at) VALUES
        ($1,'embed','reap:old-done','{}','done',    now()-interval '10 days', now()-interval '10 days'),
        ($1,'embed','reap:new-done','{}','done',    now()-interval '1 day',   now()-interval '1 day'),
        ($1,'embed','reap:old-dead','{}','dead',    NULL,                      now()-interval '40 days'),
        ($1,'embed','reap:pending', '{}','pending', NULL,                      now())`,
      [WS],
    );
    const res = await reapOutbox({ doneRetentionDays: 7, deadRetentionDays: 30 });
    expect(res.doneReaped).toBeGreaterThanOrEqual(1);
    expect(res.deadReaped).toBeGreaterThanOrEqual(1);

    const keys = (await q<{ dedup_key: string }>(`SELECT dedup_key FROM outbox WHERE dedup_key LIKE 'reap:%'`)).rows.map((r) => r.dedup_key);
    expect(keys).toContain("reap:new-done"); // within retention → kept
    expect(keys).toContain("reap:pending");  // pending is never reaped
    expect(keys).not.toContain("reap:old-done");
    expect(keys).not.toContain("reap:old-dead");
  });

  // (b) Re-entrancy: a drain already in progress makes a concurrent tick a
  // no-op, so ticks can't overlap or double-perform under load.
  it("a concurrent drain is skipped (no overlap / no double-perform)", async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
    await enqueueBackup({ workspaceId: WS, nodeId: randomUUID(), markdown: "x", message: "m" });
    let performs = 0;
    const slow = async () => { performs++; await new Promise((r) => setTimeout(r, 150)); };
    const [r1, r2] = await Promise.all([
      drainOutbox({ workspaceId: WS, perform: slow }),
      drainOutbox({ workspaceId: WS, perform: slow }), // enters while r1 holds the guard
    ]);
    // exactly one drain ran the work; the other bailed immediately
    const ran = r1.done + r2.done;
    expect(ran).toBe(2);                    // git_commit + github_backup, once each
    expect(performs).toBe(2);               // not 4 — no double-perform
    expect(Math.min(r1.done, r2.done)).toBe(0); // one of them was the skipped no-op
  });

  // (c) No connection leak: many sequential drains return their connections;
  // the pool stays small and nothing is left waiting.
  it.skipIf(needsPostgresServer)("connections return to the pool under sustained drains (no leak)", async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
    for (let i = 0; i < 40; i++) {
      await drainOutbox({ workspaceId: WS, perform: async () => {} });
    }
    expect(pool.waitingCount).toBe(0);                 // nobody starved
    expect(pool.totalCount).toBeLessThanOrEqual(20);   // ≤ PG_POOL_MAX — no unbounded growth
    expect(pool.idleCount).toBeGreaterThan(0);         // connections were returned, sitting idle
  });
});
