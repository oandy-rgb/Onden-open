// A tag can sit in the tag list (`data.tags`) without its note row being loaded (a slim session, a tag no loaded note
// uses). Hiding it and having the server refuse must still put the list's flag back (tagWriter.setHidden): the refusal
// compared only the note row, found none, and left the tag hidden on screen though the server never hid it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/localDb", () => ({
  upsertNode: vi.fn(async () => {}), removeNode: vi.fn(async () => {}),
  addPendingWrite: vi.fn(), getPendingWrites: vi.fn(async () => []), clearPendingWrite: vi.fn(async () => {}),
  storeRejectedWrite: vi.fn(async (request: object, rejection: string) => ({ ...request, id: 301, attempts: 0, rejection })),
}));

import { ApiError, type Bootstrap, type ContentNode, type Tag } from "../lib/api";
import { addPendingWrite, getPendingWrites, clearPendingWrite } from "../lib/localDb";
import { makeTagWriter } from "../lib/data/tagWriter";
import { memoryQueue } from "./helpers/memoryQueue";
import { ownerData } from "./ownerData";
import { setPending } from "../lib/data/syncStatus";
import type { DataCtx } from "../lib/data/types";

const TAG = "00000000-0000-4000-8000-0000000000a1";

function harness(withNoteRow: boolean) {
  const tag = { id: TAG, name: "toread", color: null, schema_id: null, hidden: false } as unknown as Tag;
  const row = { id: TAG, title: "toread", node_type: "tag", hidden: false } as unknown as ContentNode;
  let state = { ...ownerData, nodes: withNoteRow ? [row] : [], tags: [tag] } as Bootstrap;
  const ctx: DataCtx = {
    get data() { return state; }, online: true,
    setData: (update) => { state = typeof update === "function" ? update(state) : update; },
    addToast: vi.fn(), scheduleUserFolderSync: vi.fn(), refresh: vi.fn(async () => {}),
  };
  return {
    writer: makeTagWriter(ctx),
    listHidden: () => state.tags!.find((t) => t.id === TAG)!.hidden === true,
    noteHidden: () => state.nodes.find((n) => n.id === TAG)?.hidden === true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.mockReset();
  memoryQueue({ addPendingWrite, getPendingWrites, clearPendingWrite });
  setPending(0);
});

describe("hiding a tag the server refuses puts the flag back where it shows", () => {
  it("the tag is only in the tag list", async () => {
    const h = harness(false);
    mocks.api.mockRejectedValueOnce(new ApiError(403, JSON.stringify({ error: "forbidden" })));
    const hiding = h.writer.setHidden(TAG, true);
    expect(h.listHidden()).toBe(true); // shown at once
    await expect(hiding).rejects.toBeTruthy();
    expect(h.listHidden()).toBe(false);
  });

  it("the tag is in the tag list and its note row is loaded: both go back", async () => {
    const h = harness(true);
    mocks.api.mockRejectedValueOnce(new ApiError(403, JSON.stringify({ error: "forbidden" })));
    await expect(h.writer.setHidden(TAG, true)).rejects.toBeTruthy();
    expect([h.listHidden(), h.noteHidden()]).toEqual([false, false]);
  });

  it("a later hide still waiting is not undone by the earlier one's refusal", async () => {
    const h = harness(false);
    let refuseFirst!: (e: unknown) => void;
    mocks.api.mockImplementationOnce(() => new Promise((_, reject) => { refuseFirst = reject; }));
    mocks.api.mockResolvedValueOnce({}); // the second save, sent once the first has its answer (one lane per tag)
    const first = h.writer.setHidden(TAG, true);
    const second = h.writer.setHidden(TAG, false);
    expect(h.listHidden()).toBe(false);
    await vi.waitFor(() => expect(refuseFirst).toBeTypeOf("function"));
    refuseFirst(new ApiError(403, JSON.stringify({ error: "forbidden" })));
    await expect(first).rejects.toBeTruthy();
    expect(h.listHidden()).toBe(false); // the person's last choice stays
    await second;
    expect(h.listHidden()).toBe(false);
  });
});
