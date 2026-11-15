import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deep review 2026-11-11 (docs/archive/deep-review-editor-2026-11-11.md): the smallest hand-built interleavings
// for the findings that reproduced. `it.fails` pins the CORRECT behaviour: the suite stays green while the bug
// exists, and turns red (so the marker must go) the day it is fixed.
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/localDb", () => ({
  getPendingWrites: vi.fn(async () => []),
  addPendingWrite: vi.fn(async () => null),
  upsertNode: vi.fn(async () => null),
  flushLocalDbSync: vi.fn(async () => {}),
}));

const { noWorkspaceData, api } = await import("../lib/api");
const { resetAppState, getAppState, setData } = await import("../lib/appStore");
const { bindAccountStorage } = await import("../lib/accountStorage");
const { resetDraftForNode, saveDraft, flushPendingSave, typeIntoDraft, applyRemoteNode, __resetDraftStateForTests } = await import("../lib/data/draftActions");

const row = (id: string, markdown: string) => ({ id, title: id.toUpperCase(), slug: id, markdown, source_type: "manual" as const, node_type: "content" as const });
type Sent = { path: string; markdown?: string; base_markdown?: string };
const sent: Sent[] = [];
let serverBody: Record<string, string> = {};

beforeEach(() => {
  bindAccountStorage("unit-test-account", "");
  __resetDraftStateForTests();
  sent.length = 0;
  serverBody = { a: "base", b: "other" };
  vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Sent;
    sent.push({ ...body, path });
    const id = /nodes\/([^/]+)/.exec(path)![1]!;
    serverBody[id] = body.markdown ?? serverBody[id]!;
    return row(id, serverBody[id]!) as never;
  });
});
afterEach(() => { __resetDraftStateForTests(); resetAppState(); vi.mocked(api).mockReset(); });

function open(id: "a" | "b") {
  resetAppState({ data: { ...noWorkspaceData, nodes: [row("a", "base"), row("b", "other")] }, selectedId: id, online: true });
  resetDraftForNode(row(id, serverBody[id]!));
}

describe("editor save: findings that reproduced", () => {
  // E1. scheduleAutosaveIfDirty (draftActions.ts) snapshots the node from the STORE's selection, not from the note
  // the editor shows (editorNodeId). Between the store selecting B and the effect that calls resetDraftForNode, text
  // typed for A (a late upload result via editNoteText, a composition ending) is saved as B's body.
  // Fix direction: snapshot getNode(editorNodeId), and drop the input when it is not the selected note.
  it("E1 typing tagged with the shown note, while the store already selects another, is saved to the shown note", async () => {
    open("a");
    // The store moved on (selectedId) but the effect that calls resetDraftForNode has not run yet.
    resetAppState({ data: { ...noWorkspaceData, nodes: [row("a", "base"), row("b", "other")] }, selectedId: "b", online: true });
    typeIntoDraft("a", { markdown: "base typed in A" });
    await flushPendingSave();
    expect(sent.map((s) => s.path)).not.toContain("/api/nodes/b");
  });

  // E2. The "typed back to the saved text" early return in flushPendingSave marks the note saved, but applyRemoteNode was
  // skipped while the draft was dirty and its effect only re-runs when the ROW text changes: the editor keeps the old
  // text, shown as saved, while the store holds the other device's newer body, until the next keystroke merges them.
  // Fix direction: on that early return (and after an accepted save), run applyRemoteNode(getNode(nodeId)) again.
  it("E2 a draft typed back to its base is shown as saved while the store holds a newer remote body", async () => {
    open("a");
    typeIntoDraft("a", { markdown: "base!" });
    // another device saves; the sync delta reaches the store; the editor's effect runs applyRemoteNode once.
    serverBody.a = "base\nremote line";
    setData((d) => ({ ...d, nodes: d.nodes.map((n) => n.id === "a" ? { ...n, markdown: serverBody.a! } : n) }));
    applyRemoteNode(row("a", serverBody.a!));
    typeIntoDraft("a", { markdown: "base" });
    await saveDraft("a");
    expect(getAppState().saveStatus).toBe("saved");
    expect(getAppState().overviewDraft).toBe(serverBody.a);
  });
});
