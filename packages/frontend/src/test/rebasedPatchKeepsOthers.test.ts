// lib/data/rebasedPatch: a queued drawing write too big to send whole, whose patch base the server no longer has, is merged
// here into what the server stores now and sent as a patch against that (scan 09 M1). PR #1783 review round 3: even when
// that merge leaves out the writer's version of a stroke both changed, the merge is what goes — sending the writer's value
// whole instead would replace what is stored and silently hide another device's new strokes.
import { describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/api")>()), api: apiMock }));

import { applyPatch, type TextPatch } from "@onden/markdown";
import { decodeInk, encodeInk, mergeInk, type InkDocument, type InkStroke } from "@onden/markdown/ink";
import { rebasedOnStored } from "../lib/data/rebasedPatch";

const NODE = "4e5b6a52-3c0e-4f53-a0a7-5d1c1d7c0f11";
const PATH = `/api/nodes/${NODE}/attributes/ink_data`;
const stroke = (id: string, x = 0): InkStroke => ({ id, points: [[x, 0], [x + 5, 5]], color: "#000", size: 2, toolId: "pen" });
const page = (strokes: InkStroke[]): string => encodeInk({ version: 1, strokes, erased: {}, page: { width: 1000 } } as InkDocument);
const xOf = (raw: string, id: string) => { const d = decodeInk(raw); return d.kind === "page" ? d.doc.strokes.find((s) => s.id === id)?.points[0]?.[0] : undefined; };

describe("rebasedOnStored keeps another device's strokes when the writer's version loses", () => {
  it("B drew b and moved h; A (not reloaded) moved h too and lost: the patch is the merge, b is in it", async () => {
    const base = page([stroke("h", 0)]);
    const stored = page([stroke("h", 10), stroke("b", 30)]);
    // A's x for h that the fixed order puts first, so the merge keeps B's h (the case the review named).
    const aX = [20, -5, -40, 80].find((x) => xOf(mergeInk(base, stored, page([stroke("h", x)])).value, "h") === 10)!;
    expect(aX).toBeDefined();
    const mine = page([stroke("h", aX)]);
    apiMock.mockResolvedValueOnce([{ key: "ink_data", value: stored }]);
    const out = JSON.parse((await rebasedOnStored("PUT", PATH, JSON.stringify({ value: mine, base_value: base })))!) as { value_patch: TextPatch };
    const sent = applyPatch(stored, out.value_patch);
    expect(sent).toBe(mergeInk(base, stored, mine).value);
    expect(xOf(sent, "b")).toBe(30); // B's new stroke stays
  });
});
