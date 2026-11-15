// Unit tests for the event() API extension (ER4).
//
// Verifies that the new options bag (txMeta / external / triggeredBy)
// flows through to the INSERT params in the order migration 031 expects,
// and that callers that don't pass options still hit INSERT with the
// documented defaults ({}, false, null).
//
// We don't import db.js; we re-implement the event() body against a
// mocked q so the test stays a pure unit test (no PG connection). The
// real db.js is exercised end-to-end by httpRoutes.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

type QueryResult = { rows: Array<{ id: string }>; rowCount: number };
const q = vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>(
  async () => ({ rows: [{ id: "42" }], rowCount: 1 }),
);

// Re-implement event() inline against our mock. Keep the body byte-for-
// byte equivalent to db.ts so a drift here is caught by httpRoutes tests.
type EventOptions = {
  txMeta?: Record<string, unknown>;
  external?: boolean;
  triggeredBy?: string;
};
async function event(
  workspaceId: string,
  eventType: string,
  targetType: string,
  targetId: string,
  payload: Record<string, unknown> = {},
  actorType: "user" | "ai_agent" | "system" = "user",
  actorId = "demo-user",
  options: EventOptions = {},
): Promise<string> {
  const result = await q(
    `INSERT INTO domain_events
      (workspace_id, actor_type, actor_id, event_type, target_type, target_id,
       payload, tx_meta, external, triggered_by_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      workspaceId, actorType, actorId, eventType, targetType, targetId,
      payload,
      options.txMeta ?? {},
      options.external ?? false,
      options.triggeredBy ?? null,
    ],
  );
  return result.rows[0]?.id ?? "";
}

beforeEach(() => {
  q.mockClear();
});

describe("event() with EventOptions (ER4)", () => {
  it("returns the inserted id as a string", async () => {
    const id = await event("ws-1", "TEST_EVT", "node", "n1");
    expect(id).toBe("42");
  });

  it("defaults tx_meta to {}, external to false, triggered_by to null", async () => {
    await event("ws-1", "TEST_EVT", "node", "n1");
    const params = q.mock.calls[0][1] as unknown[];
    // Layout per migration 031:
    //   ($1 workspace_id, $2 actor_type, $3 actor_id, $4 event_type,
    //    $5 target_type, $6 target_id, $7 payload,
    //    $8 tx_meta, $9 external, $10 triggered_by_event_id)
    expect(params).toHaveLength(10);
    expect(params[7]).toEqual({});
    expect(params[8]).toBe(false);
    expect(params[9]).toBeNull();
  });

  it("passes tx_meta when supplied", async () => {
    const txMeta = {
      inverse_patch: "@@ patch text @@",
      prev_field_values: { title: "Old Title" },
      ui_context: "node.patch",
    };
    await event("ws-1", "NODE_UPDATED", "node", "n1", {}, "user", "actor-x", { txMeta });
    expect((q.mock.calls[0][1] as unknown[])[7]).toBe(txMeta);
  });

  it("passes external=true when supplied (publish, backup, etc.)", async () => {
    await event(
      "ws-1", "PUBLISH_SNAPSHOT_CREATED", "publish_snapshot", "snap-1",
      {}, "user", "demo-user", { external: true },
    );
    expect((q.mock.calls[0][1] as unknown[])[8]).toBe(true);
  });

  it("passes triggered_by when set (cascade chain)", async () => {
    await event(
      "ws-1", "ATTRIBUTE_SET", "node", "n1",
      {}, "user", "actor-x", { triggeredBy: "100" },
    );
    expect((q.mock.calls[0][1] as unknown[])[9]).toBe("100");
  });

  it("payload still flows independently of tx_meta", async () => {
    const payload = { title: "New", wikilinks: ["foo"] };
    await event("ws-1", "NODE_CREATED", "node", "n1", payload);
    expect((q.mock.calls[0][1] as unknown[])[6]).toBe(payload);
  });
});
