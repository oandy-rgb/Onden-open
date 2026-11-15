// The reconnect merge runs after the write queue drained, so any remaining
// difference is not local intent. It must never overwrite a server note, never
// publish an unloaded (slim) body, and judge "missing" from the uncapped slim
// bootstrap.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentNode } from "../lib/api";

const calls: Array<{ path: string; init?: RequestInit }> = [];
let serverIds: string[] = [];
vi.mock("../lib/api", async (original) => ({
  ...await original<typeof import("../lib/api")>(),
  api: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (path.startsWith("/api/bootstrap")) return { nodes: serverIds.map((id) => ({ id })) };
    if (path === "/api/nodes" && JSON.parse(String(init?.body)).id === "rejected") throw new Error("403");
    return {};
  }),
}));
// Creations go through the note writer: record them at its submit boundary.
vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  submitWrite: async (r: { method: string; path: string; body: string | null }) => {
    calls.push({ path: r.path, init: { method: r.method, body: r.body ?? undefined } });
    if (r.path === "/api/nodes" && JSON.parse(String(r.body)).id === "rejected") throw new Error("403");
    return { status: "synced", value: JSON.parse(String(r.body)) };
  },
}));
vi.mock("../lib/localDb", () => ({ upsertNode: vi.fn(async () => {}), removeNode: vi.fn(async () => {}), upsertAttribute: vi.fn(async () => {}) }));
const { mergeLocalNodesToServer } = await import("../lib/serverMerge");

const note = (id: string, over: Partial<ContentNode> = {}) =>
  ({ id, title: `t-${id}`, markdown: `body ${id}`, source_type: "manual", ...over }) as ContentNode;

beforeEach(() => { calls.length = 0; serverIds = []; });

describe("mergeLocalNodesToServer", () => {
  it("reads the uncapped slim bootstrap", async () => {
    await mergeLocalNodesToServer([]);
    expect(calls[0].path).toBe("/api/bootstrap?bodies=none");
  });

  it("never patches a note the server already has, even when the local copy differs", async () => {
    serverIds = ["shared", "slim"];
    await mergeLocalNodesToServer([
      note("shared", { markdown: "older local text" }),
      note("slim", { markdown: "", body_len: 120 }),
    ]);
    expect(calls.filter((c) => c.init?.method)).toEqual([]);
  });

  it("creates complete notes the server is missing and skips slim or optimistic rows", async () => {
    const { failed } = await mergeLocalNodesToServer([
      note("missing"),
      note("unloaded", { markdown: "", body_len: 40 }),
      note("local-123"),
      note("empty", { markdown: "", body_len: 0 }),
    ]);
    const created = calls.filter((c) => c.init?.method === "POST").map((c) => JSON.parse(String(c.init!.body)).id);
    expect(created).toEqual(["missing", "empty"]);
    expect(failed).toBe(0);
  });

  it("counts a refused create without stopping the rest", async () => {
    const { failed } = await mergeLocalNodesToServer([note("rejected"), note("after")]);
    expect(failed).toBe(1);
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(2);
  });
});
