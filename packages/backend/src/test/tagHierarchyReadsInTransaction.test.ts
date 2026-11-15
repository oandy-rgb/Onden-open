// descendantsOf / memberTagIds / memberTagIdsNamed read through q(), the one
// query entry that joins the caller's transaction or read snapshot. A direct
// pool.query would not see a tag written earlier in the same transaction.
import { describe, expect, it, vi } from "vitest";

const q = vi.fn(async () => ({ rows: [] as Array<{ id: string }>, rowCount: 0 }));
const poolQuery = vi.fn(async () => { throw new Error("tagHierarchy read bypassed q()"); });
vi.mock("../db.js", () => ({ pool: { query: poolQuery }, q, event: vi.fn(), withTransaction: (fn: () => unknown) => fn(), inTransaction: () => false, bumpMembershipEpoch: vi.fn() }));

const { descendantsOf, memberTagIds, memberTagIdsNamed } = await import("../services/tagHierarchy.js");

describe("tagHierarchy reads join the caller's transaction", () => {
  it("descendantsOf", async () => {
    q.mockResolvedValueOnce({ rows: [{ id: "child" }], rowCount: 1 });
    expect(await descendantsOf("ws", "tag")).toEqual(["child"]);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("memberTagIds", async () => {
    q.mockResolvedValueOnce({ rows: [{ id: "child" }], rowCount: 1 });
    expect(await memberTagIds("ws", "tag")).toEqual(["tag", "child"]);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("memberTagIdsNamed", async () => {
    q.mockResolvedValueOnce({ rows: [{ id: "named" }], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await memberTagIdsNamed("ws", ["Named"])).toEqual(["named"]);
    expect(poolQuery).not.toHaveBeenCalled();
  });
});
