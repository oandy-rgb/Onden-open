// node_event_meta (migration 130) is what bootstrap and the sync delta read for
// last_actor / last_modified_at / recent_actors. A trigger on domain_events
// keeps it current in the event's own transaction; this pins that and the
// request pool's statement_timeout.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { q, withTransaction } from "../db.js";
import { needsPostgresServer } from "./helpers/pgliteSkips.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("node_event_meta", () => {
  let ws = "";
  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Meta', $1) RETURNING id::text`, [`event-meta-${randomUUID()}`])).rows[0]!.id;
  });

  const append = (nodeId: string, actor: string, type: string, at: string, targetType = "node") =>
    q(`INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, created_at)
       VALUES ($1, 'user', $2, $3, $4, $5, $6)`, [ws, actor, type, targetType, nodeId, at]);
  const metaOf = async (nodeId: string) => (await q<{ actor_id: string; at: string }>(
    `SELECT actor_id, last_event_at::text AS at FROM node_event_meta WHERE node_id = $1 ORDER BY actor_id`, [nodeId])).rows;

  it("keeps the newest event time per note and actor, never moving back", async () => {
    const node = randomUUID();
    await append(node, "a", "NODE_UPDATED", "2026-01-02T00:00:00Z");
    await append(node, "a", "NODE_UPDATED", "2026-01-01T00:00:00Z");
    await append(node, "b", "NODE_CREATED", "2026-01-03T00:00:00Z");
    const rows = await metaOf(node);
    expect(rows.map((r) => r.actor_id)).toEqual(["a", "b"]);
    expect(rows[0]!.at).toContain("2026-01-02");
    expect(rows[1]!.at).toContain("2026-01-03");
  });

  it("ignores saved-view events and events about other targets", async () => {
    const node = randomUUID();
    await append(node, "a", "COLLECTION_VIEW_CREATED", "2026-01-01T00:00:00Z");
    await append(node, "a", "TAG_UPDATED", "2026-01-01T00:00:00Z", "collection_view");
    expect(await metaOf(node)).toEqual([]);
  });

  it("rolls back with the transaction that appended the event", async () => {
    const node = randomUUID();
    await expect(withTransaction(async () => {
      await append(node, "a", "NODE_UPDATED", "2026-01-01T00:00:00Z");
      expect(await metaOf(node)).toHaveLength(1);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect(await metaOf(node)).toEqual([]);
  });

  it("the migration's backfill matches what the trigger would have recorded", async () => {
    const node = randomUUID();
    await append(node, "a", "NODE_UPDATED", "2026-02-01T00:00:00Z");
    await append(node, "a", "NODE_UPDATED", "2026-02-05T00:00:00Z");
    await append(node, "b", "COLLECTION_VIEW_UPDATED", "2026-02-09T00:00:00Z");
    const backfilled = (await q(
      `SELECT actor_id, max(created_at)::text AS at FROM domain_events
        WHERE target_type = 'node' AND event_type NOT LIKE 'COLLECTION\\_VIEW\\_%' AND target_id = $1 GROUP BY actor_id`, [node])).rows;
    const kept = (await metaOf(node)).map((r) => ({ actor_id: r.actor_id, at: r.at }));
    expect(kept).toEqual(backfilled);
  });
});

describe.skipIf(!isTestDb)("request pool statement_timeout", () => {
  it.skipIf(needsPostgresServer)("cancels a statement that runs past the timeout, and migrations opt out per transaction", async () => {
    expect((await q<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0]!.statement_timeout).toBe("15s");
    await expect(withTransaction(async () => {
      await q("SET LOCAL statement_timeout = '50ms'");
      await q("SELECT pg_sleep(1)");
    })).rejects.toMatchObject({ code: "57014" });
    // LOCAL ended with that transaction.
    expect((await q<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0]!.statement_timeout).toBe("15s");
  });
});
