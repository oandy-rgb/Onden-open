import { describe, it, expect, vi, beforeEach } from "vitest";

const api = vi.fn();
vi.mock("../api", async (original) => ({ ...(await original<typeof import("../api")>()), api: (...args: unknown[]) => api(...args) }));

import { ApiError } from "../api";
import { getAppState } from "../appStore";
import { findTagIdByPath, resolveTagPaths } from "./tagPaths";

const tags = [
  { id: "r", name: "研究", parent_id: null },
  { id: "m", name: "方法", parent_id: "r" },
  { id: "m2", name: "方法", parent_id: null },
];

describe("findTagIdByPath", () => {
  it("walks segments under their parent, like the server's lookup", () => {
    expect(findTagIdByPath(tags, "研究")).toBe("r");
    expect(findTagIdByPath(tags, "研究/方法")).toBe("m");
    expect(findTagIdByPath(tags, " 方法 ")).toBe("m2");
    expect(findTagIdByPath(tags, "研究//方法/")).toBe("m");
  });

  it("returns null for a missing segment or empty path", () => {
    expect(findTagIdByPath(tags, "研究/新")).toBeNull();
    expect(findTagIdByPath(tags, "/")).toBeNull();
    expect(findTagIdByPath(undefined, "研究")).toBeNull();
  });
});

describe("resolveTagPaths", () => {
  beforeEach(() => api.mockReset());

  it("offline: existing tags resolve locally, new ones come back unresolved", async () => {
    const out = await resolveTagPaths(["研究/方法", "新"], { tags, online: false });
    expect(api).not.toHaveBeenCalled();
    expect(out).toEqual({ resolved: [{ path: "研究/方法", id: "m" }], unresolved: ["新"] });
  });

  it("online: the server is the authority", async () => {
    api.mockResolvedValue({ leaf_id: "server-id" });
    const out = await resolveTagPaths(["研究"], { tags, online: true });
    expect(out.resolved).toEqual([{ path: "研究", id: "server-id" }]);
  });

  it("server unreachable: falls back to the local catalog", async () => {
    // One rejection per call: a standing mockRejectedValue also rejects calls
    // made after the test, which vitest reports as this test's failure.
    api.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const out = await resolveTagPaths(["研究", "新"], { tags, online: true });
    expect(out).toEqual({ resolved: [{ path: "研究", id: "r" }], unresolved: ["新"] });
  });

  it("a deploy's gateway 502/503 or a timeout is unreachable too: local catalog", async () => {
    api.mockRejectedValueOnce(new ApiError(502, "<html>Bad Gateway</html>"))
      .mockRejectedValueOnce(new DOMException("Read timed out", "TimeoutError"));
    const out = await resolveTagPaths(["研究", "研究/方法"], { tags, online: true });
    expect(out).toEqual({ resolved: [{ path: "研究", id: "r" }, { path: "研究/方法", id: "m" }], unresolved: [] });
  });

  it("a server that answered (500, 429) was reached: no local substitute", async () => {
    api.mockRejectedValueOnce(new ApiError(500, "boom")).mockRejectedValueOnce(new ApiError(429, "slow down"));
    const out = await resolveTagPaths(["研究", "研究/方法"], { tags, online: true });
    expect(out).toEqual({ resolved: [], unresolved: ["研究", "研究/方法"] });
  });

  it("server refusal: no local substitute", async () => {
    api.mockRejectedValueOnce(new ApiError(403, "forbidden"));
    const out = await resolveTagPaths(["研究"], { tags, online: true });
    expect(out).toEqual({ resolved: [], unresolved: ["研究"] });
  });

  it("a tag the server created is added to the local catalog (我的標籤)", async () => {
    const fresh = { id: "new", name: "研究", parent_id: null };
    api.mockImplementation(async (path: string) =>
      path === "/api/tags" ? [fresh] : { leaf_id: "new", created_ids: ["new"] });
    const out = await resolveTagPaths(["研究"], { tags: [], online: true });
    expect(out.resolved).toEqual([{ path: "研究", id: "new" }]);
    expect(api).toHaveBeenCalledWith("/api/tags");
    expect(getAppState().data.tags).toEqual([fresh]);
  });

  it("an existing tag does not refetch the catalog", async () => {
    api.mockResolvedValueOnce({ leaf_id: "r", created_ids: [] });
    await resolveTagPaths(["研究"], { tags, online: true });
    expect(api).toHaveBeenCalledTimes(1);
  });
});
