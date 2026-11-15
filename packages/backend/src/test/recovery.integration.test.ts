// Failure-recovery verification (故障恢復) against a real Postgres. Targets the
// spine's hardest-to-believe promise — "event + apply are atomic" (#4) — from
// the failure side: if apply() throws AFTER the event was emitted, the event
// must leave zero trace, and a partially-built cascade must unwind whole. Plus
// an outbox exactly-once-ish guard: a delivered intent is never performed twice.
//
// SAFETY: only runs against a *_test database; skips otherwise.
//   DATABASE_URL=postgres://.../onden_test npx vitest run src/test/recovery.integration.test.ts

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { mutate } from "../spine/mutate.js";
import { enqueueBackup, drainOutbox, type OutboxEffectKind } from "../services/outbox.js";
import type { ActorCtx } from "../types.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const evCount = async (target: string) => {
  const r = await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE target_id = $1`, [target]);
  return Number(r.rows[0]!.n);
};

describe.skipIf(!isTestDb)("failure recovery (DB)", () => {
  let workspaceId: string;
  let actor: ActorCtx;
  // Per-run nonce so target ids are unique each invocation. domain_events is
  // append-only, so a durable control event would otherwise accumulate across
  // re-runs against a persistent DB and inflate the count. (Date.now/random are
  // fine in tests — only workflow scripts forbid them.)
  const RUN = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  let seq = 0;
  const uniq = (p: string) => `${p}-${RUN}-${seq++}`;

  beforeAll(async () => {
    const ws = await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Test', 'default')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    );
    workspaceId = ws.rows[0]!.id;
    const a = await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type) VALUES ($1,'Recoverer','human') RETURNING id`,
      [workspaceId],
    );
    actor = { id: a.rows[0]!.id, name: "Recoverer", type: "human" };
  });

  // The event is emitted (INSERTed) BEFORE apply() runs in before-timing. If
  // apply then throws, the whole transaction aborts and that INSERT is undone —
  // there must be no committed event. This is what makes a crashed mutation
  // leave the log clean rather than half-written.
  it("apply() throwing rolls back the already-emitted event (zero trace)", async () => {
    const target = uniq("rollback");
    expect(await evCount(target)).toBe(0);

    await expect(
      mutate({
        actor, workspaceId,
        authority: { kind: "open", why: "recovery test" },
        event: { type: "TEST_PROBE", targetType: "test", targetId: target, payload: {} },
        apply: async () => { throw new Error("apply boom"); },
      }),
    ).rejects.toThrow("apply boom");

    // The event that was emitted inside the aborted tx must be gone.
    expect(await evCount(target)).toBe(0);
  });

  // A nested mutate() inside apply() joins the same transaction (it reuses the
  // open client — also the reentrancy that fixed the pool deadlock). So if the
  // ROOT apply throws after a child mutation already "succeeded", the child must
  // roll back too: a cascade is all-or-nothing, never half-applied.
  it("a cascade unwinds whole when the root fails (child event rolls back too)", async () => {
    const rootTarget = uniq("cascade-root");
    const childTarget = uniq("cascade-child");

    await expect(
      mutate({
        actor, workspaceId,
        authority: { kind: "open", why: "recovery test" },
        event: { type: "TEST_PROBE", targetType: "test", targetId: rootTarget, payload: {} },
        apply: async () => {
          // child mutation commits within the same tx context…
          await mutate({
            actor, workspaceId,
            authority: { kind: "open", why: "recovery child" },
            event: { type: "TEST_PROBE_CHILD", targetType: "test", targetId: childTarget, payload: {} },
            apply: async () => { /* ok */ },
          });
          // …then the root blows up after the child "succeeded"
          throw new Error("root boom");
        },
      }),
    ).rejects.toThrow("root boom");

    expect(await evCount(rootTarget)).toBe(0);
    expect(await evCount(childTarget)).toBe(0); // the child did NOT survive the root's failure
  });

  // A clean mutation, by contrast, commits its event durably.
  it("a clean mutation commits its event (control)", async () => {
    const target = uniq("clean");
    await mutate({
      actor, workspaceId,
      authority: { kind: "open", why: "recovery test" },
      event: { type: "TEST_PROBE", targetType: "test", targetId: target, payload: {} },
      apply: async () => { /* ok */ },
    });
    expect(await evCount(target)).toBe(1);
  });

  // Outbox recovery: once an intent is delivered (done), a later drain must not
  // perform its side effect again — otherwise a reconciler tick after a crash
  // would double-commit/double-push. (At-least-once enqueue, but no re-perform
  // of an already-done row.)
  it("a delivered outbox intent is never performed twice", async () => {
    // A synthetic workspace id of this test's own (outbox.workspace_id has no
    // FK), so the drain sees only its intent and no other run's.
    const WS = randomUUID();
    await enqueueBackup({ workspaceId: WS, nodeId: randomUUID(), markdown: "x", message: "m" });

    const seen: OutboxEffectKind[] = [];
    const first = await drainOutbox({ workspaceId: WS, perform: async (k) => { seen.push(k); } });
    expect(first.done).toBe(2); // git_commit + github_backup
    expect(seen.length).toBe(2);

    // Re-drain immediately: nothing pending/due → no further performs.
    const second = await drainOutbox({ workspaceId: WS, perform: async (k) => { seen.push(k); } });
    expect(second.done + second.retried + second.dead).toBe(0);
    expect(seen.length).toBe(2); // still exactly two — no double delivery

    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);
  });
});
