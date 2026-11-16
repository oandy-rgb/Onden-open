// Card extraction is several writes. These helpers must not
// leave silent half-results: creation is retry-safe, a failed create removes
// the children already made, and every failure is reported once.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAppState, resetAppState, setOnline } from "../lib/appStore";
import { ApiError } from "../lib/api";

const calls: Array<{ path: string; method?: string; headers?: Record<string, string>; body?: Record<string, unknown> }> = [];
let failCreateAt = -1;
let failCreateWith: () => Error = () => new ApiError(422, JSON.stringify({ error: "invalid_args" }));
let failDelete = new Set<string>();
let pending: unknown[] = [];
vi.mock("../lib/api", async (original) => ({
  ...await original<typeof import("../lib/api")>(),
  api: vi.fn(async (path: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method: init.method, headers: init.headers as Record<string, string>, body });
    if (init.method === "POST" && calls.filter((c) => c.method === "POST").length - 1 === failCreateAt) throw failCreateWith();
    if (init.method === "DELETE" && failDelete.has(path.split("/").pop()!)) throw new Error("delete failed");
    return {};
  }),
}));
vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => pending) }));
const { createChildNotes, deleteNotes, runStructureOperation } = await import("../lib/data/noteStructure");

const kids = [0, 1, 2].map((i) => ({ title: `s${i}`, markdown: `body ${i}` }));

beforeEach(() => {
  calls.length = 0; failCreateAt = -1; failCreateWith = () => new ApiError(422, JSON.stringify({ error: "invalid_args" })); failDelete = new Set(); pending = [];
  resetAppState(); setOnline(true);
});

describe("noteStructure", () => {
  it("creates children with their client id, each request with its own key", async () => {
    const ids = await runStructureOperation((submit) => createChildNotes(submit, "parent", kids));
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.body?.id)).toEqual(ids);
    expect(posts.every((c) => c.body?.parent_id === "parent")).toBe(true);
    const keys = posts.map((c) => c.headers?.["Idempotency-Key"]);
    expect(new Set(keys).size).toBe(3);
  });

  it("removes the children already created when a later create is refused", async () => {
    failCreateAt = 2;
    expect(await runStructureOperation((submit) => createChildNotes(submit, "parent", kids))).toBeNull();
    const made = calls.filter((c) => c.method === "POST").slice(0, 2).map((c) => c.body?.id);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path.split("/").pop())).toEqual(made);
  });

  it("keeps the children when the outcome is unknown", async () => {
    failCreateAt = 2;
    failCreateWith = () => new TypeError("Failed to fetch"); // the response may have been lost
    expect(await runStructureOperation((submit) => createChildNotes(submit, "parent", kids))).toBeNull();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("keeps deleting past a failure and names what remains", async () => {
    failDelete = new Set(["b"]);
    expect(await runStructureOperation((submit) => deleteNotes(submit, ["a", "b", "c"]))).toEqual({ failed: ["b"] });
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(3);
  });

  it("refuses to start offline or with queued writes, and reports it", async () => {
    const work = vi.fn(async () => 1);
    setOnline(false);
    expect(await runStructureOperation(work)).toBeNull();
    setOnline(true);
    pending = [{ id: 1 }];
    expect(await runStructureOperation(work)).toBeNull();
    expect(work).not.toHaveBeenCalled();
    expect(getAppState().toasts.filter((toast) => toast.kind === "error")).toHaveLength(2);
  });

  it("turns a failure inside the work into one error notice and a null result", async () => {
    expect(await runStructureOperation(async () => { throw new Error("server said no"); })).toBeNull();
    expect(getAppState().toasts.filter((toast) => toast.kind === "error")).toHaveLength(1);
  });
});
