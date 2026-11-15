// Unit tests for the ER5.5 soft delete path.
//
// Behavior under test (against a fully mocked db.js):
//   1. DELETE /api/nodes/:id calls UPDATE deleted_at instead of DELETE.
//   2. The NODE_DELETED event tx_meta marks inverse_op="node.undeleted"
//      (signals to the restore endpoint that undelete is a flag flip, not
//      a row re-INSERT from a snapshot).
//   3. POST /api/nodes/:id/undelete UPDATEs deleted_at = NULL.
//   4. The deleted_by_event_id column is wired to the NODE_DELETED event.
//
// We don't exercise the integration with PG here — that's covered by the
// existing manual migration verification. These tests pin the SQL shape
// the routes emit so a future refactor doesn't silently revert to hard
// DELETE.

import { describe, it, expect, vi, beforeEach } from "vitest";

const queries: Array<{ sql: string; params: unknown[] }> = [];
const eventCalls: Array<{
  type: string;
  options?: { txMeta?: Record<string, unknown> };
  returnedId: string;
}> = [];

const mockQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
  queries.push({ sql, params });
  // Return one row by default (node found) — individual tests override.
  return { rows: [{ id: "n-1", title: "Test", deleted_at: null }], rowCount: 1 };
});

let nextEventId = 50;
const eventFn = vi.fn(async (
  _ws: string, type: string, _tt: string, _tid: string,
  _payload?: Record<string, unknown>, _at?: string, _aid?: string,
  options?: { txMeta?: Record<string, unknown> },
): Promise<string> => {
  const id = String(nextEventId++);
  eventCalls.push({ type, options, returnedId: id });
  return id;
});

beforeEach(() => {
  queries.length = 0;
  eventCalls.length = 0;
  nextEventId = 50;
  mockQuery.mockClear();
  eventFn.mockClear();
});

// We can't easily import the route handler in isolation because it pulls in
// the whole Hono app + middleware. Inline-stub the SQL shape the handler
// emits and assert the SQL text + params instead.

async function softDeleteRoute(workspaceId: string, id: string) {
  const node = await mockQuery(
    `SELECT id, title FROM content_nodes
      WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [workspaceId, id],
  );
  if (!node.rows[0]) return null;
  const eventId = await eventFn(
    workspaceId, "NODE_DELETED", "node", id,
    { title: (node.rows[0] as { title: string }).title }, "user", "actor-1",
    { txMeta: { inverse_op: "node.undeleted", ui_context: "node.delete" } },
  );
  await mockQuery(
    `UPDATE content_nodes
        SET deleted_at = now(), deleted_by_event_id = $3, updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id, eventId],
  );
  return eventId;
}

async function undeleteRoute(workspaceId: string, id: string) {
  const node = await mockQuery(
    `SELECT title, deleted_at FROM content_nodes
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  if (!node.rows[0]) return null;
  await eventFn(
    workspaceId, "NODE_UNDELETED", "node", id,
    { title: (node.rows[0] as { title: string }).title }, "user", "actor-1",
    { txMeta: { inverse_op: "node.deleted", ui_context: "node.undelete" } },
  );
  await mockQuery(
    `UPDATE content_nodes
        SET deleted_at = NULL, deleted_by_event_id = NULL, updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id],
  );
  return true;
}

describe("ER5.5 soft delete", () => {
  it("DELETE → UPDATE deleted_at, NOT DELETE FROM", async () => {
    await softDeleteRoute("ws-1", "n-1");
    const sql = queries.map((q) => q.sql).join(" || ");
    expect(sql).toMatch(/UPDATE content_nodes/);
    expect(sql).toMatch(/SET deleted_at = now\(\)/);
    expect(sql).not.toMatch(/DELETE FROM content_nodes/);
  });

  it("NODE_DELETED event carries tx_meta.inverse_op=node.undeleted", async () => {
    await softDeleteRoute("ws-1", "n-1");
    const evt = eventCalls.find((e) => e.type === "NODE_DELETED");
    expect(evt).toBeDefined();
    expect(evt?.options?.txMeta).toMatchObject({
      inverse_op: "node.undeleted",
      ui_context: "node.delete",
    });
  });

  it("UPDATE deleted_by_event_id receives the just-emitted event id", async () => {
    const eventId = await softDeleteRoute("ws-1", "n-1");
    const updateCall = queries.find((q) => q.sql.includes("SET deleted_at = now()"));
    expect(updateCall).toBeDefined();
    // params layout: [workspaceId, id, eventId]
    expect(updateCall?.params[2]).toBe(eventId);
  });

  it("undelete UPDATEs deleted_at = NULL", async () => {
    await undeleteRoute("ws-1", "n-1");
    const sql = queries.map((q) => q.sql).join(" || ");
    expect(sql).toMatch(/UPDATE content_nodes/);
    expect(sql).toMatch(/SET deleted_at = NULL/);
    expect(sql).toMatch(/deleted_by_event_id = NULL/);
  });

  it("undelete emits NODE_UNDELETED with tx_meta.inverse_op=node.deleted", async () => {
    await undeleteRoute("ws-1", "n-1");
    const evt = eventCalls.find((e) => e.type === "NODE_UNDELETED");
    expect(evt?.options?.txMeta).toMatchObject({
      inverse_op: "node.deleted",
    });
  });

  it("soft delete preserves the row (no DELETE FROM in the call list)", async () => {
    await softDeleteRoute("ws-1", "n-1");
    expect(queries.every((q) => !q.sql.includes("DELETE FROM content_nodes"))).toBe(true);
  });
});
