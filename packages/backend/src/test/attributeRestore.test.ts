import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventRow } from "../services/eventRestore/index.js";
import type { AttributeState } from "../services/eventLog/attributeSnapshot.js";
import { incomingWins } from "../spine/attributeSource.js";

const state = vi.hoisted(() => ({
  current: null as AttributeState | null,
  events: [] as EventRow[],
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  blobs: new Map<string, string>(),
  inTransaction: true,
  versions: [] as Array<{ sql: string; params: unknown[] }>, // the versions an undo of a drawing minted
  field: null as Record<string, unknown> | null, // the schema field governing "score", if any
}));

const attributeCommitted = vi.fn(async () => {});
// Write stamps (spine/stamps.ts) need the real node table; this file stands in for the database.
vi.mock("../spine/stamps.js", () => ({ stampTransaction: async () => {}, countWritesWithoutStamp: async () => 0 }));
vi.mock("../services/nodeCommits.js", () => ({ nodeAttributeCommitted: attributeCommitted }));
vi.mock("../spine/currentActor.js", () => ({ resolveCurrentActor: async (actor: unknown) => actor }));
vi.mock("../db.js", () => {
  // putBlob writes on its own connection (pool.query); both go through here.
  const query = async (sql: string, params: unknown[] = []) => {
    state.queries.push({ sql, params });
    // (the ink readers use Kysely, which writes the statement in lower case)
    if (sql.includes("SELECT content FROM blobs") || sql.includes('select "content" from "blobs"')) {
      const content = state.blobs.get(params[0] as string);
      return { rows: content === undefined ? [] : [{ content }], rowCount: content === undefined ? 0 : 1 };
    }
    // A drawing stored as chunks (inkChunks.ts): these tests keep every drawing whole in `blobs`, so there are none.
    if (sql.includes("FROM ink_manifests") || sql.includes('from "ink_manifests"')) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO blobs")) {
      state.blobs.set(params[0] as string, params[1] as string);
      return { rows: [], rowCount: 1 };
    }
    // fieldForKey: the node's tags, then every tag's field inputs (tagFields.ts).
    if (sql.includes("FROM node_tags nt")) {
      return { rows: state.field ? [{ id: "tag" }] : [], rowCount: state.field ? 1 : 0 };
    }
    if (sql.includes("tag_schema->'fields' AS fields")) {
      return { rows: state.field ? [{ id: "tag", parent_id: null, extends: [], fields: [state.field] }] : [], rowCount: state.field ? 1 : 0 };
    }
    if (sql.includes("SELECT value, value_type, is_inheritable, source FROM node_attributes")) {
      return { rows: state.current ? [{ ...state.current }] : [], rowCount: state.current ? 1 : 0 };
    }
    if (sql.includes("DELETE FROM node_attributes")) {
      const count = state.current ? 1 : 0;
      state.current = null;
      return { rows: [], rowCount: count };
    }
    if (sql.includes("INSERT INTO node_attributes")) {
      state.current = { value: params[3] as string, value_type: params[4] as string, is_inheritable: params[5] as boolean, source: params[6] as string };
      return { rows: [], rowCount: 1 };
    }
    // The undo of a drawing mints its version (spine/noteVersions.ts recordVersion; the real rules run in noteVersions.integration.test.ts).
    if (sql.includes("note_version_before_event")) return { rows: [{ key: null }], rowCount: 1 };
    if (sql.includes("note_version_in_scope")) return { rows: [{ scoped: true }], rowCount: 1 };
    if (sql.includes("note_version_exempt")) return { rows: [{ why: null }], rowCount: 1 };
    if (sql.includes("sync_stamp_current")) {
      state.versions.push({ sql, params });
      // minting selects the key and the stamp; the two inserts return nothing
      return sql.includes("INSERT INTO") ? { rows: [], rowCount: 1 } : { rows: [{ key: "s:o:1:1", origin: "o", seq: "1" }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO note_version_positions")) return { rows: [], rowCount: 1 };
    if (sql.includes("pg_advisory_xact_lock") || sql.includes("lock_timeout")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  };
  return {
  inTransaction: () => state.inTransaction,
  withSavepoint: <T>(fn: () => Promise<T>) => fn(),
  bumpMembershipEpoch: async () => {},
  q: query,
  pool: { query },
  queryOnSeparateConnection: query,
  event: async (
    workspace: string, eventType: string, targetType: string, targetId: string, payload: Record<string, unknown>,
    actorType: string, actorId: string, options: { txMeta: Record<string, unknown>; triggeredBy: string },
  ) => {
    const id = String(100 + state.events.length);
    state.events.push({ id, workspace_id: workspace, event_type: eventType, target_type: targetType, target_id: targetId, payload,
      tx_meta: options.txMeta, external: false, actor_type: actorType, actor_id: actorId, triggered_by_event_id: options.triggeredBy } as EventRow);
    return id;
  },
  };
});

const { restoreAttribute: restoreAttributeIn, previewAttributeRestore } = await import("../services/eventRestore/attributes.js");
const { runRestore } = await import("../spine/mutate.js");
const { encodeSnapshot } = await import("../services/eventLog/attributeSnapshot.js");
const actorCtx = { id: "restore-agent", name: "Restore agent", role: "admin", type: "agent" as const };
// The root restoreEvent opens: inverse events are written inside it.
const restoreAttribute = (row: EventRow) => runRestore({ actor: actorCtx, workspaceId: "workspace" }, () => restoreAttributeIn(row, actorCtx));
const before: AttributeState = { value: "1", value_type: "number", is_inheritable: true, source: "dispatcher" };
const after: AttributeState = { value: "2", value_type: "text", is_inheritable: false, source: "ui" };

function change(previous: AttributeState | null = before, next: AttributeState = after): EventRow {
  return {
    id: "1", workspace_id: "workspace", target_type: "node", target_id: "node", event_type: "ATTRIBUTE_SET", external: false,
    payload: { key: "score", ...next },
    tx_meta: { inverse_op: previous === null ? "attribute.deleted" : "attribute.set", prev_field_values: previous && { ...previous } },
  };
}
function deletion(previous: AttributeState = before): EventRow {
  return { ...change(), event_type: "ATTRIBUTE_DELETED", payload: { key: "score" }, tx_meta: { inverse_op: "attribute.set", prev_field_values: { ...previous } } };
}
function mutations() {
  return state.queries.filter(({ sql }) => /(?:INSERT INTO|DELETE FROM) node_attributes/.test(sql));
}

beforeEach(() => {
  state.field = null;
  state.current = { ...after };
  state.events.length = 0;
  state.queries.length = 0;
  state.versions.length = 0;
  state.blobs.clear();
  state.inTransaction = true;
});

describe("complete attribute inverse", () => {
  it("undo and redo preserve value, type, inheritance, and source priority", async () => {
    const result = await restoreAttribute(change());
    expect(result).toMatchObject({ restored: true, restore_event_type: "ATTRIBUTE_SET" });
    expect(state.current).toEqual(before);
    expect(incomingWins("frontmatter", state.current!.source)).toBe(true);
    expect(state.events[0]).toMatchObject({
      payload: { key: "score", ...before },
      tx_meta: { inverse_op: "attribute.set", prev_field_values: after, restored_from: "1" },
      actor_type: "ai_agent", actor_id: actorCtx.id, triggered_by_event_id: "1",
    });

    expect(await restoreAttribute(state.events[0])).toMatchObject({ restored: true });
    expect(state.current).toEqual(after);
    expect(incomingWins("frontmatter", state.current!.source)).toBe(false);
  });

  it("undoing creation deletes only the matching row, and redo restores every field", async () => {
    expect(await restoreAttribute(change(null))).toMatchObject({ restore_event_type: "ATTRIBUTE_DELETED" });
    expect(state.current).toBeNull();
    expect(state.events[0].tx_meta.prev_field_values).toEqual(after);
    expect(await restoreAttribute(state.events[0])).toMatchObject({ restore_event_type: "ATTRIBUTE_SET" });
    expect(state.current).toEqual(after);
    expect(state.events[1].tx_meta.prev_field_values).toBeNull();
  });

  it("restores a deletion and can undo the restore back to absence", async () => {
    state.current = null;
    expect(await restoreAttribute(deletion())).toMatchObject({ restore_event_type: "ATTRIBUTE_SET" });
    expect(state.current).toEqual(before);
    expect(state.events[0].tx_meta).toMatchObject({ inverse_op: "attribute.deleted", prev_field_values: null });
    expect(await restoreAttribute(state.events[0])).toMatchObject({ restore_event_type: "ATTRIBUTE_DELETED" });
    expect(state.current).toBeNull();
  });

  it("treats the empty string as a stored value, never as absence", async () => {
    const empty = { ...before, value: "", value_type: "text" }; // an empty value is text (attributeValue)
    expect(await restoreAttribute(change(empty))).toMatchObject({ restored: true });
    expect(state.current).toEqual(empty);
    expect(state.events[0].payload.value).toBe("");
  });

  it("requires the authorized transaction before reading or changing state", async () => {
    state.inTransaction = false;
    await expect(restoreAttributeIn(change(), actorCtx)).rejects.toThrow("requires a restore transaction");
    expect(state.queries).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });
});

describe("later edits and uncertain history are preserved", () => {
  it("a governed key's type follows its field: a row retyped by the rule still undoes", async () => {
    state.field = { name: "score", type: "rating" };
    state.current = { ...after, value_type: "number" }; // the event recorded "text"; migration 105 retyped it
    expect(await restoreAttribute(change())).toMatchObject({ restored: true });
    expect(state.current).toEqual(before);
  });

  it("undoing only a free-form type change restores the old type, not already_in_state", async () => {
    const asText = { ...after, value: "42", value_type: "text" }, asNumber = { ...asText, value_type: "number" };
    state.current = asNumber;
    expect(await restoreAttribute(change(asText, asNumber))).toMatchObject({ restored: true });
    expect(state.current).toEqual(asText);
  });

  it("an older undo conflicts with a later free-form type change instead of dropping it", async () => {
    const v41 = { ...after, value: "41", value_type: "text" }, v42 = { ...v41, value: "42" };
    state.current = { ...v42, value_type: "number" }; // E2 changed only the type
    expect(await restoreAttribute(change(v41, v42))).toMatchObject({ code: "state_conflict" });
    expect(state.current).toEqual({ ...v42, value_type: "number" });
    expect(mutations()).toHaveLength(0);
  });

  it.each([
    { value: "later edit" },
    { value_type: "number" }, // a free-form key's type is the person's: changing it is an edit
    { is_inheritable: true },
    { source: "frontmatter" },
  ])("rejects a later change to %j", async (later) => {
    const current = { ...after, ...later };
    state.current = current;
    expect(await restoreAttribute(change())).toMatchObject({ code: "state_conflict", status: 409, force_available: false });
    expect(state.current).toEqual(current);
    expect(mutations()).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });

  it("does not delete a later replacement of a created attribute", async () => {
    state.current = { ...after, value: "replacement" };
    expect(await restoreAttribute(change(null))).toMatchObject({ code: "state_conflict" });
    expect(state.current.value).toBe("replacement");
    expect(state.events).toHaveLength(0);
  });

  it("does not resurrect an overwritten attribute that a later operation removed", async () => {
    state.current = null;
    expect(await restoreAttribute(change())).toMatchObject({ code: "state_conflict" });
    expect(state.current).toBeNull();
  });

  it("a replacement after deletion is a conflict, rather than a successful no-op", async () => {
    expect(await restoreAttribute(deletion())).toMatchObject({ code: "state_conflict" });
    expect(state.current).toEqual(after);
  });

  it("an exact prior state is already restored and emits nothing", async () => {
    state.current = { ...before };
    expect(await restoreAttribute(change())).toMatchObject({ code: "already_in_state" });
    expect(state.events).toHaveLength(0);
  });

  it("safe already-in-state does not require missing after metadata", async () => {
    state.current = null;
    const original = change(null);
    original.payload = { key: "score", value: "legacy" };
    expect(await restoreAttribute(original)).toMatchObject({ code: "already_in_state" });
    expect(state.events).toHaveLength(0);
  });

  it("a historical DELETE that removed nothing cannot remove today's value", async () => {
    const original = deletion();
    original.tx_meta.prev_field_values = null;
    expect(await restoreAttribute(original)).toMatchObject({ code: "already_in_state" });
    expect(state.current).toEqual(after);
  });

  it.each(["value_type", "is_inheritable", "source"])("does not invent a missing before %s", async (field) => {
    const original = change();
    delete (original.tx_meta.prev_field_values as Record<string, unknown>)[field];
    expect(await restoreAttribute(original)).toMatchObject({ code: "history_incomplete", force_available: false });
    expect(state.current).toEqual(after);
    expect(mutations()).toHaveLength(0);
  });

  it("does not trust an after snapshot whose source was not recorded", async () => {
    const original = change();
    delete original.payload.source;
    expect(await restoreAttribute(original)).toMatchObject({ code: "history_incomplete" });
    expect(state.events).toHaveLength(0);
  });

  it.each([
    { inverse_op: "attribute.deleted", prev_field_values: before },
    { inverse_op: "attribute.set", prev_field_values: null },
    { prev_field_values: before },
  ])("refuses contradictory or missing inverse metadata: %j", async (txMeta) => {
    expect(await restoreAttribute({ ...change(), tx_meta: txMeta })).toMatchObject({ code: "history_incomplete" });
    expect(mutations()).toHaveLength(0);
  });
});

describe("ink history and preview", () => {
  it("round-trips ink via blob pointers without embedding drawing bodies in events", async () => {
    const prior = { ...before, value: '{"strokes":[1]}', value_type: "text" };
    const latest = { ...after, value: '{"strokes":[1,2]}', value_type: "text" };
    state.current = latest;
    const original: EventRow = {
      ...change(), payload: { key: "ink_data", ...await encodeSnapshot("ink_data", latest) },
      tx_meta: { inverse_op: "attribute.set", prev_field_values: await encodeSnapshot("ink_data", prior) },
    };
    expect(await restoreAttribute(original)).toMatchObject({ restored: true });
    expect(state.current).toEqual(prior);
    expect(state.events[0].payload).not.toHaveProperty("value");
    expect(state.events[0].tx_meta.prev_field_values).not.toHaveProperty("value");
    expect(state.events[0].payload.value_ref).toEqual(expect.any(String));
    expect(await restoreAttribute(state.events[0])).toMatchObject({ restored: true });
    expect(state.current).toEqual(latest);
    // each undo of a drawing minted its version (a key select and the row insert)
    expect(state.versions).toHaveLength(4);
  });

  it("does not turn a missing historical blob into an empty value or deletion", async () => {
    const original = change();
    original.tx_meta.prev_field_values = { ...before, value: undefined, value_ref: "missing-blob" };
    expect(await restoreAttribute(original)).toMatchObject({ code: "history_incomplete" });
    expect(state.current).toEqual(after);
    expect(mutations()).toHaveLength(0);
  });

  it("the preview and write agree that later metadata changes block restoration", async () => {
    state.current = { ...after, source: "markdown" };
    expect(await previewAttributeRestore(change())).toMatchObject({
      kind: "attribute_change", current_value: after.value, restored_value: before.value,
      can_apply_cleanly: false, force_available: false, conflict_code: "state_conflict",
    });
    expect(mutations()).toHaveLength(0);
    expect(state.queries.some(({ sql }) => sql.includes("FOR UPDATE"))).toBe(false);
    expect(await restoreAttribute(change())).toMatchObject({ code: "state_conflict" });
  });

  it("previews a hash-backed deleted value without writing a blob or attribute", async () => {
    state.current = null;
    const snapshot = await encodeSnapshot("ink_data", before);
    state.queries.length = 0;
    const original = { ...deletion(), payload: { key: "ink_data" }, tx_meta: { inverse_op: "attribute.set", prev_field_values: snapshot } };
    expect(await previewAttributeRestore(original)).toMatchObject({
      restored_value: before.value, current_value: null, action: "set", can_apply_cleanly: true,
    });
    expect(state.queries.some(({ sql }) => /INSERT|DELETE|UPDATE/.test(sql))).toBe(false);
  });
});
