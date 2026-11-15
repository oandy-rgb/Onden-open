// A new browser app starts without the empty built-in English tags (book, meeting…) in its tag list and graph.
import { describe, it, expect } from "vitest";
import { retireUnusedSeedTags, UNUSED_SEED_TAG_NAMES } from "../browser/sampleNotes.js";

function fakeApi(tags: Array<{ id: string; name: string }>, refuse: string[] = []) {
  const calls: string[] = [];
  const fetchLocal = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    if (request.method === "GET") return Response.json({ tags });
    if (request.method === "DELETE" && refuse.some((id) => path.endsWith(id))) return new Response("{}", { status: 409 });
    return Response.json({});
  };
  return { calls, fetchLocal };
}

describe("retireUnusedSeedTags", () => {
  it("trashes each unused built-in tag and leaves every other tag alone", async () => {
    const tags = [...UNUSED_SEED_TAG_NAMES.map((name) => ({ id: `id-${name}`, name })), { id: "mine", name: "作業" }, { id: "task", name: "task" }];
    const { calls, fetchLocal } = fakeApi(tags);
    await retireUnusedSeedTags(fetchLocal, "http://localhost");
    const deleted = calls.filter((c) => c.startsWith("DELETE")).map((c) => c.split("/").pop());
    expect(deleted.sort()).toEqual(UNUSED_SEED_TAG_NAMES.map((n) => `id-${n}`).sort());
    expect(calls.some((c) => c.endsWith("/mine") || c.endsWith("/task"))).toBe(false);
  });

  it("hides a tag the server refuses to delete", async () => {
    const { calls, fetchLocal } = fakeApi([{ id: "id-admin-only", name: "admin-only" }], ["id-admin-only"]);
    await retireUnusedSeedTags(fetchLocal, "http://localhost");
    expect(calls).toContain("PATCH /api/nodes/id-admin-only");
  });
});
