// A day note's id is derived from (space, date), so the server — or another
// device — may have made today's note before this device knew. The server then
// answers the create 409 note_exists and openDay opens that note: the person
// must not see a failure or a recovery entry for it (WriteRequest.existingNoteIsFine).
// These tests run the real write queue; only the HTTP layer and local DB are faked.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/appStore", async (original) => ({ ...await original<typeof import("../lib/appStore")>(), addToast: mocks.toast }));
vi.mock("../lib/localDb", () => ({
  catchUpWithOtherTabs: vi.fn(), getOldestPendingWriteAt: vi.fn(), addPendingWrite: vi.fn(), getPendingWrites: vi.fn(), clearPendingWrite: vi.fn(),
  bumpPendingWriteAttempt: vi.fn(), rejectPendingWrite: vi.fn(), storeRejectedWrite: vi.fn(), getRejectedWrites: vi.fn(), dismissRejectedWrite: vi.fn(),
  upsertNode: vi.fn(async () => {}), removeNode: vi.fn(async () => {}), upsertAttribute: vi.fn(async () => {}),
}));
const space = vi.hoisted(() => ({ id: "11111111-2222-4333-8444-555555555555" }));
vi.mock("../lib/spaces", async (original) => ({ ...await original<typeof import("../lib/spaces")>(), personalSpaceId: () => space.id }));

import { ApiError, noWorkspaceData, type Bootstrap, type ContentNode } from "../lib/api";
import { bindAccountStorage } from "../lib/accountStorage";
import { getPendingWrites, getRejectedWrites, storeRejectedWrite } from "../lib/localDb";
import { forgetAbandonedAttempts } from "../lib/data/writeQueue";
import { getRecoveryWrites, refreshRecoveryWrites } from "../lib/data/writeRecovery";
import { dayNoteId, makeDayNotes } from "../lib/data/dayNotes";
import type { DataCtx } from "../lib/data/types";
import { setPending } from "../lib/data/syncStatus";
import { setLocalePref } from "../lib/i18n";
import { todayId } from "../lib/localDate";

const noteExists = () => new ApiError(409, JSON.stringify({ error: "note_exists" }));
const startedByServer = (): ContentNode => ({
  id: dayNoteId(space.id, todayId()), title: todayId(), slug: todayId(), markdown: "from a recurring task",
  source_type: "manual", node_type: "content", space_id: space.id,
});

/** One device whose reload brings `serverNodes()`. */
function device(serverNodes: () => ContentNode[]) {
  let state: Bootstrap = { ...noWorkspaceData, nodes: [] };
  const addToast = vi.fn();
  const ctx: DataCtx = {
    get data() { return state; }, online: true,
    setData: (update) => { state = typeof update === "function" ? update(state) : update; },
    addToast, scheduleUserFolderSync: vi.fn(),
    refresh: vi.fn(async () => { state = { ...state, nodes: serverNodes() }; }),
  };
  return { ctx, notes: makeDayNotes(ctx), nodes: () => state.nodes, addToast };
}
const posts = () => mocks.api.mock.calls.filter(([path, init]) => path === "/api/nodes" && init?.method === "POST");

beforeEach(async () => {
  bindAccountStorage("day-note-exists", "");
  forgetAbandonedAttempts();
  vi.resetAllMocks();
  localStorage.clear();
  setLocalePref("en");
  setPending(0);
  vi.mocked(getRejectedWrites).mockResolvedValue([]);
  vi.mocked(getPendingWrites).mockResolvedValue([]);
  vi.mocked(storeRejectedWrite).mockImplementation(async (request, reason) => ({ ...request, id: 1, attempts: 0, rejection: reason }));
  await refreshRecoveryWrites();
});

describe("opening a day note the server already started", () => {
  it("opens the existing note: no recovery entry, no error shown", async () => {
    const server = startedByServer();
    mocks.api.mockRejectedValue(noteExists());
    const d = device(() => [server]);
    const opened = await d.notes.openToday();
    expect(opened).toMatchObject({ created: false, node: { id: server.id, markdown: "from a recurring task" } });
    expect(getRecoveryWrites()).toEqual([]);
    expect(storeRejectedWrite).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(d.addToast).not.toHaveBeenCalled();
    expect(d.nodes().map((n) => n.id)).toEqual([server.id]); // the optimistic copy was replaced, not doubled
  });

  it("still reports a different refusal of the same create", async () => {
    mocks.api.mockRejectedValue(new ApiError(403, JSON.stringify({ error: "forbidden" })));
    const d = device(() => []);
    await expect(d.notes.openToday()).rejects.toBeInstanceOf(ApiError);
    expect(getRecoveryWrites()).toHaveLength(1); // the recovery panel is the report
  });

  it("keeps the person's text when a seeded create is refused: nothing is opened over it, recovery holds the scaffold", async () => {
    const server = startedByServer();
    mocks.api.mockRejectedValue(noteExists());
    const d = device(() => [server]);
    const opened = await d.notes.openToday({ create: { markdown: "## Plan\n- [ ] write the report" } });
    // The note is still opened (the designed path) ...
    expect(opened).toMatchObject({ created: false, node: { id: server.id } });
    // ... but the scaffold that was refused is kept, not dropped.
    expect(getRecoveryWrites()).toEqual([expect.objectContaining({ rejection: expect.any(String), body: expect.stringContaining("write the report") })]);
  });

  it("two openDay calls at once on one device send one create key and open one note", async () => {
    // First answer commits the note, the repeat of the same Idempotency-Key is deduped.
    const keys: string[] = [];
    let committed = false;
    mocks.api.mockImplementation(async (_path: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get("Idempotency-Key")!);
      const sent = JSON.parse(init.body as string) as ContentNode;
      if (committed) return { deduped: true };
      committed = true;
      return { ...sent, slug: sent.title, markdown: "" };
    });
    const d = device(() => [{ ...startedByServer(), markdown: "" }]);
    const [a, b] = await Promise.all([d.notes.openToday(), d.notes.openToday()]);
    expect(posts()).toHaveLength(2);
    expect(new Set(keys)).toEqual(new Set([dayNoteId(space.id, todayId())]));
    expect(a!.node.id).toBe(b!.node.id);
    expect(d.nodes().filter((n) => n.title === todayId())).toHaveLength(1);
    expect(getRecoveryWrites()).toEqual([]);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
