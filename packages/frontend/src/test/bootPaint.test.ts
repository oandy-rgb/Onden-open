// Cold boot paints before the worker has persisted (lib/data/bootPaint). The
// user's pending edits must never show reverted, and an answer from the worker
// must never undo what was typed after the paint.
import { describe, it, expect } from "vitest";
import type { Bootstrap, ContentNode } from "../lib/api";
import type { PendingWrite } from "../lib/localDb";
import { projectBootstrapForPaint, reconcilePersistedBootstrap } from "../lib/data/bootPaint";
import { missingPendingNoteCreations, projectPendingNoteText } from "../lib/pendingNoteProjection";

const note = (id: string, title: string, markdown: string): ContentNode => ({
  id, title, slug: id, markdown, body_len: markdown.length, node_type: "content", source_type: "manual", parent_id: null, hidden: false, order_key: "a0",
} as ContentNode);
const boot = (nodes: ContentNode[]): Bootstrap => ({ bodies: "none", nodes, edges: [], tasks: [], suggestions: [], events: [], tags: [] } as unknown as Bootstrap);
const patch = (id: string, body: object, n = 1): PendingWrite =>
  ({ id: n, method: "PATCH", path: `/api/nodes/${id}`, body: JSON.stringify(body), idem_key: `k${n}`, attempts: 0 });
const create = (id: string, body: object, n = 1): PendingWrite =>
  ({ id: n, method: "POST", path: "/api/nodes", body: JSON.stringify({ id, ...body }), idem_key: `k${n}`, attempts: 0 });

describe("projectBootstrapForPaint", () => {
  it("returns the payload itself when nothing is pending", () => {
    const next = boot([note("a", "A", "")]);
    expect(projectBootstrapForPaint(next, [])).toBe(next);
  });

  it("shows a pending edit, not the server's older text", () => {
    const next = boot([note("a", "Server title", "server body"), note("b", "B", "b")]);
    const shown = projectBootstrapForPaint(next, [patch("a", { title: "Mine", markdown: "typed offline" })]);
    expect(shown.nodes.find(n => n.id === "a")).toMatchObject({ title: "Mine", markdown: "typed offline", body_len: 13 });
    expect(shown.nodes.find(n => n.id === "b")?.title).toBe("B");
  });

  it("keeps a note that exists only as a pending create, and drops it once a delete is queued", () => {
    const next = boot([note("a", "A", "")]);
    const writes = [create("new", { title: "Fresh", markdown: "draft" })];
    expect(projectBootstrapForPaint(next, writes).nodes.map(n => n.title)).toEqual(["A", "Fresh"]);
    const deleted = [...writes, { id: 2, method: "DELETE", path: "/api/nodes/new", body: null, idem_key: "k2", attempts: 0 }];
    expect(projectBootstrapForPaint(next, deleted).nodes.map(n => n.title)).toEqual(["A"]);
  });

  it("is exactly what the worker applies (same projection functions)", () => {
    const next = boot([note("a", "A", "x")]);
    const writes = [patch("a", { markdown: "m1" }, 1), patch("a", { markdown: "" }, 2), create("c", { title: "C" }, 3)];
    expect(projectBootstrapForPaint(next, writes).nodes)
      .toEqual([...projectPendingNoteText(next.nodes, writes), ...missingPendingNoteCreations(next.nodes, writes)]);
  });
});

describe("reconcilePersistedBootstrap", () => {
  it("leaves the store alone when the worker's projection matches the paint", () => {
    const painted = boot([note("a", "Mine", "typed")]);
    const store = { ...painted };
    expect(reconcilePersistedBootstrap(store, painted, boot([note("a", "Mine", "typed")]))).toBe(store);
  });

  it("takes a queued edit the paint did not know, while the store still shows the painted text", () => {
    const painted = boot([note("a", "A", "old")]);
    const applied = boot([note("a", "A", "queued meanwhile")]);
    const out = reconcilePersistedBootstrap({ ...painted }, painted, applied);
    expect(out.nodes[0]!.markdown).toBe("queued meanwhile");
  });

  it("does not undo text typed after the paint", () => {
    const painted = boot([note("a", "A", "old")]);
    const typed = boot([note("a", "A", "typed after paint")]);
    const applied = boot([note("a", "A", "worker saw an older queue")]);
    const out = reconcilePersistedBootstrap(typed, painted, applied);
    expect(out).toBe(typed);
  });

  it("adds a pending creation the paint missed, but not one the user already deleted from the store", () => {
    const painted = boot([note("a", "A", "")]);
    const applied = boot([note("a", "A", ""), note("c", "C", "created meanwhile")]);
    expect(reconcilePersistedBootstrap({ ...painted }, painted, applied).nodes.map(n => n.id)).toEqual(["a", "c"]);
    const withCNow = boot([note("a", "A", ""), note("c", "C", "created meanwhile")]);
    expect(reconcilePersistedBootstrap(withCNow, painted, applied)).toBe(withCNow);
  });

  it("does not resurrect a note deleted from the store", () => {
    const painted = boot([note("a", "A", "old")]);
    const gone = boot([]);
    expect(reconcilePersistedBootstrap(gone, painted, boot([note("a", "A", "new")]))).toBe(gone);
  });
});
