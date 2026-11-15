// resolveOrCreateTagPath must be idempotent under concurrency. Two parallel
// resolves of the SAME path both miss the per-segment lookup and both INSERT,
// tripping the (workspace,parent,title) unique index with 23505; that used to
// propagate as an unhandled 500 (M7). The loser must instead adopt the winner.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { resolveOrCreateTagPath } from "../services/tagHierarchy.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("resolveOrCreateTagPath is idempotent under concurrency (M7)", () => {
  let WS = "";
  const stamp = Date.now();
  const actor: ActorCtx = { id: "rpc-admin", name: "RPC Admin", role: "admin", type: "human" };

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(actor, await persistActor(WS, actor));
  });

  it("N parallel resolves of the same path all succeed and converge on ONE leaf (no 500, no duplicates)", async () => {
    const a = `rpc-A-${stamp}`;
    const b = `rpc-B-${stamp}`;
    const path = `${a}/${b}`;

    // Fire many identical resolves at once: they race on each segment's INSERT.
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => resolveOrCreateTagPath(WS, path, actor)),
    );

    // The race must NOT surface as a rejection (the bug: 23505 → unhandled 500).
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected, `no resolve may reject: ${rejected.map((r) => (r as PromiseRejectedResult).reason?.message).join("; ")}`).toHaveLength(0);

    // Every resolve converged on the SAME leaf id.
    const leaves = new Set(
      results.map((r) => (r as PromiseFulfilledResult<{ leafId: string }>).value.leafId),
    );
    expect(leaves.size, "all resolves return the same leaf").toBe(1);

    // Exactly one node per segment name — the unique index held, no fork.
    const counts = await q<{ title: string; n: string }>(
      `SELECT title, count(*) AS n FROM content_nodes
        WHERE workspace_id=$1 AND node_type='class_tag' AND deleted_at IS NULL AND title = ANY($2::text[])
        GROUP BY title`,
      [WS, [a, b]],
    );
    const byTitle = Object.fromEntries(counts.rows.map((r) => [r.title, r.n]));
    expect(byTitle[a], "exactly one A segment").toBe("1");
    expect(byTitle[b], "exactly one B segment").toBe("1");
    // This checks all 50 serialized outcomes, not a 5-second throughput SLA.
    // Allow a single-CPU test database to finish without reducing concurrency.
  }, 15_000);

  it("a later resolve of the same path is a pure lookup (idempotent, returns the same leaf)", async () => {
    const path = `rpc-A-${stamp}/rpc-B-${stamp}`;
    const first = await resolveOrCreateTagPath(WS, path, actor);
    const second = await resolveOrCreateTagPath(WS, path, actor);
    expect(second.leafId).toBe(first.leafId);
    expect(second.created, "nothing new created on re-resolve").toEqual([]);
  });
});
