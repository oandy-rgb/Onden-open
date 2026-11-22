import { describe, it, expect, vi, beforeEach } from "vitest";

// Ink/handwriting saves used to bypass the offline queue (raw `void fetch`),
// so a stroke drawn offline was lost. saveInk routes them through
// the same write-through contract as propertyWriter.set:
//   offline  → queue for the reconnect drain
//   online   → sendOrQueue (transport/5xx queues; 4xx toasts, never queues)
//   always   → mirror the value locally (cold-start reload survival)

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: apiMock }; // real ApiError class, mocked transport
});
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  addPendingWrite: vi.fn(async () => null),
  getPendingWrites: vi.fn(async () => []),
  clearPendingWrite: vi.fn(async () => {}),
  upsertAttribute: vi.fn(async () => null),
  removeAttribute: vi.fn(async () => null),
}));

import { ApiError } from "../lib/api";
import { addPendingWrite, upsertAttribute as upsertAttributeLocal, clearPendingWrite, getPendingWrites } from "../lib/localDb";
import { memoryQueue } from "./helpers/memoryQueue";

// What is left queued once a write settled (every save is recorded first; see helpers/memoryQueue).
let queue: { rows: unknown[] };
import { saveInk } from "../lib/data/inkWriter";
import { wholeBody } from "../lib/data/patchedBody";
import type { InkDocument } from "../lib/ink/types";
import type { InkMultiPageDoc } from "../lib/pdf/pdfAdapter";

const PAGE = { version: 1, strokes: [], erased: {}, page: { width: 1000 } } as InkDocument;
import { setPending, getPendingCount } from "../lib/data/syncStatus";
import { getRecoveryWrites } from "../lib/data/writeRecovery";
import { setOnline, getAppState, dismissToast } from "../lib/appStore";

const reject422 = () => Promise.reject(new ApiError(422, JSON.stringify({ error: "field_invalid", detail: "nope" })));
const fail500 = () => Promise.reject(new ApiError(500, "internal"));
const transportFail = () => Promise.reject(new TypeError("Failed to fetch"));

// settle the microtasks the fire-and-forget helper kicks off (mirror + send)
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("saveInk durability", () => {
  beforeEach(() => {
    apiMock.mockReset();
    vi.mocked(addPendingWrite).mockClear(); queue = memoryQueue({ addPendingWrite, getPendingWrites, clearPendingWrite });
    vi.mocked(upsertAttributeLocal).mockClear();
    setPending(0);
    setOnline(true);
  });

  it("mirrors the value locally on every save (cold-start survival)", async () => {
    apiMock.mockResolvedValueOnce({});
    saveInk("node-1", PAGE);
    await flush();
    expect(upsertAttributeLocal).toHaveBeenCalledWith(
      "node-1", "ink_data", JSON.stringify(PAGE), "text", false, "ui",
    );
  });

  // The whiteboard's pen layer is the note's board_ink; ink_data is its handwriting page.
  it("a board's strokes are saved, mirrored and queued as board_ink — never as ink_data", async () => {
    apiMock.mockResolvedValueOnce({});
    saveInk("node-1", PAGE, null, { attr: "board_ink" });
    await flush();
    expect(apiMock).toHaveBeenCalledWith("/api/nodes/node-1/attributes/board_ink", expect.objectContaining({ method: "PUT" }));
    expect(apiMock).not.toHaveBeenCalledWith("/api/nodes/node-1/attributes/ink_data", expect.anything());
    expect(upsertAttributeLocal).toHaveBeenCalledWith("node-1", "board_ink", JSON.stringify(PAGE), "text", false, "ui");
    expect(upsertAttributeLocal).not.toHaveBeenCalledWith("node-1", "ink_data", expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it("a board save keeps its merge base on the wire, as a handwriting page does", async () => {
    setOnline(false);
    saveInk("node-1", PAGE, PAGE, { attr: "board_ink" });
    await flush();
    const [method, path, body] = vi.mocked(addPendingWrite).mock.calls[0]!;
    expect([method, path]).toEqual(["PUT", "/api/nodes/node-1/attributes/board_ink"]);
    expect(JSON.parse(String(body))).toMatchObject({ base_value: JSON.stringify(PAGE) });
  });

  it("a save made as the page goes away is remembered at once and sent as keepalive", async () => {
    apiMock.mockResolvedValueOnce({});
    saveInk("node-1", PAGE, undefined, { keepalive: true });
    // before anything is awaited: if the page dies now, recovery still has the strokes
    expect(getRecoveryWrites().map((w) => w.path)).toContain("/api/nodes/node-1/attributes/ink_data");
    await flush();
    expect(apiMock).toHaveBeenCalledWith("/api/nodes/node-1/attributes/ink_data", expect.objectContaining({ keepalive: true, method: "PUT" }));
  });

  it("an ordinary save is not remembered as unconfirmed (nothing is leaving)", async () => {
    apiMock.mockResolvedValueOnce({});
    saveInk("node-2", PAGE);
    expect(getRecoveryWrites().map((w) => w.path)).not.toContain("/api/nodes/node-2/attributes/ink_data");
    await flush();
  });

  it("offline: queues the write (never touches the network)", async () => {
    setOnline(false);
    expect(getAppState().online).toBe(false);
    saveInk("node-1", PAGE);
    await flush();
    expect(apiMock).not.toHaveBeenCalled();
    expect(queue.rows).toHaveLength(1);
    expect(getPendingCount()).toBe(1);
  });

  it("online transport failure: queues so the stroke survives", async () => {
    apiMock.mockImplementationOnce(transportFail);
    saveInk("node-1", PAGE);
    await flush();
    expect(queue.rows).toHaveLength(1);
    expect(getPendingCount()).toBe(1);
  });

  it("online 5xx: queues (worth retrying)", async () => {
    apiMock.mockImplementationOnce(fail500);
    saveInk("node-1", PAGE);
    await flush();
    expect(queue.rows).toHaveLength(1);
    expect(getPendingCount()).toBe(1);
  });

  it("online 4xx: definitive rejection — never queues (would poison the drain)", async () => {
    apiMock.mockImplementationOnce(reject422);
    saveInk("node-1", PAGE);
    await flush();
    expect(queue.rows).toEqual([]);
    expect(getPendingCount()).toBe(0);
  });

  it("saves a PDF's envelope — strokes and highlight records — as one ink_data write", async () => {
    setOnline(false);
    const envelope: InkMultiPageDoc = { version: 1, pages: { 1: PAGE }, annotations: [] };
    saveInk("pdf-1", envelope);
    await flush();
    expect(queue.rows).toHaveLength(1);
    const call = vi.mocked(addPendingWrite).mock.calls[0];
    expect(call?.[0]).toBe("PUT");
    expect(call?.[1]).toBe("/api/nodes/pdf-1/attributes/ink_data");
    expect(JSON.parse(String(call?.[2])).value).toBe(JSON.stringify(envelope));
  });
});

// D88: a save names the drawing it was made from, so the server merges it into
// what another device stored meanwhile instead of overwriting their strokes.
describe("saveInk base", () => {
  const S1 = { id: "s1", points: [[0, 0]], color: "#000", size: 2, toolId: "pen" } as InkDocument["strokes"][number];
  const drawn = { ...PAGE, strokes: [S1] } as InkDocument;
  const sentBody = (n = 0) => JSON.parse(String(vi.mocked(addPendingWrite).mock.calls[n]?.[2]));

  beforeEach(() => {
    apiMock.mockReset();
    vi.mocked(addPendingWrite).mockClear(); queue = memoryQueue({ addPendingWrite, getPendingWrites, clearPendingWrite });
    vi.mocked(upsertAttributeLocal).mockClear();
    setPending(0);
    setOnline(true);
  });

  it("an offline save keeps its base in the queue, so the replay merges", async () => {
    setOnline(false);
    saveInk("node-1", drawn, PAGE);
    await flush();
    expect(sentBody()).toEqual({ value: JSON.stringify(drawn), value_type: "text", is_inheritable: false, base_value: JSON.stringify(PAGE) });
  });

  it("a note that had no drawing sends an empty base; without one, none", async () => {
    setOnline(false);
    saveInk("node-1", drawn, null);
    saveInk("node-2", drawn);
    await flush();
    expect(sentBody(0).base_value).toBe("");
    expect(sentBody(1)).not.toHaveProperty("base_value");
  });

  it("the local copy takes what the server stored (the merge)", async () => {
    const merged = JSON.stringify({ ...drawn, strokes: [S1, { ...S1, id: "s2" }] });
    apiMock.mockResolvedValueOnce({ key: "ink_data", value: merged, value_type: "text" });
    saveInk("node-1", drawn, PAGE);
    await flush();
    await flush();
    expect(vi.mocked(upsertAttributeLocal).mock.calls.map((call) => call[2])).toEqual([JSON.stringify(drawn), merged]);
  });

  it("a drawing too large to send twice is queued with its base and goes whole without it (stored as sent)", async () => {
    setOnline(false);
    const points = Array.from({ length: 800_000 }, (_, i) => [i, i] as [number, number]);
    const huge = { ...PAGE, strokes: [{ ...S1, points }] } as InkDocument;
    saveInk("node-1", huge, huge);
    await flush();
    // the queue keeps the base (a patch against it is what is sent, patchedBody.ts) ...
    expect(sentBody()).toHaveProperty("base_value");
    // ... and the whole request, when it is the one sent, drops it
    const queued = vi.mocked(addPendingWrite).mock.calls[0]![2] as string;
    expect(JSON.parse(wholeBody("PUT", "/api/nodes/4e5b6a52-3c0e-4f53-a0a7-5d1c1d7c0f11/attributes/ink_data", queued) as string)).not.toHaveProperty("base_value");
  });
});

describe("saveInk never saves a read-only drawing (T1-0)", () => {
  beforeEach(() => {
    apiMock.mockReset();
    vi.mocked(addPendingWrite).mockClear(); queue = memoryQueue({ addPendingWrite, getPendingWrites, clearPendingWrite });
    vi.mocked(upsertAttributeLocal).mockClear();
    setPending(0);
    setOnline(true);
  });

  it("a page that requires an unknown feature is neither sent, queued nor mirrored", async () => {
    saveInk("node-1", { ...PAGE, requires: ["clips"] } as InkDocument);
    saveInk("node-1", { version: 1, pages: { 1: { ...PAGE, requires: ["clips"] } } } as InkMultiPageDoc);
    await flush();
    expect(apiMock).not.toHaveBeenCalled();
    expect(queue.rows).toEqual([]);
    expect(upsertAttributeLocal).not.toHaveBeenCalled();
  });

  it("features that are not required do not block the save", async () => {
    apiMock.mockResolvedValueOnce({});
    saveInk("node-1", { ...PAGE, features: ["clips"] } as InkDocument);
    await flush();
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});

// Owner 2026-11-20 (#1783): when the server's merge keeps another device's version of strokes this save changed, the
// person is told once (the conflict is in the inbox); the drawing on screen is not swapped.
describe("saveInk: telling the person when their version was not kept", () => {
  const h = (x: number) => ({ id: "h", points: [[x, 0], [x + 5, 5]] as [number, number][], color: "#000", size: 2, toolId: "pen" });
  const doc = (x: number) => JSON.stringify({ ...PAGE, strokes: [h(x)] });
  const base = doc(0), other = doc(10);
  const notice = "Another device changed the same strokes, and its version was kept. Yours is under Recent conflicts in the Inbox, where you can bring it back.";
  const answerFor = async (mine: string) => {
    const { mergeInk } = await import("@onden/markdown/ink");
    const merged = mergeInk(base, other, mine);
    return { key: "ink_data", value: merged.value, value_type: "text", is_inheritable: false, source: "ui", conflict: { ink_conflicts: merged.conflicts } };
  };
  const answerOnly = (mine: string, answer: object) => apiMock.mockImplementation(async (_path: string, init?: { body?: unknown }) => {
    const sent = typeof init?.body === "string" ? (JSON.parse(init.body) as { value?: unknown }).value : undefined;
    return sent === mine ? answer : {};
  });
  // The same reset as the other blocks: a write an earlier test left pending made this save queue behind it instead of
  // being answered (the cause of a 1-in-5 failure here).
  beforeEach(() => {
    apiMock.mockReset();
    vi.mocked(addPendingWrite).mockClear(); queue = memoryQueue({ addPendingWrite, getPendingWrites, clearPendingWrite });
    setPending(0);
    setOnline(true);
    for (const toast of getAppState().toasts) dismissToast(toast.id);
  });

  it("the merge kept the other device's h: one notice", async () => {
    const mine = doc(-5); // sorts before the other device's text: the merge keeps the other h
    const answer = await answerFor(mine);
    expect(answer.value).toBe(other);
    answerOnly(mine, answer);
    await saveInk("node-conflict-lost", mine, base);
    expect(getAppState().toasts.map((toast) => toast.message)).toEqual([notice]);
  });

  it("the merge kept this device's h: no notice", async () => {
    const mine = doc(20);
    const answer = await answerFor(mine);
    expect(answer.value).toBe(mine);
    answerOnly(mine, answer);
    await saveInk("node-conflict-kept", mine, base);
    expect(getAppState().toasts).toEqual([]);
  });
});

