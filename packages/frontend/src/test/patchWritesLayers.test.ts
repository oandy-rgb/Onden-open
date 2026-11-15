import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyPatch, hashText } from "@onden/markdown";

// A drawing and a page's layers are saved as the whole value plus the value
// they were made from; what goes over the wire is a patch (lib/data/patchedBody.ts).
// A drawing too big to carry both whole keeps merging because of that.

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: apiMock };
});
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  addPendingWrite: vi.fn(async () => null),
  getPendingWrites: vi.fn(async () => []),
  upsertAttribute: vi.fn(async () => null),
  removeAttribute: vi.fn(async () => null),
}));

import { ApiError } from "../lib/api";
import { MAX_REQUEST_BYTES } from "@onden/markdown";
import { saveInk } from "../lib/data/inkWriter";
import { savePageLayer } from "../lib/data/pageLayerWriter";
import { patchedBody, wholeBody } from "../lib/data/patchedBody";
import { setPending } from "../lib/data/syncStatus";
import { setOnline } from "../lib/appStore";
import type { InkDocument } from "../lib/ink/types";

const flush = () => new Promise((r) => setTimeout(r, 0));
const stroke = (id: number) => ({
  id: `s${id}`, color: "#000", size: 2, toolId: "pen" as const,
  points: Array.from({ length: 40 }, (_, i) => [i * 3.25, i * 1.5 + 7, 0.5]) as [number, number, number][],
});
const drawing = (count: number): InkDocument => ({ version: 1, strokes: Array.from({ length: count }, (_, i) => stroke(i)), erased: {}, page: { width: 1000 } });
const NODE = "4e5b6a52-3c0e-4f53-a0a7-5d1c1d7c0f11";

const sent = () => apiMock.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string) as Record<string, unknown>);

describe("saving a drawing", () => {
  beforeEach(() => { apiMock.mockReset(); setPending(0); setOnline(true); });

  it("10,000 strokes plus one go out as a request under 50 KB", async () => {
    const base = drawing(10_000);
    const next = drawing(10_001);
    apiMock.mockResolvedValueOnce({});
    saveInk(NODE, next, base);
    await flush();
    const bytes = new TextEncoder().encode((apiMock.mock.calls[0]![1] as RequestInit).body as string).length;
    expect(bytes).toBeLessThan(50 * 1024);
    const body = sent()[0]!;
    expect(body.value).toBeUndefined();
    expect(body.base_value).toBeUndefined();
    expect(applyPatch(JSON.stringify(base), body.value_patch as never)).toBe(JSON.stringify(next));
  });

  it("30,000 strokes still carry their base: the patch is the merge base, nothing is dropped", async () => {
    const base = drawing(30_000);
    const next = drawing(30_001);
    apiMock.mockResolvedValueOnce({});
    saveInk(NODE, next, base);
    await flush();
    const body = sent()[0]!;
    expect((body.value_patch as { base_hash: string }).base_hash).toBe(hashText(JSON.stringify(base)));
    expect(JSON.stringify(body).length).toBeLessThan(50 * 1024);
  }, 60_000);

  it("a base the server cannot give back is answered by the whole drawing with its base (when both fit)", async () => {
    const base = drawing(2_000);
    const next = drawing(2_001);
    apiMock.mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: "patch_base_unknown" }))).mockResolvedValueOnce({});
    saveInk(NODE, next, base);
    await flush();
    const [first, second] = sent();
    expect(first!.value_patch).toBeDefined();
    expect(second).toMatchObject({ value: JSON.stringify(next), base_value: JSON.stringify(base) });
  });

  // 手寫存檔量 M1: a whole request too big for its base used to lose the base — the server then stored the value as sent and
  // another device's strokes saved in between were overwritten. It is merged into what the server stores instead.
  it("M1: a base the server cannot give back, on a drawing too big to carry it, is merged into the stored drawing and sent as a patch", async () => {
    const base = drawing(15_000);
    const mine: InkDocument = { ...base, strokes: [...base.strokes, stroke(90_001)] };
    const theirs: InkDocument = { ...base, strokes: [...base.strokes, stroke(90_002)] };
    expect(new TextEncoder().encode(JSON.stringify({ value: JSON.stringify(mine), base_value: JSON.stringify(base) })).length).toBeGreaterThan(MAX_REQUEST_BYTES - 1024 * 1024);
    apiMock
      .mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: "patch_base_unknown" })))
      .mockResolvedValueOnce([{ key: "ink_data", value: JSON.stringify(theirs) }])
      .mockResolvedValueOnce({});
    saveInk(NODE, mine, base);
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledTimes(3), { timeout: 30_000 });
    expect(apiMock.mock.calls[1]![0]).toBe(`/api/nodes/${NODE}/attributes?keys=ink_data`);
    const third = JSON.parse((apiMock.mock.calls[2]![1] as RequestInit).body as string) as { value?: string; base_value?: string; value_patch: never };
    expect(third.value).toBeUndefined();
    expect(third.base_value).toBeUndefined();
    const stored = JSON.stringify(theirs);
    const ids = (JSON.parse(applyPatch(stored, third.value_patch)) as InkDocument).strokes.map((x) => x.id);
    expect(ids).toContain("s90001");
    expect(ids).toContain("s90002");
    expect(ids.length).toBe(15_002);
  }, 120_000);

  it("a whole drawing too big to carry its base is sent without it (as before patches)", () => {
    const value = JSON.stringify(drawing(3));
    const filler = "x".repeat(MAX_REQUEST_BYTES);
    const body = JSON.stringify({ value, base_value: filler });
    const path = `/api/nodes/${NODE}/attributes/ink_data`;
    expect(JSON.parse(wholeBody("PUT", path, body) as string)).toEqual({ value });
    expect(wholeBody("PUT", path, JSON.stringify({ value, base_value: value }))).toBe(JSON.stringify({ value, base_value: value }));
    // a note body is never trimmed
    expect(wholeBody("PATCH", `/api/nodes/${NODE}`, JSON.stringify({ markdown: filler, base_markdown: filler }))).toContain("base_markdown");
  });
});

describe("saving a page layer", () => {
  beforeEach(() => { apiMock.mockReset(); setPending(0); setOnline(true); });

  it("page_text and page_images go out as patches when they are big enough to matter", async () => {
    for (const key of ["page_text", "page_images"]) {
      const base = JSON.stringify({ v: 1, pages: { "pdf:1": { boxes: Array.from({ length: 80 }, (_, i) => ({ id: `b${i}`, text: `box number ${i} with some words` })) } } });
      const next = base.replace("box number 3 ", "box number 3 EDITED ");
      apiMock.mockReset();
      apiMock.mockResolvedValueOnce({});
      savePageLayer(NODE, key, next, base);
      await flush();
      const body = sent()[0]!;
      expect(body.value).toBeUndefined();
      expect(applyPatch(base, body.value_patch as never)).toBe(next);
      expect(apiMock.mock.calls[0]![0]).toBe(`/api/nodes/${NODE}/attributes/${key}`);
    }
  });

  it("a small layer is sent whole, with its base", () => {
    const body = JSON.stringify({ value: "{\"a\":1}", base_value: "{}" });
    expect(patchedBody("PUT", `/api/nodes/${NODE}/attributes/page_text`, body)).toBeNull();
  });

  it("other attributes are never patched", () => {
    const big = "y".repeat(5000);
    expect(patchedBody("PUT", `/api/nodes/${NODE}/attributes/status`, JSON.stringify({ value: big + "1", base_value: big }))).toBeNull();
  });
});
