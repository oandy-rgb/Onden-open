// Every delete surface ends in nodeMutations.deleteNode. A task id (a row of `tasks`, no node in the note list) reaches
// the task writer instead of silently finding nothing to delete: the task sheet's 「刪除任務」 was a no-op because of it.
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 902, attempts: 0, rejection }),
  upsertTask: vi.fn(), removeTask: vi.fn(), upsertNode: vi.fn(), removeNode: vi.fn(),
  addPendingWrite: vi.fn(), getPendingWrites: vi.fn(),
}));
import { noWorkspaceData, type Bootstrap, type NodeTask } from "../lib/api";
import * as db from "../lib/localDb";
import { makeNodeMutations } from "../lib/data/nodeMutations";
import { setPending } from "../lib/data/syncStatus";
import type { DataCtx } from "../lib/data/types";
import { setLocalePref } from "../lib/i18n";

const task: NodeTask = { id: "t1", node_id: "n1", title: "寫期中報告", status: "todo" };
function harness(online = true) {
  let state: Bootstrap = { ...noWorkspaceData, tasks: [task] };
  const ctx: DataCtx = {
    get data() { return state; }, online,
    setData: (update) => { state = typeof update === "function" ? update(state) : update; },
    addToast: vi.fn(), scheduleUserFolderSync: vi.fn(), refresh: vi.fn(async () => {}),
  };
  return { ctx, mutations: makeNodeMutations(ctx), get: () => state };
}
const sent = () => mocks.api.mock.calls.map(([path, init]) => `${init?.method} ${path}`);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(db.getPendingWrites).mockResolvedValue([]);
  setPending(0); setLocalePref("en");
});

describe("deleting a task through the one delete (task sheet, any row)", () => {
  it("sends the delete, drops the task, and the toast offers Undo that sends the undelete", async () => {
    const h = harness();
    mocks.api.mockResolvedValue({ deleted: true });
    expect(await h.mutations.deleteNode("t1", "寫期中報告")).toBe(true);
    expect(sent()).toEqual(["DELETE /api/nodes/t1"]);
    expect(h.get().tasks).toEqual([]);
    const [message, , action] = vi.mocked(h.ctx.addToast).mock.calls.at(-1)!;
    expect(message).toBe('"寫期中報告" deleted'); // plain: no id, no technical word
    expect(action).toMatchObject({ label: "Undo" });
    action!.onClick();
    await vi.waitFor(() => expect(sent()).toContain("POST /api/nodes/t1/undelete"));
    await vi.waitFor(() => expect(h.ctx.refresh).toHaveBeenCalled()); // the task and its line come back with the refresh
  });

  it("offline: queued, and the toast says it was deleted locally (no Undo until the server has it)", async () => {
    const h = harness(false);
    expect(await h.mutations.deleteNode("t1", "寫期中報告")).toBe(true);
    expect(db.addPendingWrite).toHaveBeenCalledWith("DELETE", "/api/nodes/t1", null, expect.any(String));
    expect(vi.mocked(h.ctx.addToast).mock.calls.at(-1)![0]).toBe('"寫期中報告" deleted locally');
    expect(h.get().tasks).toEqual([]);
  });
});
