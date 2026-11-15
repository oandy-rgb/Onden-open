// The shape check (wireShape.ts) is hand-written so zod stays out of the boot
// bundle. These tests hold it to the contract: a payload built to the real
// types (tsc fails here when Bootstrap / SyncDelta gain or rename a required
// field) and a node the contract's own schema accepts must pass it, and the
// field it keys nodes on must still exist in that schema.
import { describe, it, expect } from "vitest";
import { ServerNode } from "@onden/contract";
import type { Bootstrap, ContentNode } from "../api";
import type { SyncDelta } from "../localDb";
import { assertBootstrapShape, assertSyncDeltaShape, WireShapeError } from "./wireShape";

const node: ContentNode = {
  id: "n1", workspace_id: "w", source_type: "manual", node_type: "content", title: "T", slug: "t", markdown: "",
  created_at: "2026-10-01T08:00:00.000Z", updated_at: "2026-10-01T08:00:00.000Z", parent_id: null, hidden: false, sort_order: 0,
  presentation: null, collection_views: null, deleted_at: null, deleted_by_event_id: null, tag_color: null, tag_schema: null,
  reserved_key: null, space_id: null, class_tag_ids: [], label_tag_ids: [], last_actor: null, last_modified_at: null, recent_actors: [],
};

const bootstrap: Bootstrap = {
  workspace: { id: "w", name: "W", slug: "w", home_node_id: null },
  nodes: [node], edges: [], tasks: [], suggestions: [], events: [],
};
const delta: SyncDelta = {
  last_event_id: "12", nodes: { upsert: [node], delete: ["gone"] }, edges: { upsert: [], delete: [] },
  tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null,
};

describe("wireShape follows the contract", () => {
  it("the sample node is one the contract's schema accepts, and ids are what a node is keyed on", () => {
    expect(ServerNode.safeParse(node).success).toBe(true);
    expect(Object.keys(ServerNode.shape)).toContain("id");
  });

  it("a payload built to the types passes", () => {
    expect(() => assertBootstrapShape(bootstrap)).not.toThrow();
    expect(() => assertSyncDeltaShape(delta)).not.toThrow();
  });

  it("extra fields anywhere are ignored", () => {
    expect(() => assertBootstrapShape({ ...bootstrap, later: 1, nodes: [{ ...node, later: 2 }] })).not.toThrow();
    expect(() => assertSyncDeltaShape({ ...delta, later: 1, nodes: { upsert: [{ ...node, later: 2 }], delete: [], later: 3 } })).not.toThrow();
  });

  it("the cursor may be a decimal string or a whole number, never anything else", () => {
    for (const ok of ["0", "9007199254740993", 5]) expect(() => assertSyncDeltaShape({ ...delta, last_event_id: ok })).not.toThrow();
    for (const bad of ["", "1.5", "-1", -1, 1.5, null, undefined, {}]) expect(() => assertSyncDeltaShape({ ...delta, last_event_id: bad })).toThrow(WireShapeError);
    expect(() => assertBootstrapShape({ ...bootstrap, last_event_id: "x" })).toThrow(WireShapeError);
  });

  it("a ?nodes=none answer needs no per-note lists, but a present one must still be a list", () => {
    const meta = { workspace: bootstrap.workspace, suggestions: [], nodes_omitted: true };
    expect(() => assertBootstrapShape(meta)).not.toThrow();
    expect(() => assertBootstrapShape({ ...meta, nodes: "x" })).toThrow(WireShapeError);
  });

  it("a delta with a malformed optional channel is refused", () => {
    expect(() => assertSyncDeltaShape({ ...delta, attributes: { upsert: [{ key: "k" }], delete: [] } })).toThrow(WireShapeError);
    expect(() => assertSyncDeltaShape({ ...delta, pointers: { upsert: "x", delete: [] } })).toThrow(WireShapeError);
    expect(() => assertSyncDeltaShape({ ...delta, workspace: {} })).toThrow(WireShapeError);
  });
});
