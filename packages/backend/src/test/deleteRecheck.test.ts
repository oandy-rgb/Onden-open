// deleteEdge / deletePointer read the row to learn its source (the authority) and then write. Between the two
// a concurrent request can delete the row (or replace it under the same client-chosen id). The write must
// re-check under the event lock and answer 404 without removing anything or committing an event. These tests
// stub the database and run `apply` the way mutate() does, so they need no Postgres; the lock itself is
// mutate()'s (covered by the integration tests).
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ sql: string; params: unknown[] }> = [];
let answers: Array<{ rows: unknown[]; rowCount?: number }> = [];
const mutated: Array<{ authority: unknown; event: unknown }> = [];

vi.mock("../db.js", () => ({
  q: vi.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    const next = answers.shift() ?? { rows: [] };
    return { rows: next.rows, rowCount: next.rowCount ?? next.rows.length };
  }),
}));
vi.mock("../spine/mutate.js", () => ({
  mutate: vi.fn(async (op: { authority: unknown; event: unknown; apply: () => Promise<unknown> }) => {
    mutated.push({ authority: op.authority, event: op.event });
    return op.apply();
  }),
}));
vi.mock("../services/parentKind.js", () => ({ assertParentKind: vi.fn(), assertModuleTagEdge: vi.fn() }));

const { deleteEdge, DerivedEdgeError } = await import("../services/edgeWrites.js");
const { deletePointer } = await import("../services/pointers.js");
const actor = { id: "a" } as never;

beforeEach(() => { calls.length = 0; answers = []; mutated.length = 0; });

describe("deleteEdge", () => {
  it("is 404 without a write when the edge is already gone", async () => {
    answers = [{ rows: [] }];
    await expect(deleteEdge(actor, "w", "e1")).rejects.toMatchObject({ status: 404, message: "edge not found" });
    expect(mutated).toEqual([]);
  });

  it("is 404 and deletes nothing when the edge vanished between the read and the lock", async () => {
    answers = [{ rows: [{ source_node_id: "s" }] }, { rows: [] }];
    await expect(deleteEdge(actor, "w", "e1")).rejects.toMatchObject({ status: 404, message: "edge not found" });
    expect(mutated).toHaveLength(1);
    expect(calls.some((c) => /DELETE FROM node_edges/.test(c.sql))).toBe(false);
    expect(calls[1]!.sql).toMatch(/FOR UPDATE/);
  });

  it("is 404 when the id now belongs to an edge of another source (authority was judged on the old one)", async () => {
    answers = [{ rows: [{ source_node_id: "s" }] }, { rows: [{ source_node_id: "other", derived: false }] }];
    await expect(deleteEdge(actor, "w", "e1")).rejects.toMatchObject({ status: 404 });
    expect(calls.some((c) => /DELETE FROM node_edges/.test(c.sql))).toBe(false);
  });

  it("refuses a derived edge and still deletes nothing", async () => {
    answers = [{ rows: [{ source_node_id: "s" }] }, { rows: [{ source_node_id: "s", derived: true }] }];
    await expect(deleteEdge(actor, "w", "e1")).rejects.toBeInstanceOf(DerivedEdgeError);
    expect(calls.some((c) => /DELETE FROM node_edges/.test(c.sql))).toBe(false);
  });

  it("deletes a manual edge whose source is unchanged, authorized on that source", async () => {
    answers = [{ rows: [{ source_node_id: "s" }] }, { rows: [{ source_node_id: "s", derived: false }] }, { rows: [], rowCount: 1 }];
    await deleteEdge(actor, "w", "e1");
    expect(mutated[0]!.authority).toEqual({ kind: "node", nodeId: "s", op: "write_node" });
    expect(calls.at(-1)!.sql).toMatch(/DELETE FROM node_edges/);
  });
});

describe("deletePointer", () => {
  it("is 404 without a write when the pointer is already gone", async () => {
    answers = [{ rows: [] }];
    await expect(deletePointer(actor, "w", "p1")).rejects.toMatchObject({ status: 404, message: "pointer not found" });
    expect(mutated).toEqual([]);
  });

  it("is 404 (event rolled back with it) when the delete matches no row any more", async () => {
    answers = [{ rows: [{ target_id: "t", parent_id: "p" }] }, { rows: [], rowCount: 0 }];
    await expect(deletePointer(actor, "w", "p1")).rejects.toMatchObject({ status: 404, message: "pointer not found" });
    // the DELETE is conditioned on the target/parent the event and authority were built from
    expect(calls[1]!.params).toEqual(["w", "p1", "t", "p"]);
  });

  it("deletes the pointer it read, authorized on its parent", async () => {
    answers = [{ rows: [{ target_id: "t", parent_id: "p" }] }, { rows: [], rowCount: 1 }];
    await deletePointer(actor, "w", "p1");
    expect(mutated[0]!.authority).toEqual({ kind: "node", nodeId: "p", op: "write_node" });
  });
});
