import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A save sends the text exactly as it was typed (段落錨點批 3): the page writes no `^id` into a note any more —
// a paragraph's identity is the server's anchor — so the draft, the body sent, the merge base kept for the next save and
// the server's copy are the same text, with nothing to wait for while the caret or an input method is in a block.
// (Before, the page added ids to the draft, held them back while the caret sat in the block, and a merge could move
// one onto a neighbour's line.)
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/localDb", () => ({
  getPendingWrites: vi.fn(async () => []),
  addPendingWrite: vi.fn(async () => null),
  upsertNode: vi.fn(async () => null),
  flushLocalDbSync: vi.fn(async () => {}),
}));

const { noWorkspaceData, api, ApiError } = await import("../lib/api");
const { resetAppState, getAppState } = await import("../lib/appStore");
const { bindAccountStorage } = await import("../lib/accountStorage");
const { resetDraftForNode, saveDraft, flushPendingSave, typeIntoDraft, __resetDraftStateForTests } = await import("../lib/data/draftActions");

const note = { id: "a", title: "A", slug: "a", markdown: "", source_type: "manual" as const, node_type: "content" as const };
type Sent = { markdown?: string; base_markdown?: string };
const sent: Sent[] = [];

function serverStoresWhatItGets() {
  vi.mocked(api).mockImplementation(async (_path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Sent;
    sent.push(body);
    return { ...note, markdown: body.markdown ?? "" } as never;
  });
}

function setup() {
  resetAppState({ data: { ...noWorkspaceData, nodes: [note] }, selectedId: "a", online: true });
  resetDraftForNode(note);
}

beforeEach(() => {
  bindAccountStorage("unit-test-account", "");
  __resetDraftStateForTests();
  sent.length = 0;
  serverStoresWhatItGets();
});
afterEach(() => { __resetDraftStateForTests(); resetAppState(); vi.mocked(api).mockReset(); });

describe("an editor save sends the text as typed", () => {
  it("a tagged block goes as typed, the draft is untouched, and the next save's base is that text", async () => {
    setup();
    typeIntoDraft("a", { markdown: "- item {t}" });
    await saveDraft("a");
    expect(sent[0]!.markdown).toBe("- item {t}");
    expect(getAppState().overviewDraft).toBe("- item {t}");

    typeIntoDraft("a", { markdown: "- item {t}\n- next" });
    await saveDraft("a");
    expect(sent[1]!.base_markdown).toBe("- item {t}");
    expect(sent[1]!.markdown).toBe("- item {t}\n- next");
    expect(getAppState().toasts.filter((toast) => /Merged/.test(toast.message))).toEqual([]);
  });

  it("a `^word` the person typed is kept as text, never read as an id", async () => {
    setup();
    typeIntoDraft("a", { markdown: "p {t} ^abc12\n\nsee [^1] and ^ here" });
    await saveDraft("a");
    expect(sent[0]!.markdown).toBe("p {t} ^abc12\n\nsee [^1] and ^ here");
  });

  it("a block being typed in is saved at once, as it stands", async () => {
    setup();
    typeIntoDraft("a", { markdown: "- item {t}" });
    await saveDraft("a");
    expect(getAppState().saveStatus).toBe("saved");
    expect(sent).toHaveLength(1);
  });

  it("a draft typed and typed back to the saved text is not sent, even by ⌘S", async () => {
    setup();
    typeIntoDraft("a", { markdown: "hello" });
    await saveDraft("a");
    expect(sent).toHaveLength(1);
    typeIntoDraft("a", { markdown: "hello!" });
    typeIntoDraft("a", { markdown: "hello" });
    await saveDraft("a");
    expect(sent).toHaveLength(1);
    expect(getAppState().saveStatus).toBe("saved");
    // The next real change still goes out, built on the text the server holds.
    typeIntoDraft("a", { markdown: "hello world" });
    await saveDraft("a");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.base_markdown).toBe("hello");
  });

  it("a page too old to write (426) keeps what was typed, waits in the queue and does not send it again by itself", async () => {
    setup();
    vi.mocked(api).mockRejectedValue(new ApiError(426, '{"error":"client_too_old"}'));
    typeIntoDraft("a", { markdown: "typed words {t}" });
    await saveDraft("a");
    expect(getAppState().saveStatus).toBe("queued"); // kept on this device for after the update, not refused
    expect(getAppState().overviewDraft).toBe("typed words {t}");
    const calls = vi.mocked(api).mock.calls.length;
    await flushPendingSave(); // autosave, switching notes, leaving: not a retry the person asked for
    expect(vi.mocked(api).mock.calls.length).toBe(calls); // the same refused text is not sent again
  });

  it("a note saved with nothing typed sends nothing", async () => {
    setup();
    await saveDraft("a");
    expect(sent).toHaveLength(0);
  });
});
