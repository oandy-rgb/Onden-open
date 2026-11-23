// Bringing a note back from the trash, and unpinning, while offline: the write is queued, and the person is told so
// (otherwise nothing on screen changes and the button gets pressed again). The pin also leaves the sidebar at once,
// and comes back if the server refuses.
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: apiMock }));
vi.mock("../lib/localDb", () => ({
  getPendingWrites: vi.fn(async () => []), addPendingWrite: vi.fn(), clearPendingWrite: vi.fn(async () => {}),
  upsertNode: vi.fn(), storeRejectedWrite: vi.fn(async (request, rejection) => ({ ...request, id: 301, attempts: 0, rejection })),
}));

import { ApiError } from "../lib/api";
import { writersFor, writeErrors } from "../lib/data";
import { unpinPointer } from "../lib/data/pointerWriter";
import { getAppState, resetAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";
import { addPendingWrite, getPendingWrites, clearPendingWrite } from "../lib/localDb";
import { memoryQueue } from "./helpers/memoryQueue";
import { ownerData } from "./ownerData";
import { setPending } from "../lib/data/syncStatus";

let queue: ReturnType<typeof memoryQueue>;
const pin = { id: "p1", target_id: "t1", parent_id: "n1", sort_order: 0 } as never;
beforeEach(() => {
  apiMock.mockReset();
  queue = memoryQueue({ addPendingWrite, getPendingWrites, clearPendingWrite });
  setPending(0);
  setLocalePref("en");
  resetAppState({ online: false, data: { ...ownerData, pointers: [pin] } });
});

describe("a write that is queued says so", () => {
  it("bringing a note back offline: the queued undelete is announced once", async () => {
    const toasts: Array<[string, string | undefined]> = [];
    const history = writersFor({ online: false, notify: (message, kind) => { toasts.push([message, kind]); } }).history;
    expect(await history.undelete("n1")).toEqual({ status: "queued" });
    expect(queue.rows.map((row) => [row.method, row.path])).toEqual([["POST", "/api/nodes/n1/undelete"]]);
    expect(toasts).toEqual([[writeErrors.queuedMessage(), "info"]]);
  });

  it("unpinning offline: the pin leaves the sidebar now and the queued delete is announced", async () => {
    await unpinPointer("p1");
    expect(getAppState().data.pointers).toEqual([]);
    expect(queue.rows.map((row) => [row.method, row.path])).toEqual([["DELETE", "/api/pointers/p1"]]);
    expect(getAppState().toasts.map((toast) => toast.message)).toEqual([writeErrors.queuedMessage()]);
  });

  it("unpinning online but refused: the pin is back, and the refusal is reported once", async () => {
    resetAppState({ online: true, data: { ...ownerData, pointers: [pin] } });
    apiMock.mockRejectedValue(new ApiError(403, "forbidden"));
    await expect(unpinPointer("p1")).rejects.toBeInstanceOf(ApiError);
    expect(getAppState().data.pointers).toEqual([pin]);
    expect(getAppState().toasts.filter((toast) => toast.kind === "error")).toHaveLength(1);
  });
});
