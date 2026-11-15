import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A draft save only the offline queue accepted shows "queued". When the queue
// drains it becomes "saved" only if its replay was not refused: a refused
// replay also leaves the queue (it moves to recovery), so a drained queue
// alone never means saved (AGENTS.md: zero pending is not "all saved").
const replay = vi.hoisted(() => ({ rejections: 0, recovery: [] as { id: string; path: string; rejection?: string }[] }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/localDb", () => ({
  getPendingWrites: vi.fn(async () => []),
  addPendingWrite: vi.fn(async () => null),
  upsertNode: vi.fn(async () => null),
  flushLocalDbSync: vi.fn(async () => {}),
}));
vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  getReplayRejectionRevision: () => replay.rejections,
}));
vi.mock("../lib/data/writeRecovery", async (original) => ({
  ...await original<typeof import("../lib/data/writeRecovery")>(),
  getRecoveryWrites: () => replay.recovery,
}));

const { noWorkspaceData, api, ApiError } = await import("../lib/api");
const { resetAppState, getAppState } = await import("../lib/appStore");
const { bindAccountStorage } = await import("../lib/accountStorage");
const { resetDraftForNode, queuedDraftOutcome, saveDraft, typeIntoDraft, __resetDraftStateForTests } = await import("../lib/data/draftActions");

const note = { id: "a", title: "A", slug: "a", markdown: "before", source_type: "manual" as const, node_type: "content" as const };

async function queueDraft(text: string) {
  // The server is unavailable: the save is durably queued.
  vi.mocked(api).mockRejectedValueOnce(new ApiError(503, "unavailable"));
  typeIntoDraft("a", { markdown: text });
  await saveDraft("a");
  expect(getAppState().saveStatus).toBe("queued");
}

beforeEach(() => {
  bindAccountStorage("unit-test-account", "");
  replay.rejections = 0; replay.recovery = [];
  __resetDraftStateForTests();
  resetAppState({ data: { ...noWorkspaceData, nodes: [note] }, selectedId: "a", online: true });
  resetDraftForNode(note);
});
afterEach(() => { __resetDraftStateForTests(); resetAppState(); });

describe("a queued draft once the queue drains", () => {
  it("is saved when no replay was refused", async () => {
    await queueDraft("offline text");
    expect(queuedDraftOutcome("a")).toBe("saved");
  });

  it("is rejected when its own replay was refused", async () => {
    await queueDraft("offline text");
    replay.rejections = 1;
    replay.recovery = [{ id: "r1", path: "/api/nodes/a", rejection: "No write permission" }];
    expect(queuedDraftOutcome("a")).toBe("rejected");
  });

  it("is saved when only another note's replay was refused", async () => {
    await queueDraft("offline text");
    replay.rejections = 1;
    replay.recovery = [{ id: "r1", path: "/api/nodes/b", rejection: "No write permission" }];
    expect(queuedDraftOutcome("a")).toBe("saved");
  });

  it("stays rejected after the recovery copy is dismissed", async () => {
    await queueDraft("offline text");
    replay.rejections = 1;
    replay.recovery = [{ id: "r1", path: "/api/nodes/a", rejection: "No write permission" }];
    expect(queuedDraftOutcome("a")).toBe("rejected");
    replay.recovery = [];
    expect(queuedDraftOutcome("a")).toBe("rejected");
  });

  it("an older refusal of this note plus a new refusal of another note does not make it rejected", async () => {
    replay.recovery = [{ id: "old", path: "/api/nodes/a", rejection: "earlier" }];
    await queueDraft("offline text");
    replay.rejections = 1;
    replay.recovery = [...replay.recovery, { id: "new", path: "/api/nodes/b", rejection: "No write permission" }];
    expect(queuedDraftOutcome("a")).toBe("saved");
  });

  it("is never called saved for a note whose queued save it does not know", () => {
    expect(queuedDraftOutcome("other")).toBe("rejected");
  });
});
