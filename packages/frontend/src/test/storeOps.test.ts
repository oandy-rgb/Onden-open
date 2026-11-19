import { describe, it, expect } from "vitest";
import { noWorkspaceData, type Bootstrap, type ContentNode } from "../lib/api";
import type { SyncDelta } from "../lib/localDb";
import { applySyncDelta, isEmptyDelta, patchNode, dropNode, setNodeAttr, dropNodeAttr, addNodeTag, serverCopyOver } from "../lib/data/storeOps";
import { optimisticFields } from "../lib/data/optimisticFields";
import { tagFromNode } from "../lib/tagProjection";
import { resetAppState } from "../lib/appStore";
import { todayId } from "../lib/localDate";

const node = (id: string, extra: Partial<ContentNode> = {}): ContentNode => ({
  id, title: `Node ${id}`, slug: `node-${id}`, markdown: "", source_type: "manual", node_type: "content", ...extra,
});

const emptyDelta = (): SyncDelta => ({
  last_event_id: 0,
  nodes: { upsert: [], delete: [] },
  edges: { upsert: [], delete: [] },
  tasks: { upsert: [], delete: [] },
  attributes: { upsert: [], delete: [] },
  workspace: null,
});

const base = (): Bootstrap => ({
  ...noWorkspaceData,
  nodes: [node("a", { attrs: { keep: "1", drop: "x" } }), node("b")],
});

describe("storeOps", () => {
  it("updates a scoped catalog independently of node membership and honors an empty authoritative snapshot", () => {
    const tag = tagFromNode(node("scoped-tag", { node_type: "class_tag", title: "Course", tag_schema: { behaviour: { modules: { review: { enabled: true } } } } }));
    const delta = { ...emptyDelta(), tags: [tag] };
    expect(isEmptyDelta(delta)).toBe(false);
    const next = applySyncDelta(base(), delta);
    expect(next.tags).toEqual([tag]);
    expect(next.nodes.some(n => n.id === tag.id)).toBe(false);
    expect(addNodeTag(next, "a", tag.id).nodes.find(n => n.id === "a")?.class_tag_ids).toContain(tag.id);
    const emptyCatalog = { ...emptyDelta(), tags: [], nodes: { upsert: [node(tag.id, { node_type: "class_tag" })], delete: [] } };
    expect(applySyncDelta(next, emptyCatalog).tags).toEqual([]);
    expect(applySyncDelta(next, emptyDelta()).tags).toEqual([tag]);
  });
  it("updates module identity after tag rename/schema sync and prunes it on revocation", () => {
    const oldTag = node("tag", { node_type: "class_tag", title: "review" });
    const nextTag = { ...oldTag, title: "Course", tag_schema: { behaviour: { modules: { review: { enabled: true } } } } };
    const delta = emptyDelta();
    delta.nodes.upsert = [nextTag];
    const synced = applySyncDelta({ ...base(), tags: [tagFromNode(oldTag)] }, delta);
    expect(synced.tags?.[0]).toMatchObject({ name: "Course", schema_id: "tag", schema_behaviour: { modules: { review: { enabled: true } } } });
    const revoke = emptyDelta();
    revoke.nodes.delete = ["tag"];
    expect(applySyncDelta(synced, revoke).tags).toEqual([]);
  });
  it("applySyncDelta replaces upserted node rows and removes deleted ones", () => {
    const delta = emptyDelta();
    delta.nodes.upsert = [node("a", { title: "Rewritten" })];
    delta.nodes.delete = ["b"];
    const next = applySyncDelta(base(), delta);
    expect(next.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(next.nodes[0]!.title).toBe("Rewritten");
  });

  it("applySyncDelta removes a node in nodes.delete AND prunes its dependent tasks + edges (revocation cascade)", () => {
    // HIGH gap #2: a node that LEFT the read set via a permission change arrives
    // only as a nodes.delete id (no node-targeted event). Dropping it must also
    // prune its tasks and any edge touching it — no dangling task/half-edge.
    const prev: Bootstrap = {
      ...noWorkspaceData,
      nodes: [node("a"), node("b")],
      tasks: [
        { id: "t1", node_id: "a", title: "task on a", status: "todo" },
        { id: "t2", node_id: "b", title: "task on b", status: "todo" },
      ],
      edges: [
        { id: "e1", source_node_id: "a", target_node_id: "b", edge_type: "knowledge_link", status: "active" },
        { id: "e2", source_node_id: "b", target_node_id: "a", edge_type: "knowledge_link", status: "active" },
        { id: "e3", source_node_id: "b", target_node_id: "b", edge_type: "knowledge_link", status: "active" },
      ],
    };
    const delta = emptyDelta();
    delta.nodes.delete = ["a"];
    const next = applySyncDelta(prev, delta);
    expect(next.nodes.map((n) => n.id)).toEqual(["b"]);
    // a's task gone; b's task survives
    expect(next.tasks.map((t) => t.id)).toEqual(["t2"]);
    // both edges touching a (in either direction) gone; the b→b edge survives
    expect(next.edges.map((e) => e.id)).toEqual(["e3"]);
  });

  it("dropNode cascades like the sync delete — prunes the node's tasks (hosted + self) and edges (either end)", () => {
    // Finding #2: the OPTIMISTIC local delete must match applySyncDelta's cascade
    // (above), or an offline delete + reload leaves dangling tasks/edges in the
    // mirror. Same fixture shape as the sync-cascade test.
    const prev: Bootstrap = {
      ...noWorkspaceData,
      nodes: [node("a"), node("b"), node("tnode")],
      tasks: [
        { id: "t1", node_id: "a", title: "task on a", status: "todo" },
        { id: "t2", node_id: "b", title: "task on b", status: "todo" },
        { id: "tnode", node_id: "b", title: "the task node itself", status: "todo" },
      ],
      edges: [
        { id: "e1", source_node_id: "a", target_node_id: "b", edge_type: "knowledge_link", status: "active" },
        { id: "e2", source_node_id: "b", target_node_id: "a", edge_type: "knowledge_link", status: "active" },
        { id: "e3", source_node_id: "b", target_node_id: "b", edge_type: "knowledge_link", status: "active" },
      ],
    };
    // delete node "a": its hosted task + both edges touching it go; b's stay
    const a = dropNode(prev, "a");
    expect(a.nodes.map((n) => n.id)).toEqual(["b", "tnode"]);
    expect(a.tasks.map((t) => t.id)).toEqual(["t2", "tnode"]);
    expect(a.edges.map((e) => e.id)).toEqual(["e3"]);
    // delete the TASK NODE "tnode": the task row whose OWN id matches is pruned
    const tn = dropNode(prev, "tnode");
    expect(tn.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("applySyncDelta patches attrs in place — upsert overwrites, delete removes the key", () => {
    const prev = base();
    const delta = emptyDelta();
    delta.attributes.upsert = [{ node_id: "a", key: "keep", value: "2" } as SyncDelta["attributes"]["upsert"][number]];
    delta.attributes.delete = [{ node_id: "a", key: "drop" }];
    const next = applySyncDelta(prev, delta);
    const a = next.nodes.find((n) => n.id === "a")!;
    expect(a.attrs).toEqual({ keep: "2" });
    // untouched node keeps its identity (no spurious re-renders)
    expect(next.nodes.find((n) => n.id === "b")).toBe(prev.nodes[1]);
  });

  it("isEmptyDelta is false for an attributes-only delta (the silently-dropped-attrs regression)", () => {
    const delta = emptyDelta();
    expect(isEmptyDelta(delta)).toBe(true);
    delta.attributes.upsert = [{ node_id: "a", key: "k", value: "v" } as SyncDelta["attributes"]["upsert"][number]];
    expect(isEmptyDelta(delta)).toBe(false);
  });

  it("workspace in the delta replaces the previous workspace", () => {
    const delta = emptyDelta();
    delta.workspace = { id: "w2", name: "Next", slug: "next", home_node_id: "a" };
    expect(applySyncDelta(base(), delta).workspace.id).toBe("w2");
    delta.workspace = null;
    expect(applySyncDelta(base(), delta).workspace.id).toBe(noWorkspaceData.workspace.id);
  });

  it("a delta that carries a changed time zone or day start moves today on this device too", () => {
    const at = new Date("2026-10-26T17:00:00Z");
    const before = applySyncDelta({ ...base(), timezone: "UTC" }, emptyDelta());
    resetAppState({ data: before });
    expect(todayId(at)).toBe("2026-10-26");
    const delta = emptyDelta();
    delta.workspace = { id: "w1", name: "W", slug: "w", home_node_id: null, time_zone: "Asia/Taipei", day_start_hour: 0 };
    const moved = applySyncDelta(before, delta);
    resetAppState({ data: moved });
    expect(todayId(at)).toBe("2026-10-27");
    delta.workspace = { ...delta.workspace, day_start_hour: 4 }; // 01:00 on the 27th is still the 26th
    resetAppState({ data: applySyncDelta(moved, delta) });
    expect(todayId(at)).toBe("2026-10-26");
  });

  it("node/attr helpers return new trees without mutating the input", () => {
    const before = base();
    const renamed = patchNode(before, "a", { title: "T" });
    expect(renamed.nodes.find((n) => n.id === "a")!.title).toBe("T");
    expect(before.nodes.find((n) => n.id === "a")!.title).toBe("Node a");

    const dropped = dropNode(before, "a");
    expect(dropped.nodes.map((n) => n.id)).toEqual(["b"]);

    const withAttr = setNodeAttr(before, "b", "k", "v");
    expect(withAttr.nodes.find((n) => n.id === "b")!.attrs).toEqual({ k: "v" });

    const withoutAttr = dropNodeAttr(withAttr, "b", "k");
    expect(withoutAttr.nodes.find((n) => n.id === "b")!.attrs).toEqual({});
  });
});

describe("applySyncDelta — upsert order", () => {
  // The order the one-pass upsert must keep: what repeated "drop the old row,
  // append the new one" produced (updated rows move to the end, in delta order).
  const reference = <T extends { id: string }>(rows: T[], upserts: T[]) => {
    let out = rows;
    for (const r of upserts) out = [...out.filter((x) => x.id !== r.id), r];
    return out;
  };

  it("keeps untouched notes in place and puts upserted ones last in delta order, repeats at their last position", () => {
    const prev = { ...base(), nodes: ["a", "b", "c", "d", "e"].map((id) => node(id)) };
    const upsert = [node("c", { title: "c1" }), node("x"), node("a", { title: "a1" }), node("c", { title: "c2" })];
    const next = applySyncDelta(prev, { ...emptyDelta(), nodes: { upsert, delete: ["b"] } });
    expect(next.nodes.map((n) => n.id)).toEqual(["d", "e", "x", "a", "c"]);
    expect(next.nodes.map((n) => n.id)).toEqual(reference(prev.nodes, upsert).filter((n) => n.id !== "b").map((n) => n.id));
    expect(next.nodes.find((n) => n.id === "c")?.title).toBe("c2");
  });

  it("orders edges the same way and applies edge deletes", () => {
    const edge = (id: string) => ({ id, source_node_id: "a", target_node_id: "b", edge_type: "link", status: "active" }) as never;
    const prev = { ...base(), edges: ["e1", "e2", "e3"].map(edge) };
    const next = applySyncDelta(prev, { ...emptyDelta(), edges: { upsert: [edge("e1"), edge("e4")], delete: ["e3"] } });
    expect(next.edges.map((e) => e.id)).toEqual(["e2", "e1", "e4"]);
  });
});

// A server copy and a field this device's edit is still waiting on (owner report 2026-11-19; review of #1900, question 1).
describe("serverCopyOver", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 19, 0, 0, s)).toISOString();
  it("an object field waiting for its answer: an equal copy is not held (no extra read), a different one is, and keeps the held value", () => {
    const held = node("p", { presentation: { site: { theme: "dark", nav: ["a", "b"] } }, updated_at: at(1) });
    const settle = optimisticFields<ContentNode>("node:p", held, { presentation: held.presentation });
    try {
      const same = serverCopyOver(node("p", { presentation: { site: { theme: "dark", nav: ["a", "b"] } }, updated_at: at(1) }), held);
      expect(same.held).toBe(false);
      const other = serverCopyOver(node("p", { presentation: { site: { theme: "light", nav: ["a", "b"] } }, updated_at: at(2) }), held);
      expect(other.held).toBe(true);
      expect(other.row).toMatchObject({ presentation: held.presentation, updated_at: at(1) });
    } finally { settle(true); }
  });
  it("a slim row held (its text not loaded here) never keeps its empty text over a full copy, even with an edit waiting (review of #1900, round 3)", () => {
    const held = node("s", { markdown: "", body_len: 12, updated_at: at(1) });
    const settle = optimisticFields<ContentNode>("node:s", held, { markdown: "" });
    try {
      const full = node("s", { markdown: "the real text", updated_at: at(1) });
      const copy = serverCopyOver(full, held);
      expect(copy.row).toMatchObject({ markdown: "the real text" });
      expect(copy.row?.body_len).toBeUndefined();
    } finally { settle(true); }
  });
  it("nothing waiting: a copy is taken whole, whatever its time (an older answer never gets here: takeAnswer refuses it by position)", () => {
    const held = node("q", { markdown: "AB", updated_at: at(2) });
    const earlierTime = node("q", { markdown: "C\nAB", updated_at: at(1) }); // the server's clock stepped back
    expect(serverCopyOver(earlierTime, held)).toEqual({ row: earlierTime, held: false });
    const newer = node("q", { markdown: "C\nAB", updated_at: at(3) });
    expect(serverCopyOver(newer, held)).toEqual({ row: newer, held: false });
  });
});
