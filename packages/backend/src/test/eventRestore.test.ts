// Unit tests for ER6 restoreEvent.
//
// Approach: mock pool.query + event() to assert (a) the right inverse SQL
// fires, (b) the right new event is emitted with the right tx_meta, (c)
// each guard returns the correct error code. Real PG behaviour
// (transactions, FK cascades) is covered by the ER8 integration pass.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorCtx } from "../types.js";

// These inverse-operation fixtures mock authorization and DB rows. Persisted
// authority refresh is tested separately in actorWriteAuthority integration.
// Write stamps (spine/stamps.ts) need the real node table; this file stands in for the database.
vi.mock("../spine/stamps.js", () => ({ stampTransaction: async () => {}, countWritesWithoutStamp: async () => 0 }));
vi.mock("../spine/currentActor.js", () => ({
  resolveCurrentActor: async (actor: ActorCtx) => actor,
}));
import type { Authority } from "../spine/authority.js";
import { makeInversePatch } from "../services/eventLog/bodyPatch.js";

const actor: ActorCtx = { id: "restore-admin", name: "Restore admin", role: "admin", type: "human" };
const options = { actor, workspaceId: "ws-1" };
const assertAuthority = vi.fn(async (_actor: ActorCtx, _authority: Authority) => {});
// only the check is replaced; every other export (writesAsPerson, ...) stays real, so a new export does not break this file
vi.mock("../spine/authority.js", async (original) => ({ ...await original<typeof import("../spine/authority.js")>(), assertAuthority }));
vi.mock("../services/policyTags.js", () => ({ anyPolicyTag: vi.fn(async () => false), subtreeHasPolicyTag: vi.fn(async () => false) }));
// The old -> new id lookup (migration 201) is its own table and has its own test (derivedIdsHistory); here the restore logic runs on mocked rows.
vi.mock("../services/idRewrites.js", () => ({ followIdRewrites: async <T,>(row: T) => row }));
// The tree rules of a move are nodeTree.assertReparent's (against a real
// database in reparentRules.integration.test.ts); here only how restore
// answers its refusals.
const assertReparent = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../services/nodeTree.js", async (original) => ({ ...await original<typeof import("../services/nodeTree.js")>(), assertReparent }));
vi.mock("../spine/eventTransaction.js", () => ({
  withEventTransaction: async <T,>(_workspaceId: string, fn: () => Promise<T>): Promise<T> => fn(),
}));

const queries: Array<{ sql: string; params: unknown[] }> = [];
type Row = Record<string, unknown>;
type QueryResult<T extends Row = Row> = { rows: T[]; rowCount: number };

let resultQueue: QueryResult[] = [];
const poolQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
  queries.push({ sql, params });
  return resultQueue.shift() ?? { rows: [], rowCount: 0 };
});

const eventCalls: Array<{
  workspaceId: string;
  type: string;
  targetId: string;
  payload?: Record<string, unknown>;
  options?: { txMeta?: Record<string, unknown>; triggeredBy?: string };
  returnedId: string;
  actorType?: string;
  actorId?: string;
}> = [];
let nextEventId = 500;
const eventFn = vi.fn(async (
  workspaceId: string, type: string, _tt: string, targetId: string,
  payload?: Record<string, unknown>, _at?: string, _aid?: string,
  options?: { txMeta?: Record<string, unknown>; triggeredBy?: string },
): Promise<string> => {
  const id = String(nextEventId++);
  eventCalls.push({ workspaceId, type, targetId, payload, options, returnedId: id, actorType: _at, actorId: _aid });
  return id;
});

vi.mock("../db.js", () => ({
  pool: { query: poolQuery },
  queryOnSeparateConnection: poolQuery,
  event: eventFn,
  withTransaction: async <T,>(fn: () => Promise<T>): Promise<T> => fn(),
  q: poolQuery,
  inTransaction: () => true,
  requireTransaction: () => {},
  bumpMembershipEpoch: async (): Promise<void> => {}, // membership epoch bump (no-op in this unit test)
}));

const { restoreEvent } = await import("../services/eventRestore/index.js");
const { ReparentError } = await import("../services/nodeTree.js");

beforeEach(() => {
  queries.length = 0;
  eventCalls.length = 0;
  resultQueue = [];
  nextEventId = 500;
  poolQuery.mockClear();
  eventFn.mockClear();
  assertAuthority.mockReset();
  assertReparent.mockReset();
});

// Helper: prime the initial SELECT-event-by-id result.
function primeEvent(row: Partial<{
  id: string; workspace_id: string; event_type: string;
  target_type: string; target_id: string;
  payload: Record<string, unknown>;
  tx_meta: Record<string, unknown>;
  external: boolean;
}>) {
  resultQueue.push({
    rows: [{
      id: "1",
      workspace_id: "ws-1",
      event_type: "NODE_DELETED",
      target_type: "node",
      target_id: "n-1",
      payload: {},
      tx_meta: {},
      external: false,
      ...row,
    }],
    rowCount: 1,
  });
}

describe("ER6 restoreEvent — guards", () => {
  it("returns not_found when the event doesn't exist", async () => {
    resultQueue.push({ rows: [], rowCount: 0 });
    const result = await restoreEvent("99", options);
    expect(result).toMatchObject({ code: "not_found", status: 404 });
  });

  it("returns external when the event is external=true", async () => {
    primeEvent({ external: true });
    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ code: "external", status: 409 });
    expect(eventFn).not.toHaveBeenCalled();
  });

  it("returns irreversible for NODE_PURGED", async () => {
    primeEvent({ event_type: "NODE_PURGED" });
    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ code: "irreversible", status: 410 });
  });

  it("returns unsupported for unrecognised event_type", async () => {
    primeEvent({ event_type: "WORKSPACE_SETTING_CHANGED" });
    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ code: "unsupported", status: 422 });
  });
});

describe("restore authorization follows the inverse operation", () => {
  it.each([
    ["NODE_CREATED", {}, "delete_node"],
    ["NODE_UNDELETED", {}, "delete_node"],
    ["NODE_DELETED", {}, "write_node"],
    ["ATTRIBUTE_SET", { inverse_op: "attribute.deleted" }, "delete_attribute"],
    ["ATTRIBUTE_SET", { inverse_op: "attribute.set" }, "set_attribute"],
    ["ATTRIBUTE_DELETED", {}, "set_attribute"],
  ] as const)("%s requires %s", async (eventType, txMeta, operation) => {
    primeEvent({ event_type: eventType, tx_meta: txMeta, external: true });
    await restoreEvent("1", options);
    expect(assertAuthority).toHaveBeenCalledWith(actor, { kind: "retained_node", nodeId: "n-1", op: operation });
    expect(eventCalls).toHaveLength(0);
  });

  it.each([["TAG_APPLIED", "remove"], ["TAG_REMOVED", "apply"]] as const)(
    "%s also checks the tag's %s policy and scope", async (eventType, operation) => {
      primeEvent({ event_type: eventType, payload: { tag_id: "protected-tag" }, external: true });
      await restoreEvent("1", options);
      expect(assertAuthority).toHaveBeenCalledWith(actor, { kind: "tag", tagId: "protected-tag", op: operation });
    },
  );

  it("does not run an inverse when its actual operation is denied", async () => {
    primeEvent({ event_type: "NODE_CREATED" });
    assertAuthority.mockImplementation(async (_actor, authority) => {
      if (authority.kind === "retained_node" && authority.op === "delete_node") throw new Error("delete denied");
    });
    await expect(restoreEvent("1", options)).rejects.toThrow("delete denied");
    expect(queries).toHaveLength(1);
    expect(eventCalls).toHaveLength(0);
  });

  it("attributes restore events to the trusted actor context", async () => {
    primeEvent({ event_type: "NODE_CREATED" });
    resultQueue.push({ rows: [{ deleted_at: null, title: "Created" }], rowCount: 1 });
    const agent: ActorCtx = { ...actor, id: "authorized-agent", type: "agent" };
    await restoreEvent("1", { ...options, actor: agent });
    expect(eventCalls[0]).toMatchObject({ actorType: "ai_agent", actorId: "authorized-agent" });
  });

  it("restore-as-new needs source read access and the ordinary creation authority", async () => {
    primeEvent({ event_type: "NODE_UPDATED", external: true });
    await restoreEvent("1", { ...options, as_new_node: true });
    expect(assertAuthority).toHaveBeenCalledWith(actor, { kind: "retained_node", nodeId: "n-1", op: "read" });
    expect(assertAuthority).toHaveBeenCalledWith(actor, { kind: "any_space_write" });
  });

  it("restore-as-new cannot turn another event type into a destructive inverse", async () => {
    primeEvent({ event_type: "NODE_CREATED" });
    expect(await restoreEvent("1", { ...options, as_new_node: true, cascade: true })).toMatchObject({ code: "unsupported" });
    expect(queries).toHaveLength(1);
    expect(eventCalls).toHaveLength(0);
  });

  it("an unprovable historical copy refuses before cascade or source writes", async () => {
    primeEvent({ event_type: "NODE_UPDATED", tx_meta: { prev_field_values: { title: "Previous title" } } });
    resultQueue.push({ rows: [{ id: "n-1" }], rowCount: 1 });
    expect(await restoreEvent("1", { ...options, as_new_node: true, cascade: true })).toMatchObject({
      code: "history_incomplete", status: 409,
    });
    expect(queries.some(({ sql }) => sql.includes("WITH RECURSIVE chain") || sql.includes("UPDATE content_nodes"))).toBe(false);
    expect(eventCalls).toHaveLength(0);
  });
});

describe("ER6 restoreEvent — NODE_DELETED", () => {
  it("undeletes the node + emits NODE_UNDELETED with restored_from", async () => {
    primeEvent({ event_type: "NODE_DELETED", target_id: "n-1" });
    // Idempotency probe: node row, deleted_at non-null.
    resultQueue.push({ rows: [{ deleted_at: "2026-06-05T00:00:00Z", title: "Trashed" }], rowCount: 1 });
    // restoreLive's plan: no deleted note above it, none deleted with it (the note's row and stamp are not found: nothing comes with it);
    // then no note left behind (nodeTrash.ts markLeftBehind).
    resultQueue.push({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }, { rows: [], rowCount: 0 });
    // markLive reads the row its slug follows (the slug lookups and the UPDATE
    // then get the empty default).
    resultQueue.push({ rows: [{ id: "n-1", title: "Trashed", node_type: "content", slug: "trashed", reserved_key: null }], rowCount: 1 });

    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({
      restored: true,
      original_event_id: "1",
      restore_event_type: "NODE_UNDELETED",
    });
    const emitted = eventCalls.find((e) => e.type === "NODE_UNDELETED");
    expect(emitted?.options?.triggeredBy).toBe("1");
    expect(emitted?.options?.txMeta).toMatchObject({
      inverse_op: "node.deleted",
      restored_from: "1",
      ui_context: "event.restore",
    });
    const sql = queries.map((q) => q.sql).join(" || ");
    expect(sql).toMatch(/SET deleted_at = NULL/);
  });

  it("refuses when node is already live (already_in_state)", async () => {
    primeEvent({ event_type: "NODE_DELETED" });
    resultQueue.push({ rows: [{ deleted_at: null, title: "Live" }], rowCount: 1 });
    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ code: "already_in_state", status: 409 });
    expect(eventFn).not.toHaveBeenCalled();
  });

  it("returns target_gone when the node row was purged", async () => {
    primeEvent({ event_type: "NODE_DELETED" });
    resultQueue.push({ rows: [], rowCount: 0 });
    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ code: "target_gone", status: 410 });
  });
});

describe("ER6 restoreEvent — NODE_CREATED inverse = soft delete", () => {
  it("soft-deletes the node", async () => {
    primeEvent({ event_type: "NODE_CREATED" });
    resultQueue.push({ rows: [{ deleted_at: null, title: "Created" }], rowCount: 1 });
    resultQueue.push({ rows: [], rowCount: 1 });
    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ restore_event_type: "NODE_DELETED" });
    const sql = queries.map((q) => q.sql).join(" || ");
    expect(sql).toMatch(/SET\s+deleted_at = now\(\)/);
  });
});

describe("ER6 restoreEvent — NODE_UPDATED body revert", () => {
  it("reverts a legacy event (no post blob) while the body is still the one it left", async () => {
    primeEvent({
      event_type: "NODE_UPDATED",
      target_id: "n-1",
      payload: { title: "New title" },
      tx_meta: {
        inverse_patch: makeInversePatch("Hello world", "Hello WORLD"),
        prev_field_values: { title: "Old title" },
      },
    });
    resultQueue.push({
      rows: [{ title: "New title", markdown: "Hello WORLD", deleted_at: null }],
      rowCount: 1,
    });
    // UPDATE result
    resultQueue.push({ rows: [], rowCount: 1 });

    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ restored: true, restore_event_type: "NODE_UPDATED" });
    const updateCall = queries.find((q) => q.sql.includes("UPDATE content_nodes"));
    expect(updateCall?.params[2]).toBe("Old title");
    // The slug follows the title in the same UPDATE (applyNodeColumns), then the body.
    expect(updateCall?.params[3]).toBe("old-title");
    expect(updateCall?.params[4]).toBe("Hello world");
  });

  // D79: with no post body there is nothing to merge against; patch_apply on
  // the changed body was the fuzzy revert that overwrote later edits.
  it("refuses a legacy event once the body changed, even with force (history_incomplete)", async () => {
    primeEvent({
      event_type: "NODE_UPDATED",
      tx_meta: {
        inverse_patch: makeInversePatch("Hello world", "Hello WORLD"),
        prev_field_values: { title: "T" },
      },
    });
    resultQueue.push({
      rows: [{ title: "T", markdown: "Hello WORLD!", deleted_at: null }],
      rowCount: 1,
    });
    const result = await restoreEvent("1", { ...options, force: true });
    expect(result).toMatchObject({ code: "history_incomplete", status: 409, force_available: false });
    expect(eventFn).not.toHaveBeenCalled();
  });

  it("refuses a body conflict without force (patch_conflict), merging against the event's post blob", async () => {
    const post = "Shopping list:\n- 買豆漿 today\n- eggs\n";
    primeEvent({
      event_type: "NODE_UPDATED",
      payload: { body_hash: "h-post" },
      tx_meta: {
        inverse_patch: makeInversePatch("Shopping list:\n- 買牛奶 today\n- eggs\n", post),
        prev_field_values: {},
      },
    });
    resultQueue.push({
      rows: [{ title: "T", markdown: "Shopping list:\n- 買咖啡 today\n- eggs\n", deleted_at: null }],
      rowCount: 1,
    });
    resultQueue.push({ rows: [], rowCount: 0 }); // no prior restore
    resultQueue.push({ rows: [{ content: post }], rowCount: 1 }); // the event's post blob
    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ code: "patch_conflict", status: 409, force_available: true });
    expect(queries.some(({ sql, params }) => sql.includes("FROM blobs") && params[0] === "h-post")).toBe(true);
    expect(eventFn).not.toHaveBeenCalled();
  });

  it("returns target_gone when node is currently soft-deleted", async () => {
    primeEvent({ event_type: "NODE_UPDATED", tx_meta: { inverse_patch: "", prev_field_values: {} } });
    resultQueue.push({
      rows: [{ title: "X", markdown: "", deleted_at: "2026-06-05T00:00:00Z" }],
      rowCount: 1,
    });
    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ code: "target_gone", status: 410 });
  });
});

describe("node restore preserves edits outside its inverse", () => {
  it("rejects a later title edit instead of silently overwriting it", async () => {
    primeEvent({ event_type: "NODE_UPDATED", payload: { title: "B" }, tx_meta: { prev_field_values: { title: "A" } } });
    resultQueue.push({ rows: [{ title: "C", markdown: "latest body", deleted_at: null }], rowCount: 1 });
    expect(await restoreEvent("1", options)).toMatchObject({ code: "patch_conflict", force_available: true });
    expect(eventCalls).toHaveLength(0);
    expect(queries.some(({ sql }) => sql.includes("UPDATE content_nodes"))).toBe(false);
  });

  it("an explicit force restores the title without writing unrelated body or parent fields", async () => {
    primeEvent({ event_type: "NODE_UPDATED", payload: { title: "B" }, tx_meta: { prev_field_values: { title: "A" } } });
    resultQueue.push({ rows: [{ title: "C", markdown: "latest body", deleted_at: null }], rowCount: 1 });
    expect(await restoreEvent("1", { ...options, force: true })).toMatchObject({ restored: true });
    const update = queries.find(({ sql }) => sql.includes("UPDATE content_nodes"))!;
    expect(update.params).toEqual(["ws-1", "n-1", "A", "a"]); // the title and the slug that follows it
    expect(update.sql).not.toMatch(/markdown =|parent_id =/);
    expect(eventCalls[0].options?.txMeta?.prev_field_values).toEqual({ title: "C" });
  });

  it("restores a presentation field that ordinary PATCH records", async () => {
    primeEvent({ event_type: "NODE_UPDATED", payload: { hidden: true }, tx_meta: { prev_field_values: { hidden: false } } });
    resultQueue.push({ rows: [{ title: "Latest title", markdown: "latest body", hidden: true, deleted_at: null }], rowCount: 1 });
    expect(await restoreEvent("1", options)).toMatchObject({ restored: true });
    const update = queries.find(({ sql }) => sql.includes("UPDATE content_nodes"))!;
    expect(update.params).toEqual(["ws-1", "n-1", false]);
    expect(update.sql).toContain("hidden = $3");
    expect(eventCalls[0].options?.txMeta?.prev_field_values).toEqual({ hidden: true });
  });

  it("a body-only undo leaves a later title out of both the write and redo metadata", async () => {
    primeEvent({ event_type: "NODE_UPDATED", tx_meta: { inverse_patch: makeInversePatch("old body", "new body"), prev_field_values: {} } });
    resultQueue.push({ rows: [{ title: "Later title", markdown: "new body", deleted_at: null }], rowCount: 1 });
    expect(await restoreEvent("1", options)).toMatchObject({ restored: true });
    const update = queries.find(({ sql }) => sql.includes("UPDATE content_nodes"))!;
    expect(update.params).toEqual(["ws-1", "n-1", "old body"]);
    expect(update.sql).not.toContain("title =");
    expect(eventCalls[0].options?.txMeta?.prev_field_values).toEqual({});
  });

  it("does not report successful restore for an unsupported historical field", async () => {
    primeEvent({ event_type: "NODE_UPDATED", tx_meta: { prev_field_values: { unknown_legacy_field: true } } });
    expect(await restoreEvent("1", options)).toMatchObject({ code: "unsupported" });
    expect(eventCalls).toHaveLength(0);
  });

  it("force cannot move a node underneath one of its descendants", async () => {
    primeEvent({ event_type: "NODE_UPDATED", payload: { parent_id: "new-parent" }, tx_meta: { prev_field_values: { parent_id: "old-parent" } } });
    resultQueue.push(
      { rows: [{ title: "Node", markdown: "body", parent_id: "new-parent", node_type: "content", deleted_at: null }], rowCount: 1 },
      { rows: [], rowCount: 0 }, // no prior restore
    );
    assertReparent.mockRejectedValueOnce(new ReparentError("parent_cycle", 400, "cannot move a node under its own descendant"));
    expect(await restoreEvent("1", { ...options, force: true })).toMatchObject({
      code: "state_conflict", status: 409, reason: "parent_cycle", detail: expect.stringContaining("cycle"),
    });
    expect(assertReparent).toHaveBeenCalledWith("ws-1", { id: "n-1", node_type: "content", title: "Node", parent_id: "new-parent" }, "old-parent", actor);
    expect(eventCalls).toHaveLength(0);
  });

  it("a previous parent that is gone answers target_gone", async () => {
    primeEvent({ event_type: "NODE_UPDATED", payload: { parent_id: "new-parent" }, tx_meta: { prev_field_values: { parent_id: "old-parent" } } });
    resultQueue.push(
      { rows: [{ title: "Node", markdown: "body", parent_id: "new-parent", node_type: "content", deleted_at: null }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    );
    assertReparent.mockRejectedValueOnce(new ReparentError("parent_not_found", 404, "parent not found"));
    expect(await restoreEvent("1", options)).toMatchObject({ code: "target_gone", status: 410 });
    expect(eventCalls).toHaveLength(0);
  });
});

describe("ER6 restoreEvent — TAG_APPLIED / TAG_REMOVED", () => {
  it("removes the tag when restoring TAG_APPLIED", async () => {
    primeEvent({
      event_type: "TAG_APPLIED",
      payload: { tag_id: "11111111-1111-4111-8111-111111111111", tag_name: "work", membership_change: { before_state_id: "22222222-2222-4222-8222-222222222222", after_state_id: "33333333-3333-4333-8333-333333333333" } },
    });
    // tag presence probe
    resultQueue.push({ rows: [{ is_applied: true, state_id: "33333333-3333-4333-8333-333333333333" }], rowCount: 1 });
    resultQueue.push({ rows: [], rowCount: 1 });

    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ restore_event_type: "TAG_REMOVED" });
    const sql = queries.map((q) => q.sql).join(" || ");
    expect(sql).toMatch(/DELETE FROM node_tags/);
    const emitted = eventCalls.find((e) => e.type === "TAG_REMOVED");
    expect(emitted?.options?.txMeta).toMatchObject({ restored_from: "1" });
  });

  it("re-applies the tag when restoring TAG_REMOVED", async () => {
    primeEvent({
      event_type: "TAG_REMOVED",
      payload: { tag_id: "11111111-1111-4111-8111-111111111111", tag_name: "work", membership_change: { before_state_id: "22222222-2222-4222-8222-222222222222", after_state_id: "33333333-3333-4333-8333-333333333333" } },
    });
    // current absent state
    resultQueue.push({ rows: [{ is_applied: false, state_id: "33333333-3333-4333-8333-333333333333" }], rowCount: 1 });
    resultQueue.push({ rows: [], rowCount: 1 });

    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ restore_event_type: "TAG_APPLIED" });
    const sql = queries.map((q) => q.sql).join(" || ");
    expect(sql).toMatch(/INSERT INTO node_tags/);
  });

  it("refuses already_in_state for TAG_APPLIED on un-tagged node", async () => {
    primeEvent({ event_type: "TAG_APPLIED", payload: { tag_id: "11111111-1111-4111-8111-111111111111" } });
    resultQueue.push({ rows: [], rowCount: 0 });
    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ code: "already_in_state", status: 409 });
  });

  it("refuses incomplete TAG_APPLIED history without treating it as skippable", async () => {
    primeEvent({ event_type: "TAG_APPLIED", payload: {}, tx_meta: {} });
    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ code: "history_incomplete", status: 409 });
  });
});

describe("ER6 restoreEvent — ATTRIBUTE_SET", () => {
  it("when inverse_op=attribute.deleted: DELETEs the attribute", async () => {
    primeEvent({
      event_type: "ATTRIBUTE_SET",
      payload: { key: "priority", value: "high", value_type: "text", is_inheritable: false, source: "ui" },
      tx_meta: { inverse_op: "attribute.deleted", prev_field_values: { value: null } },
    });
    resultQueue.push({ rows: [{ value: "high", value_type: "text", is_inheritable: false, source: "ui" }], rowCount: 1 });

    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ restore_event_type: "ATTRIBUTE_DELETED" });
    const sql = queries.map((q) => q.sql).join(" || ");
    expect(sql).toMatch(/DELETE FROM node_attributes/);
  });

  it("when inverse_op=attribute.set: re-sets the prev value", async () => {
    primeEvent({
      event_type: "ATTRIBUTE_SET",
      payload: { key: "priority", value: "high", value_type: "text", is_inheritable: false, source: "ui" },
      tx_meta: { inverse_op: "attribute.set", prev_field_values: { value: "low", value_type: "text", is_inheritable: false, source: "ui" } },
    });
    // current value lookup
    resultQueue.push({ rows: [{ value: "high", value_type: "text", is_inheritable: false, source: "ui" }], rowCount: 1 });
    // upsert
    resultQueue.push({ rows: [], rowCount: 1 });

    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ restore_event_type: "ATTRIBUTE_SET" });
    const upsert = queries.find((q) => q.sql.includes("INSERT INTO node_attributes"));
    expect(upsert?.params[3]).toBe("low");
    // The restore event records the just-overwritten "high" as the new prev.
    const emitted = eventCalls.find((e) => e.type === "ATTRIBUTE_SET");
    expect(emitted?.options?.txMeta).toMatchObject({
      prev_field_values: { value: "high" },
      restored_from: "1",
    });
  });
});

describe("ER6 restoreEvent — ATTRIBUTE_DELETED", () => {
  it("re-INSERTs the attribute from prev_field_values", async () => {
    primeEvent({
      event_type: "ATTRIBUTE_DELETED",
      payload: { key: "status" },
      tx_meta: { prev_field_values: { value: "doing", value_type: "text", is_inheritable: false, source: "ui" } },
    });
    // not currently set
    resultQueue.push({ rows: [], rowCount: 0 });
    resultQueue.push({ rows: [], rowCount: 1 });

    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ restore_event_type: "ATTRIBUTE_SET" });
    const insert = queries.find((q) => q.sql.includes("INSERT INTO node_attributes"));
    expect(insert?.params[3]).toBe("doing");
    expect(insert?.params[4]).toBe("text");
  });

  it("refuses when attribute is already set (already_in_state)", async () => {
    primeEvent({
      event_type: "ATTRIBUTE_DELETED",
      payload: { key: "status" },
      tx_meta: { prev_field_values: { value: "doing", value_type: "text", is_inheritable: false, source: "ui" } },
    });
    resultQueue.push({ rows: [{ value: "doing", value_type: "text", is_inheritable: false, source: "ui" }], rowCount: 1 });
    const result = await restoreEvent("1", options);
    expect(result).toMatchObject({ code: "already_in_state", status: 409 });
  });
});
