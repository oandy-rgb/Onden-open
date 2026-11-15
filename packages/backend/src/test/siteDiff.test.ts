// D80: the publish preview's diff and the candidate hash read one reader view.
import { describe, it, expect } from "vitest";
import { readerHash, siteDiff } from "../modules/website/publishing/siteDiff.js";

const node = (id: string, sort_order: number, extra: Record<string, unknown> = {}) => ({
  id, title: id.toUpperCase(), slug: id, markdown: id, parent_id: null, tags: [], sort_order,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", node_type: "content", ...extra,
});
const site = (nodes: unknown[], edges: unknown[] = []) => ({ title: "Site", payload: { nodes, edges, home_node_id: null, presentation: {} } });
const ids = (list: Array<{ id: string }>) => list.map((n) => n.id);

describe("siteDiff + readerHash", () => {
  const base = site([node("a", 0), node("b", 1), node("c", 2), node("d", 3)]);

  it("moving one sibling lists only that one as moved", () => {
    const next = site([node("a", 1), node("b", 2), node("c", 3), node("d", 0)]);
    const diff = siteDiff(base, next);
    expect(ids(diff.moved)).toEqual(["d"]);
    expect(diff.changed).toEqual([]);
    expect(readerHash(next.title, next.payload)).not.toBe(readerHash(base.title, base.payload));
  });

  it("a note added or removed moves nothing", () => {
    const next = site([node("a", 0), node("c", 2), node("d", 3), node("e", 1)]);
    const diff = siteDiff(base, next);
    expect(ids(diff.added)).toEqual(["e"]);
    expect(ids(diff.removed)).toEqual(["b"]);
    expect(diff.moved).toEqual([]);
  });

  it("timestamps, node_type, side effects and a renumbering that keeps the order are not changes", () => {
    const next = site([
      node("a", 10, { updated_at: "2026-05-05T00:00:00.000Z", node_type: "page" }),
      node("b", 11), node("c", 12), node("d", 13),
    ]);
    Object.assign(next.payload, { side_effects: { x: 1 } });
    const diff = siteDiff(base, next);
    expect([...diff.added, ...diff.removed, ...diff.changed, ...diff.moved, ...diff.links_changed]).toEqual([]);
    expect(diff.settings_changed).toBe(false);
    expect(readerHash(next.title, next.payload)).toBe(readerHash(base.title, base.payload));
  });

  it("an edge between two notes changes both ends' links, not their text", () => {
    const next = site(base.payload.nodes, [{ id: "e1", source_node_id: "a", target_node_id: "c", edge_type: "knowledge_link" }]);
    const diff = siteDiff(base, next);
    expect(ids(diff.links_changed)).toEqual(["a", "c"]);
    expect(diff.changed).toEqual([]);
    expect(readerHash(next.title, next.payload)).not.toBe(readerHash(base.title, base.payload));
  });

  it("a Date created_at (a fresh candidate) and its ISO string (a stored snapshot) order alike", () => {
    const fresh = site([node("a", 0, { created_at: new Date("2026-01-01T00:00:00.000Z") }), node("b", 1), node("c", 2), node("d", 3)]);
    expect(readerHash(fresh.title, fresh.payload)).toBe(readerHash(base.title, base.payload));
  });

  it("never published: everything is added, settings unchanged", () => {
    const diff = siteDiff(null, base);
    expect(ids(diff.added)).toEqual(["a", "b", "c", "d"]);
    expect(diff.settings_changed).toBe(false);
  });
});
