// A late, older answer must not put an older field name back into the editor (and from there into the next whole-list save).
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/localDb", () => ({
  upsertNode: vi.fn(), addPendingWrite: vi.fn(), getPendingWrites: vi.fn(async () => []), clearPendingWrite: vi.fn(async () => {}),
  storeRejectedWrite: vi.fn(async (request, rejection) => ({ ...request, id: 301, attempts: 0, rejection })),
}));

import { useSchemaDraft } from "../components/tagPage/structure/useSchemaDraft";
import { resetAppState, useTagRows } from "../lib/appStore";
import type { Tag } from "../lib/api";
import { ownerData } from "./ownerData";
import { memoryQueue } from "./helpers/memoryQueue";
import { addPendingWrite, getPendingWrites, clearPendingWrite } from "../lib/localDb";

const TAG = "tag-1";
const old = [{ name: "Old name", type: "text" }];
const row = { id: TAG, name: "book", color: "", schema_id: null, schema_fields: old, schema_behaviour: {} } as unknown as Tag;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.api.mockReset();
  memoryQueue({ addPendingWrite, getPendingWrites, clearPendingWrite });
  resetAppState({ online: true, data: { ...ownerData, tags: [row] } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("a read answered after the rename was saved does not bring the old name back", async () => {
  let answerRead!: (rows: unknown[]) => void;
  mocks.api.mockImplementation((path: string) => {
    if (path === "/api/tags") return new Promise((resolve) => { answerRead = resolve; }); // the read the editor makes, held back
    return Promise.resolve({});                                                              // the schema PATCH
  });
  // The tag as the page gets it: the live row of the store.
  const { result } = renderHook(() => {
    const tag = useTagRows()!.find((candidate) => candidate.id === TAG)!;
    return useSchemaDraft({ tag });
  });
  act(() => { result.current.setFields([{ name: "New name", type: "text" }]); result.current.save({ fields: [{ name: "New name", type: "text" }] }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); // debounce, then the PATCH is answered
  expect(result.current.status).toBe("saved");
  await act(async () => { answerRead?.([{ ...row, schema_fields: old }]); await vi.advanceTimersByTimeAsync(0); }); // the older answer
  expect(result.current.fields.map((f) => f.name)).toEqual(["New name"]);
});
