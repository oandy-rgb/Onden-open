// The task writer's standalone-task surface (docs/architecture/tasks-module.md):
// creating a task with no note, the new date fields on update, and putting a
// task into / taking it out of a note. The request each sends is what the
// server's routes take; the local copy follows the same shape the server
// answers (both names of the day, flags as booleans, someday for "later").
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  upsertTask: vi.fn(), removeTask: vi.fn(), upsertNode: vi.fn(),
  addPendingWrite: vi.fn(), getPendingWrites: vi.fn(),
}));
import { ApiError, noWorkspaceData, type Bootstrap, type NodeTask } from "../lib/api";
import * as db from "../lib/localDb";
import { makeTaskWriter, rowChanges } from "../lib/data/taskWriter";
import { WriteActionError } from "../lib/data/writeErrors";
import { setPending } from "../lib/data/syncStatus";
import type { DataCtx } from "../lib/data/types";
import { setLocalePref } from "../lib/i18n";

const task: NodeTask = { id: "t1", node_id: "n1", title: "Task", status: "todo", due_date: "2026-09-08", when_date: "2026-09-08", recur: "1w" };
function harness(online = true, tasks: NodeTask[] = [task]) {
  let state: Bootstrap = { ...noWorkspaceData, tasks };
  const ctx: DataCtx = {
    get data() { return state; }, online,
    setData: (update) => { state = typeof update === "function" ? update(state) : update; },
    addToast: vi.fn(), scheduleUserFolderSync: vi.fn(), refresh: vi.fn(async () => {}),
  };
  return { ctx, get: () => state };
}
const sent = () => mocks.api.mock.calls.map(([path, init]) => ({ path, method: init?.method, body: init?.body ? JSON.parse(init.body as string) : undefined }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(db.getPendingWrites).mockResolvedValue([]);
  setPending(0); setLocalePref("en");
});

describe("rowChanges: a patch as the task row holds it", () => {
  it("keeps the day under both its column names", () => {
    expect(rowChanges({ when_date: "2026-10-02" })).toEqual({ when_date: "2026-10-02", due_date: "2026-10-02" });
    expect(rowChanges({ when_date: null })).toEqual({ when_date: null, due_date: null });
  });
  it("reads a cleared flag as off and the old 'later' as todo + someday", () => {
    expect(rowChanges({ evening: null, someday: false })).toEqual({ evening: false, someday: false });
    expect(rowChanges({ status: "later" })).toEqual({ status: "todo", someday: true });
    expect(rowChanges({ status: "done" })).toEqual({ status: "done" });
  });
  it("moves a wall-clock reminder with its task, leaves an exact moment, and takes a reminder named in the patch as it is (scan 10 #11)", () => {
    const task = { when_date: "2026-11-16", due_date: "2026-11-16", time: "15:00", remind_at: "2026-11-16T14:45" };
    expect(rowChanges({ when_date: "2026-11-18" }, task)).toEqual({ when_date: "2026-11-18", due_date: "2026-11-18", remind_at: "2026-11-18T14:45" });
    expect(rowChanges({ time: "17:00" }, task)).toEqual({ time: "17:00", remind_at: "2026-11-16T16:45" });
    expect(rowChanges({ time: "17:00", remind_at: "2026-11-16T08:00" }, task)).toEqual({ time: "17:00", remind_at: "2026-11-16T08:00" });
    expect(rowChanges({ when_date: "2026-11-18" }, { ...task, remind_at: "2026-11-16T06:45:00.000Z" })).toEqual({ when_date: "2026-11-18", due_date: "2026-11-18" });
  });
});

describe("createStandaloneTask", () => {
  it("posts /api/tasks with the client's id and only the fields that are set, and shows the task at once with no note", async () => {
    const h = harness();
    mocks.api.mockImplementation(async (_path: string, init: RequestInit) => ({ ...JSON.parse(init.body as string), node_id: null, status: "todo", space_id: "s1" }));
    const result = await makeTaskWriter(h.ctx).createStandaloneTask("  Buy milk ", { when: "2026-10-24", evening: true, deadline: "2026-10-30", recurMode: "after", recur: "3d", remindAt: "2026-10-24T18:00" });
    expect(result).toMatchObject({ status: "synced" });
    const [call] = sent();
    expect(call).toMatchObject({ path: "/api/tasks", method: "POST" });
    expect(call!.body).toEqual({
      id: expect.any(String), title: "Buy milk", when_date: "2026-10-24", evening: true, deadline: "2026-10-30",
      recur: "3d", recur_mode: "after", remind_at: "2026-10-24T18:00",
    });
    expect(h.get().tasks.find((row) => row.id === call!.body.id)).toMatchObject({
      node_id: null, title: "Buy milk", when_date: "2026-10-24", due_date: "2026-10-24", evening: true, recur_mode: "after", space_id: "s1",
    });
    expect(db.upsertTask).toHaveBeenCalled();
  });

  it("names the space when asked, and a task created under a note still posts to that note", async () => {
    const h = harness();
    mocks.api.mockResolvedValue({});
    await makeTaskWriter(h.ctx).createStandaloneTask("In a shared space", { spaceId: "space-1", someday: true });
    await makeTaskWriter(h.ctx).create("n1", "Under a note", { when: "2026-10-01" });
    const [standalone, under] = sent();
    expect(standalone).toMatchObject({ path: "/api/tasks", body: { title: "In a shared space", someday: true, space_id: "space-1" } });
    expect(under).toMatchObject({ path: "/api/nodes/n1/tasks", body: { title: "Under a note", when_date: "2026-10-01" } });
  });

  it("offline it is queued, keeps its id, and is not lost when the write is refused", async () => {
    const h = harness(false);
    const queued = await makeTaskWriter(h.ctx).createStandaloneTask("Later", { when: "2026-10-24" });
    expect(queued).toMatchObject({ status: "queued" });
    expect(mocks.api).not.toHaveBeenCalled();
    expect(vi.mocked(db.addPendingWrite)).toHaveBeenCalledWith("POST", "/api/tasks", expect.stringContaining("\"title\":\"Later\""), expect.any(String));
    expect(h.get().tasks).toContainEqual(expect.objectContaining({ title: "Later", node_id: null, when_date: "2026-10-24" }));
  });
});

describe("updating the new fields", () => {
  it("sends the fields as given (null clears) and the local row follows", async () => {
    const h = harness();
    mocks.api.mockResolvedValue({});
    await makeTaskWriter(h.ctx).patch("t1", { when_date: "2026-10-02", evening: true, deadline: "2026-10-09", recur_mode: "after", remind_at: null });
    expect(sent()[0]).toMatchObject({ path: "/api/tasks/t1", method: "PATCH", body: { when_date: "2026-10-02", evening: true, deadline: "2026-10-09", recur_mode: "after", remind_at: null } });
    expect(h.get().tasks[0]).toMatchObject({ when_date: "2026-10-02", due_date: "2026-10-02", evening: true, deadline: "2026-10-09", recur_mode: "after", recur: "1w" });
  });
  it("a refused change gives the old values back, both names of the day included", async () => {
    const h = harness();
    mocks.api.mockRejectedValue(new ApiError(422, "Invalid change"));
    await makeTaskWriter(h.ctx).patch("t1", { when_date: "2026-10-02", someday: true }).catch(() => {});
    expect(h.get().tasks[0]).toMatchObject({ when_date: "2026-09-08", due_date: "2026-09-08" });
    expect(h.get().tasks[0]!.someday).toBeFalsy();
  });
});

describe("placeTask / unplaceTask", () => {
  const standalone: NodeTask = { id: "t2", node_id: null, title: "Loose", status: "todo", space_id: "s1" };

  it("places the task into the note, takes the server's answer and refreshes the note", async () => {
    const h = harness(true, [standalone]);
    mocks.api.mockResolvedValue({ ...standalone, node_id: "n1", block_ref: "ab12cd" });
    await expect(makeTaskWriter(h.ctx).placeTask("t2", "n1", "k3f9")).resolves.toBe("ab12cd");
    expect(sent()[0]).toMatchObject({ path: "/api/tasks/t2/place", method: "POST", body: { note_id: "n1", after_block_ref: "k3f9" } });
    expect(h.get().tasks[0]).toMatchObject({ id: "t2", node_id: "n1" });
    expect(h.get().tasks[0]).not.toHaveProperty("block_ref");
    expect(db.upsertTask).toHaveBeenCalledWith(expect.objectContaining({ id: "t2", node_id: "n1" }));
    expect(h.ctx.refresh).toHaveBeenCalled();
  });

  it("takes it out again: standalone, the same task", async () => {
    const h = harness(true, [{ ...standalone, node_id: "n1" }]);
    mocks.api.mockResolvedValue({ ...standalone, node_id: null });
    await makeTaskWriter(h.ctx).unplaceTask("t2");
    expect(sent()[0]).toMatchObject({ path: "/api/tasks/t2/unplace", method: "POST" });
    expect(h.get().tasks[0]).toMatchObject({ id: "t2", node_id: null });
    expect(h.ctx.refresh).toHaveBeenCalled();
  });

  it("needs a connection and nothing waiting in the queue: it says so and sends nothing", async () => {
    const offline = harness(false, [standalone]);
    await expect(makeTaskWriter(offline.ctx).placeTask("t2", "n1")).rejects.toBeInstanceOf(WriteActionError);
    const online = harness(true, [standalone]);
    vi.mocked(db.getPendingWrites).mockResolvedValue([{ id: 1 } as never]);
    await expect(makeTaskWriter(online.ctx).unplaceTask("t2")).rejects.toBeInstanceOf(WriteActionError);
    expect(mocks.api).not.toHaveBeenCalled();
    expect(online.get().tasks[0]).toMatchObject({ node_id: null });
  });
});
