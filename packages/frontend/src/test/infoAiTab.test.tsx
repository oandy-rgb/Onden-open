import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ContentNode } from "../lib/api";

// The info panel's AI tab: the conversation is read back from the server when the note opens, the scope
// chips go to the server with the question, the answer streams with what the AI is doing, 「放進筆記」 writes
// like typing and can be undone, edits the AI proposed are decided from the answer, and with nobody able
// to answer the tab says why and where to fix it. No real API is reached: `api` and EventSource are fakes.
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []) }));
let mayEdit = true;
vi.mock("../lib/capabilities", async (original) => ({ ...await original<typeof import("../lib/capabilities")>(), useCapabilities: () => ({ canEdit: () => mayEdit }) }));
const { api, noWorkspaceData } = await import("../lib/api");
const { resetAppState } = await import("../lib/appStore");
const { setLocalePref } = await import("../lib/i18n");
const { drafts } = await import("../lib/data");
const { registerNoteEditor } = await import("../lib/editorInsert");
const { onSuggestionsChanged } = await import("../lib/aiSuggestionsBus");
const { pendingReveal, clearReveal } = await import("../lib/noteReveal");
const { default: InfoAiTab } = await import("../components/infoAi/InfoAiTab");

const apiMock = vi.mocked(api);
const mk = (id: string, title: string): ContentNode => ({ id, title, slug: id, markdown: "", node_type: "content", source_type: "manual", updated_at: "2026-10-01T00:00:00Z", space_id: "sp" });
const open = mk("open", "今天");
const project = mk("proj", "專案計畫");

const ROLES = { roles: [{
  actor_id: "r1", handle: "ai", name: "小助手", default_runtime: "api", reason: null, model_name: "m",
  runtimes: [{ kind: "api", available: true, unavailable_reason: null }, { kind: "mcp", available: false, unavailable_reason: "no_token" }],
}] };
const turn = (extra: Record<string, unknown> = {}) => ({
  session_id: "s1", text: "有哪些相關的筆記？", status: "completed", fail_code: null, reply: "看 [[專案計畫#^b1]] 那一段", runtime: "api",
  agent_name: "小助手", created_at: "2026-10-31T10:00:00Z", scope: { notes: [], tags: [] },
  sources: [{ node_id: "proj", title: "專案計畫", block_id: "b1" }], suggestions: { pending: 0, accepted: 0, rejected: 0 }, pending: [], ...extra,
});

class FakeEventSource {
  static last: FakeEventSource | null = null;
  static CLOSED = 2;
  readyState = 1;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeEventSource.last = this; }
  close() { this.readyState = 2; }
  send(frame: object) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

let roles: unknown = ROLES;
let turns: unknown[] = [];
function route() {
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/ai/panel-chat/open/roles") return roles;
    if (path === "/api/ai/panel-chat/open" && !init?.method) return { turns };
    if (path === "/api/ai/panel-chat" && init?.method === "POST") return { session_id: "s2", created: true };
    if (path === "/api/ai/panel-chat/open" && init?.method === "DELETE") { turns = []; return { cleared: 1 }; }
    if (path.startsWith("/api/ai-suggestions/")) return { accepted: ["i1"], rejected: ["i1"] };
    if (path.endsWith("/cancel")) return { session: { id: "s2", status: "cancelled" }, changed: true };
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  });
}
const sent = (method: string, prefix: string) => apiMock.mock.calls.filter(([p, init]) => String(p).startsWith(prefix) && init?.method === method);
const bodyOf = (method: string, prefix: string) => JSON.parse(String(sent(method, prefix)[0]![1]!.body));

const mount = (props: { onSelectNode?: (id: string) => void; canEdit?: boolean } = {}) => {
  resetAppState({ data: { ...noWorkspaceData, nodes: [open, project, mk("sec", "祕密計畫")], tags: [{ id: "t1", name: "專案", color: "", schema_id: null }] as never, actor_is_owner: true }, online: true });
  mayEdit = props.canEdit ?? true;
  return render(<InfoAiTab node={open} onSelectNode={props.onSelectNode ?? (() => {})} />);
};

beforeEach(() => {
  apiMock.mockReset();
  setLocalePref("en");
  roles = ROLES; turns = [];
  vi.spyOn(drafts, "flush").mockResolvedValue(true);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("confirm", () => true);
  FakeEventSource.last = null;
  clearReveal();
  route();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetAppState(); });

describe("the conversation comes back with the note", () => {
  it("shows the earlier question, answer and sources after a reopen, and a source opens its note at the paragraph", async () => {
    turns = [turn()];
    const onSelectNode = vi.fn();
    mount({ onSelectNode });
    expect(await screen.findByText("有哪些相關的筆記？")).toBeInTheDocument();
    expect(document.querySelector(".note-ai-text")?.textContent).toContain("專案計畫"); // link brackets are not shown
    expect(document.querySelector(".note-ai-text")?.textContent).not.toContain("[[");
    fireEvent.click(within(screen.getByLabelText("Sources")).getByRole("button", { name: /專案計畫/ }));
    expect(onSelectNode).toHaveBeenCalledWith("proj");
    expect(pendingReveal("proj")).toBe("b1");
  });

  it("an answer still being written is followed from where the stream is, with what the AI is doing", async () => {
    turns = [turn({ session_id: "s9", status: "running", reply: null, sources: [] })];
    mount();
    await waitFor(() => expect(FakeEventSource.last?.url).toContain("/api/ai/selection-actions/s9/stream"));
    act(() => FakeEventSource.last!.send({ kind: "step", what: "read", title: "專案計畫" }));
    expect(await screen.findByText("Reading “專案計畫”…")).toBeInTheDocument();
    act(() => FakeEventSource.last!.send({ kind: "text", text: "先寫" }));
    act(() => FakeEventSource.last!.send({ kind: "restart" }));
    act(() => FakeEventSource.last!.send({ kind: "text", text: "最後的答案" }));
    expect(screen.getByText("最後的答案")).toBeInTheDocument();
    expect(screen.queryByText(/先寫/)).toBeNull();
    turns = [turn({ session_id: "s9", reply: "最後的答案", sources: [] })];
    act(() => FakeEventSource.last!.send({ kind: "end", status: "completed", fail_code: null }));
    await waitFor(() => expect(screen.queryByText("Stop")).toBeNull());
    expect(screen.getByText("最後的答案")).toBeInTheDocument();
  });

  it("clearing asks first, empties the conversation on the server, and keeps the note alone", async () => {
    turns = [turn()];
    mount();
    await screen.findByText("有哪些相關的筆記？");
    fireEvent.click(screen.getByRole("button", { name: "Clear this conversation" }));
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() => expect(sent("DELETE", "/api/ai/panel-chat/open")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("有哪些相關的筆記？")).toBeNull());
  });
});

describe("the answer is Markdown, drawn by the app's one reader", () => {
  const answered = async (reply: string) => {
    turns = [turn({ reply, sources: [] })];
    mount();
    await screen.findByText("有哪些相關的筆記？");
    return document.querySelector(".note-ai-text") as HTMLElement;
  };

  it("bold, a list, a heading, code and a link are drawn, not shown as typed", async () => {
    const answer = await answered("## 小標\n\n**標題小錯**\n\n- 第一項\n- 第二項\n\n`code` 與 [網站](https://example.com/a)");
    expect(answer.querySelector("h2")?.textContent).toBe("小標");
    expect(answer.querySelector("strong")?.textContent).toBe("標題小錯");
    expect([...answer.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["第一項", "第二項"]);
    expect(answer.querySelector("code")?.textContent).toBe("code");
    expect(answer.querySelector("a")?.getAttribute("href")).toBe("https://example.com/a");
    expect(answer.textContent).not.toContain("**");
    expect(answer.textContent).not.toContain("- 第一項");
  });

  it("the AI's text is untrusted: an <img onerror> stays text and no element is made from it", async () => {
    const answer = await answered('看 <img src=x onerror="alert(1)"> 與 <script>alert(2)</script>');
    expect(answer.querySelector("img, script")).toBeNull();
    expect(answer.textContent).toContain("onerror");
  });

  it("the question stays plain text", async () => {
    turns = [turn({ text: "**不要變粗**", sources: [] })];
    mount();
    expect((await screen.findByText("**不要變粗**")).tagName).toBe("P");
  });
});

describe("the AI's reach: chips", () => {
  it("@ offers notes and tags except the open one; choosing one makes a chip (the @word goes), the chip can be removed, and the question carries the rest", async () => {
    mount();
    const box = await screen.findByLabelText("Ask the AI");
    fireEvent.change(box, { target: { value: "比較一下 @專案" } });
    const list = await screen.findByRole("listbox");
    expect(within(list).queryByText("今天")).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: /專案計畫/ }));
    expect(box).toHaveValue("比較一下");
    expect(screen.getByRole("button", { name: "Remove 專案計畫 from the AI's reach" })).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "比較一下 @專案" } });
    fireEvent.click(within(await screen.findByRole("listbox")).getByRole("button", { name: /Tag.*專案$/ }));
    expect(screen.getByRole("button", { name: "Remove 專案 from the AI's reach" })).toBeInTheDocument();
    // a tag and a note already chosen are not offered again
    fireEvent.change(box, { target: { value: "x @專案" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(box, { target: { value: "比較一下" } });

    fireEvent.click(screen.getByRole("button", { name: "Remove 專案 from the AI's reach" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send question" })); });
    await waitFor(() => expect(sent("POST", "/api/ai/panel-chat")).toHaveLength(1));
    expect(bodyOf("POST", "/api/ai/panel-chat")).toMatchObject({
      agent_actor_id: "r1", node_id: "open", text: "比較一下", runtime: "api", scope_note_ids: ["proj"], scope_tag_ids: [],
    });
    expect(drafts.flush).toHaveBeenCalled(); // the server reads the saved note
    await waitFor(() => expect(FakeEventSource.last?.url).toContain("/s2/stream"));
    expect(box).toHaveValue(""); // asked: the box is empty again
  });

  it("a question that could not be sent stays in the box", async () => {
    vi.mocked(drafts.flush).mockResolvedValue(false);
    mount();
    const box = await screen.findByLabelText("Ask the AI");
    fireEvent.change(box, { target: { value: "別弄丟" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send question" })); });
    expect(sent("POST", "/api/ai/panel-chat")).toHaveLength(0);
    expect(box).toHaveValue("別弄丟");
  });
});

describe("the answer goes into the note on the person's say-so", () => {
  it("at the editor's caret (or the end when it never had one) like typing: not a suggestion", async () => {
    turns = [turn({ reply: "可以放進去的答案", sources: [] })];
    const insert = vi.fn();
    const off = registerNoteEditor("open", insert);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Put into the note" }));
    await waitFor(() => expect(insert).toHaveBeenCalledWith("\n\n可以放進去的答案\n", { endIfNoCaret: true }));
    expect(sent("POST", "/api/ai-suggestions")).toHaveLength(0);
    const { getAppState } = await import("../lib/appStore");
    expect(getAppState().toasts.some((x) => x.message === "Put into the note." && x.action?.label === "Undo")).toBe(true);
    off();
  });

  it("without an open editor it is added at the end of the note's text, and undone exactly", async () => {
    turns = [turn({ reply: "答案", sources: [] })];
    let text = "內文";
    vi.spyOn(drafts, "editText").mockImplementation(async (_id, change) => { text = change(text); return "applied"; });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Put into the note" }));
    await waitFor(() => expect(text).toBe("內文\n\n答案\n"));
    const { getAppState } = await import("../lib/appStore");
    await act(async () => { getAppState().toasts.find((x) => x.action?.label === "Undo")!.action!.onClick(); });
    await waitFor(() => expect(text).toBe("內文"));
  });

  it("undo leaves the text alone once the answer has been edited", async () => {
    turns = [turn({ reply: "答案", sources: [] })];
    let text = "內文";
    vi.spyOn(drafts, "editText").mockImplementation(async (_id, change) => { text = change(text); return "applied"; });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Put into the note" }));
    await waitFor(() => expect(text).toBe("內文\n\n答案\n"));
    text = "內文\n\n答案，我改過\n";
    const { getAppState } = await import("../lib/appStore");
    await act(async () => { getAppState().toasts.find((x) => x.action?.label === "Undo")!.action!.onClick(); });
    await waitFor(() => expect(getAppState().toasts.some((x) => /left in/.test(x.message))).toBe(true));
    expect(text).toBe("內文\n\n答案，我改過\n");
  });

  it("a reader cannot put it in, but can read and copy", async () => {
    turns = [turn()];
    mount({ canEdit: false });
    await screen.findByText("有哪些相關的筆記？");
    expect(screen.queryByRole("button", { name: "Put into the note" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });
});

describe("edits the AI proposed are suggestions, decided from the answer", () => {
  const withEdits = () => turn({
    suggestions: { pending: 2, accepted: 0, rejected: 0 },
    pending: [{ suggestion_id: "g1", item_id: "i1" }, { suggestion_id: "g1", item_id: "i2" }],
  });

  it("says how many places, and accepts them all through the suggestion routes (never a direct note write)", async () => {
    turns = [withEdits()];
    const changes: Array<{ nodeId: string; noteChanged: boolean }> = [];
    const off = onSuggestionsChanged((c) => changes.push(c));
    mount();
    expect(await screen.findByText("Suggested 2 changes")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Accept all" })); });
    await waitFor(() => expect(sent("POST", "/api/ai-suggestions/g1/accept")).toHaveLength(1));
    expect(bodyOf("POST", "/api/ai-suggestions/g1/accept")).toEqual({ item_ids: ["i1", "i2"] });
    expect(drafts.flush).toHaveBeenCalled(); // accepting writes the note: the text on screen is saved first
    await waitFor(() => expect(changes).toContainEqual({ nodeId: "open", noteChanged: true }));
    expect(apiMock.mock.calls.some(([p, init]) => /^\/api\/nodes\//.test(String(p)) && init?.method === "PATCH")).toBe(false);
    off();
  });

  it("discards them all with a reject, and the note is not saved first", async () => {
    turns = [withEdits()];
    mount();
    await screen.findByText("Suggested 2 changes");
    vi.mocked(drafts.flush).mockClear();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Discard all" })); });
    await waitFor(() => expect(sent("POST", "/api/ai-suggestions/g1/reject")).toHaveLength(1));
    expect(drafts.flush).not.toHaveBeenCalled();
  });

  it("a reader sees the count but no buttons to decide", async () => {
    turns = [withEdits()];
    mount({ canEdit: false });
    expect(await screen.findByText("Suggested 2 changes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept all" })).toBeNull();
    expect(screen.getByRole("button", { name: "See in the note" })).toBeInTheDocument();
  });
});

describe("when nobody can answer", () => {
  it("no AI set up: says so, points to the settings, and shows no box to type in", async () => {
    roles = { roles: [] };
    mount();
    expect(await screen.findByText(/No AI is set up yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open AI settings" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Ask the AI")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send question" })).toBeNull();
  });

  it("a role whose only way is unavailable says why in the settings' words", async () => {
    roles = { roles: [{ ...ROLES.roles[0]!, runtimes: [{ kind: "api", available: false, unavailable_reason: "no_key" }] }] };
    mount();
    expect(await screen.findByText("No API key.")).toBeInTheDocument();
  });

  it("a failed answer says why in a sentence, without codes", async () => {
    turns = [turn({ status: "failed", fail_code: "cap_reached", reply: null, sources: [] })];
    mount();
    expect(await screen.findByText("This AI has reached its monthly limit.")).toBeInTheDocument();
  });
});

describe("the tab's Chinese wording travels with the tab", () => {
  it("is registered when the tab's code loads, next to the boot dictionary", async () => {
    const { t } = await import("../lib/i18n");
    const { default: _tab } = await import("../components/infoAi"); // what NodeInspector loads
    void _tab;
    setLocalePref("zh-TW");
    expect(t("Ask the AI")).toBe("問 AI");
    expect(t("Suggested {n} changes", { n: 2 })).toBe("提了 2 處修改");
    expect(t("Open")).not.toBe("Open"); // the boot dictionary is still there
  });
});
