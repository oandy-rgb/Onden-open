import { describe, it, expect } from "vitest";
import { decodeBootstrapWire, BOOTSTRAP_HEADER_VALUE } from "./bootstrapWire";
import { encodeBootstrapNodes } from "../../../../backend/src/services/sync/bootstrapWire";
import type { Bootstrap } from "../api";

const WS = "11111111-1111-4111-8111-111111111111";
const SPACE = "22222222-2222-4222-8222-222222222222";

// Rows as the lean slim bootstrap carries them today (backend nodeRowColumnsSql).
function node(over: Record<string, unknown>) {
  return {
    id: "n0", workspace_id: WS, source_type: "manual", node_type: "content", title: "T", slug: "t", markdown: "",
    created_at: "2026-10-01T08:00:00.000Z", updated_at: "2026-10-02T09:30:00.000Z", parent_id: null, hidden: false,
    order_key: "a0", order_stamp: "", presentation: null, deleted_at: null, deleted_by_event_id: null, tag_color: null, tag_schema: null,
    collection_views: null, reserved_key: null, space_id: SPACE, body_len: 42,
    class_tag_ids: [], label_tag_ids: [], last_actor: null, last_modified_at: null, recent_actors: [], ...over,
  };
}

const nodes = [
  node({ id: "n1", title: "Plain" }),
  node({ id: "n2", parent_id: "n1", order_key: "a4", hidden: true, label_tag_ids: ["t1", "t2"], class_tag_ids: ["c1"],
    last_actor: "u1", last_modified_at: "2026-10-02T09:30:00Z", recent_actors: ["u1", "u2"], presentation: { icon: "x" } }),
  node({ id: "tag1", node_type: "class_tag", source_type: "system", tag_color: "#abc", tag_schema: { fields: [] },
    collection_views: [{ id: "v" }], reserved_key: "k", space_id: null, body_len: 0 }),
];
const attributes = [
  { node_id: "n2", key: "狀態", value: "doing", value_type: "text", is_inheritable: false, source: "ui" },
  { node_id: "n1", key: "狀態", value: "todo", value_type: "text", is_inheritable: true, source: "agent" },
  { node_id: "n2", key: "優先", value: "high", value_type: "text", is_inheritable: false, source: "ui" },
];

function lean(): Bootstrap {
  return { bodies: "none", last_event_id: "9", attrs_omitted: true, deferred_attribute_keys: ["ink_data"],
    workspace: { id: WS, name: "W" }, nodes, attributes, edges: [], tasks: [], events: [], suggestions: [], actor_role: "admin" } as unknown as Bootstrap;
}

describe("decodeBootstrapWire", () => {
  it("decode(encode(x)) is today's lean shape", () => {
    const plain = lean();
    const wire = { ...plain, ...encodeBootstrapNodes(WS, nodes, attributes) } as unknown as Bootstrap;
    const decoded = decodeBootstrapWire(wire);
    expect(decoded.nodes).toEqual(plain.nodes);
    // attribute rows come back grouped by node, so compare as sets
    const key = (r: { node_id: string; key: string }) => `${r.node_id}/${r.key}`;
    expect([...decoded.attributes!].sort((a, b) => key(a).localeCompare(key(b))))
      .toEqual([...plain.attributes!].sort((a, b) => key(a).localeCompare(key(b))));
    const { nodes: _n, attributes: _a, ...restDecoded } = decoded;
    const { nodes: _pn, attributes: _pa, ...restPlain } = plain;
    expect(restDecoded).toEqual(restPlain);
    expect(decoded).not.toHaveProperty("wire");
    expect(decoded).not.toHaveProperty("dict");
  });

  it("an old-format payload (older server, or the lean header) is returned untouched", () => {
    const plain = lean();
    expect(decodeBootstrapWire(plain)).toBe(plain);
    expect(BOOTSTRAP_HEADER_VALUE).toBe("lean2");
  });

  it("rejects a format version it does not know instead of misreading it", () => {
    expect(() => decodeBootstrapWire({ ...lean(), wire: 3, dict: [] } as unknown as Bootstrap)).toThrow(/Unsupported bootstrap format/);
  });
});
