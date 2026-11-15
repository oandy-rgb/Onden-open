import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { encodeBootstrapNodes, WIRE_NODE_NULLABLE, BOOTSTRAP_WIRE_VERSION } from "./bootstrapWire.js";

const WS = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

/** A slim lean node row as Postgres + nodeRowColumnsSql hand it over. */
function nodeRow(over: Row = {}): Row {
  return {
    id: randomUUID(), workspace_id: WS, source_type: "manual", node_type: "content", title: "Note", slug: "note",
    markdown: "", created_at: "2026-10-01T08:00:00.000Z", updated_at: "2026-10-02T09:30:00.000Z",
    parent_id: null, hidden: false, sort_order: 0, presentation: null, deleted_at: null, deleted_by_event_id: null,
    tag_color: null, tag_schema: null, collection_views: null, reserved_key: null,
    space_id: "22222222-2222-4222-8222-222222222222", body_len: 120,
    class_tag_ids: [], label_tag_ids: [], last_actor: null, last_modified_at: null, recent_actors: [],
    ...over,
  };
}

describe("encodeBootstrapNodes", () => {
  it("drops workspace-constant, null and default fields and keeps the rest", () => {
    const [node] = encodeBootstrapNodes(WS, [nodeRow({ id: "n1", parent_id: "p1", sort_order: 3 })], []).nodes;
    expect(node).toEqual({
      id: "n1", title: "Note", slug: "note", markdown: "", created_at: "2026-10-01T08:00:00.000Z",
      updated_at: "2026-10-02T09:30:00.000Z", parent_id: "p1", sort_order: 3, space_id: 0, body_len: 120,
    });
  });

  it("keeps a workspace_id that is not the payload's workspace, and non-default values", () => {
    const row = nodeRow({ id: "n1", workspace_id: "other", hidden: true, source_type: "rss", node_type: "class_tag", tag_color: "#fff" });
    const [node] = encodeBootstrapNodes(WS, [row], []).nodes;
    expect(node).toMatchObject({ workspace_id: "other", hidden: true, source_type: "rss", node_type: "class_tag", tag_color: "#fff" });
  });

  it("stores each repeated string once in dict", () => {
    const rows = [
      nodeRow({ id: "a", label_tag_ids: ["t1", "t2"], last_actor: "u1", recent_actors: ["u1"] }),
      nodeRow({ id: "b", label_tag_ids: ["t2"], class_tag_ids: ["t3"], last_actor: "u1", recent_actors: ["u1", "u2"] }),
    ];
    const out = encodeBootstrapNodes(WS, rows, []);
    expect(new Set(out.dict).size).toBe(out.dict.length);
    expect(out.dict.filter((s) => s === "t2")).toHaveLength(1);
    const names = (ids: unknown) => (ids as number[]).map((i) => out.dict[i]);
    expect(names(out.nodes[1]!.label_tag_ids)).toEqual(["t2"]);
    expect(names(out.nodes[1]!.recent_actors)).toEqual(["u1", "u2"]);
    expect(out.dict[out.nodes[1]!.last_actor as number]).toBe("u1");
    expect(out.nodes[0]!).not.toHaveProperty("class_tag_ids");
  });

  it("groups attributes by node position and keeps rows of unknown nodes plain", () => {
    const attr = (node_id: string, key: string, value: string, over: Row = {}) =>
      ({ node_id, key, value, value_type: "text", is_inheritable: false, source: "ui", ...over });
    const out = encodeBootstrapNodes(WS, [nodeRow({ id: "a" }), nodeRow({ id: "b" })], [
      attr("b", "status", "open"), attr("a", "status", "done"), attr("b", "prio", "high", { is_inheritable: true, source: null }),
      attr("gone", "x", "y"),
    ]);
    expect(out.attributes).toEqual([attr("gone", "x", "y")]);
    const groups = new Map(out.attribute_groups as Array<[number, unknown[][]]>);
    expect(groups.get(0)).toHaveLength(1);
    const [, b] = [groups.get(0), groups.get(1)!];
    const [key, value, , inheritable, source] = b[1]!;
    expect([out.dict[key as number], value, inheritable, source]).toEqual(["prio", "high", 1, null]);
  });

  it("an empty bootstrap encodes to empty channels", () => {
    expect(encodeBootstrapNodes(WS, [], [])).toEqual({ wire: BOOTSTRAP_WIRE_VERSION, dict: [], nodes: [], attributes: [], attribute_groups: [] });
  });

  it("restores every nullable column the list names (guards the decoder's list)", () => {
    expect([...WIRE_NODE_NULLABLE].sort()).toEqual(
      ["collection_views", "deleted_at", "deleted_by_event_id", "last_actor", "last_modified_at", "parent_id", "presentation", "reserved_key", "space_id", "tag_color", "tag_schema"].sort(),
    );
  });
});

describe("size of a 20k-note slim bootstrap (shape from docs/archive/research/perf-logged-in-2026-10-21.md)", () => {
  it("is much smaller compact, raw and gzipped", () => {
    const N = 20_000;
    const labels = Array.from({ length: 40 }, () => randomUUID());
    const users = Array.from({ length: 3 }, () => randomUUID());
    const space = randomUUID();
    const statuses = ["todo", "doing", "done"];
    const nodes: Row[] = [];
    const attributes: Row[] = [];
    for (let i = 0; i < N; i++) {
      const actor = i % 5 === 0 ? null : users[i % users.length]!;
      const row = nodeRow({
        id: randomUUID(), title: `Note ${i} about topic ${i % 97}`, slug: `note-${i}-about-topic-${i % 97}`,
        parent_id: i % 4 === 0 ? null : randomUUID(), sort_order: i % 7 === 0 ? i : 0, space_id: space,
        created_at: new Date(1.76e12 + i * 61_000).toISOString(), updated_at: new Date(1.76e12 + i * 97_000).toISOString(),
        body_len: 200 + (i % 3000),
        label_tag_ids: i % 2 === 0 ? [labels[i % 40]!] : [labels[i % 40]!, labels[(i + 7) % 40]!],
        last_actor: actor, last_modified_at: actor ? new Date(1.76e12 + i * 97_000).toISOString().replace(".000", "") : null,
        recent_actors: actor ? [actor] : [],
      });
      nodes.push(row);
      attributes.push({ node_id: row.id, key: "狀態", value: statuses[i % 3], value_type: "text", is_inheritable: false, source: "ui" });
      attributes.push({ node_id: row.id, key: "優先", value: String(i % 4), value_type: "text", is_inheritable: false, source: "ui" });
    }
    const before = JSON.stringify({ nodes, attributes });
    const after = JSON.stringify(encodeBootstrapNodes(WS, nodes, attributes));
    const gz = (s: string) => gzipSync(s).length;
    const mb = (n: number) => (n / 1e6).toFixed(2);
    console.log(`20k notes, nodes+attributes: raw ${mb(before.length)} MB -> ${mb(after.length)} MB; gzip ${mb(gz(before))} MB -> ${mb(gz(after))} MB`);
    expect(after.length).toBeLessThan(before.length * 0.5);
    expect(gz(after)).toBeLessThan(gz(before) * 0.8);
  });
});
