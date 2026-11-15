import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ api: vi.fn(), stored: vi.fn() }));
vi.mock("../lib/api", async (orig) => ({ ...(await orig<typeof import("../lib/api")>()), api: h.api }));
vi.mock("../lib/data/sync", () => ({ localCopy: { body: h.stored } }));

import { reads } from "../lib/data/reads";

beforeEach(() => { h.api.mockReset(); h.stored.mockReset(); });

describe("reads.notes.body", () => {
  it("returns an open row's body without any read", async () => {
    expect(await reads.notes.body({ id: "a", markdown: "text" })).toBe("text");
    expect(await reads.notes.body({ id: "a", markdown: "" })).toBe("");
    expect(h.api).not.toHaveBeenCalled();
  });
  it("reads a slim row from this device first (offline works)", async () => {
    h.stored.mockResolvedValue("stored body");
    expect(await reads.notes.body({ id: "a", markdown: "", body_len: 5 })).toBe("stored body");
    expect(h.api).not.toHaveBeenCalled();
  });
  it("asks the server when the device has no copy, and answers null when nothing can", async () => {
    h.stored.mockResolvedValue(null);
    h.api.mockResolvedValueOnce({ markdown: "from server" });
    expect(await reads.notes.body({ id: "a", markdown: "", body_len: 5 })).toBe("from server");
    h.api.mockRejectedValueOnce(new Error("offline"));
    expect(await reads.notes.body({ id: "a", markdown: "", body_len: 5 })).toBeNull();
  });
});
