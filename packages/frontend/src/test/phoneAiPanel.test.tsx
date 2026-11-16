import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ContentNode } from "../lib/api";
import { loadNoteFunctionModules } from "./helpers/noteFunctionModules";

// The AI conversation in its two frames. The info panel's tab (a wide screen) and the phone's bottom panel are
// ONE conversation component: what is asked in one is there in the other after a width change, because it is
// the same server-side conversation. The phone's panel has three heights (bar, half, full) over a note that
// stays usable; Back and Esc go down one height at a time. No real API is reached: `api` and EventSource are fakes.
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []) }));
const { api, noWorkspaceData } = await import("../lib/api");
const { resetAppState } = await import("../lib/appStore");
const { setLocalePref } = await import("../lib/i18n");
const { drafts } = await import("../lib/data");
const { toggleNoteAi, dismissNoteAi, setNoteAiHeight } = await import("../lib/notePhoneAi");
const { default: InfoAiTab } = await import("../components/infoAi/InfoAiTab");
const { PhoneAiPanel } = await import("../components/infoAi");
const { default: NotePhoneAiHost } = await import("../components/NotePhoneAiHost");
const { default: NodeInspector } = await import("../components/NodeInspector");
// The info panel asks for its modules' files with import() as it mounts; they are loaded first so that no test ends while one is still on its way.
await loadNoteFunctionModules();

const apiMock = vi.mocked(api);
const note: ContentNode = { id: "open", title: "今天", slug: "open", markdown: "", node_type: "content", source_type: "manual", updated_at: "2026-10-01T00:00:00Z", space_id: "sp" };
const ROLES = { roles: [{
  actor_id: "r1", handle: "ai", name: "小助手", default_runtime: "api", reason: null, model_name: "m",
  runtimes: [{ kind: "api", available: true, unavailable_reason: null }, { kind: "mcp", available: false, unavailable_reason: "no_token" }],
}] };
const turn = (extra: Record<string, unknown> = {}) => ({
  session_id: "s1", text: "有哪些相關的筆記？", status: "completed", fail_code: null, reply: "這是答案的第一句，後面還有很長的說明", runtime: "api",
  agent_name: "小助手", created_at: "2026-10-31T10:00:00Z", scope: { notes: [], tags: [] },
  sources: [], suggestions: { pending: 0, accepted: 0, rejected: 0 }, pending: [], ...extra,
});

class FakeEventSource {
  static CLOSED = 2;
  readyState = 1;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  close() { this.readyState = 2; }
}

let roles: unknown = ROLES;
let turns: unknown[] = [];
let asked: Array<Record<string, unknown>> = [];
function route() {
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/ai/panel-chat/open/roles") return roles;
    if (path === "/api/ai/panel-chat/open" && !init?.method) return { turns };
    if (path === "/api/ai/panel-chat" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      asked.push(body);
      turns = [...turns, turn({ session_id: `q${asked.length}`, text: body.text, status: body.runtime === "api" ? "running" : "queued", reply: null, runtime: body.runtime })];
      return { session_id: `q${asked.length}`, created: true };
    }
    if (path.endsWith("/cancel")) { turns = turns.map((x) => ({ ...(x as object), status: "cancelled" })); return { session: { status: "cancelled" }, changed: true }; }
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  });
}
const sent = (suffix: string) => apiMock.mock.calls.filter(([p, init]) => String(p).endsWith(suffix) && init?.method === "POST");

function setPhone(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
const originalMatchMedia = window.matchMedia;

// A new visit: the store holds one note at a time, so naming another leaves nothing of this note's panel.
const newVisit = () => setNoteAiHeight("a-note-nobody-reads", "bar");
const seed = () => resetAppState({ data: { ...noWorkspaceData, nodes: [note], tags: [] as never, actor_is_owner: true }, online: true });
const dock = () => document.querySelector<HTMLElement>(".ui-sheet-dock");
const height = () => dock()?.getAttribute("data-height");
const esc = () => fireEvent.keyDown(window, { key: "Escape" });

beforeEach(() => {
  apiMock.mockReset();
  setLocalePref("en");
  setPhone(true);
  roles = ROLES; turns = []; asked = [];
  newVisit();
  vi.spyOn(drafts, "flush").mockResolvedValue(true);
  vi.stubGlobal("EventSource", FakeEventSource);
  seed();
  route();
});
afterEach(() => { cleanup(); newVisit(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.matchMedia = originalMatchMedia; resetAppState(); });

const phone = () => render(<PhoneAiPanel node={note} onSelectNode={() => {}} />);

describe("one conversation, two frames", () => {
  it("what is asked in the phone's panel is there in the info panel's tab after a width change, and the other way round", async () => {
    toggleNoteAi(note.id);
    const first = phone();
    fireEvent.click(await screen.findByRole("button", { name: "Summarize this note" }));
    await waitFor(() => expect(asked).toHaveLength(1));
    first.unmount();

    setPhone(false);
    render(<InfoAiTab node={note} onSelectNode={() => {}} />);
    expect(await screen.findByText("Summarize this note.")).toBeInTheDocument();
    // The wide frame is the same component: the same box, and no row of chips while this note is all the AI reads.
    expect(screen.getByLabelText("Ask the AI")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "What the AI will read" })).toBeNull();
  });

  it("the info panel has no AI tab on a phone (the AI is the panel over the note), and keeps it beside the note", () => {
    const panel = () => render(<NodeInspector node={note} onSelectNode={() => {}} onRunNoteCommand={() => {}} />);
    const phoneView = panel();
    expect(screen.getByRole("tab", { name: "Functions" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "AI" })).toBeNull();
    phoneView.unmount();
    setPhone(false);
    panel();
    expect(screen.getByRole("tab", { name: "AI" })).toBeInTheDocument();
  });
});

describe("the phone's panel: three heights", () => {
  it("opens at half; the header goes full and back; Esc goes down one height at a time, and stops at the bar", async () => {
    toggleNoteAi(note.id);
    phone();
    await waitFor(() => expect(height()).toBe("half"));
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    expect(height()).toBe("full");
    esc();
    expect(height()).toBe("half");
    esc();
    expect(height()).toBe("bar");
    esc();
    expect(height()).toBe("bar"); // the bar stays; Back then leaves the note as usual
    expect(dock()).not.toBeNull();
  });

  // Back reaches a page as the browser's close request (CloseWatcher), through the one dismiss stack (useDismiss).
  const fakeCloseWatchers = () => {
    const live: Array<{ onclose: (() => void) | null; destroyed: boolean }> = [];
    class FakeCloseWatcher {
      onclose: (() => void) | null = null; destroyed = false;
      constructor() { live.push(this); }
      destroy() { this.destroyed = true; }
    }
    vi.stubGlobal("CloseWatcher", FakeCloseWatcher);
    return { back: () => { const w = [...live].reverse().find((x) => !x.destroyed)!; act(() => w.onclose?.()); }, open: () => live.filter((x) => !x.destroyed).length };
  };

  it("system Back goes full → half → bar and then is no longer the panel's (the page's own Back leaves the note)", async () => {
    const watchers = fakeCloseWatchers();
    toggleNoteAi(note.id);
    phone();
    await waitFor(() => expect(height()).toBe("half"));
    act(() => setNoteAiHeight(note.id, "full"));
    await waitFor(() => expect(height()).toBe("full"));
    watchers.back();
    expect(height()).toBe("half");
    watchers.back();
    expect(height()).toBe("bar");
    expect(watchers.open()).toBe(0); // nothing left to take Back: it leaves the note as usual
  });

  it("with the keyboard up in the panel the first Back only closes the keyboard; the next one lowers the panel", async () => {
    const watchers = fakeCloseWatchers();
    let resize = () => {};
    const vv = { height: 800, offsetTop: 0, addEventListener: (_: string, fn: () => void) => { resize = fn; }, removeEventListener() {} };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    toggleNoteAi(note.id);
    phone();
    await waitFor(() => expect(height()).toBe("half"));
    const box = await screen.findByLabelText("Ask the AI");
    box.focus();
    vv.height = 400; act(() => resize());
    await waitFor(() => expect(dock()).toHaveAttribute("data-keyboard"), { timeout: 2000 });
    watchers.back();
    expect(document.activeElement).not.toBe(box);
    expect(height()).toBe("half");
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    watchers.back();
    expect(height()).toBe("bar");
  });

  it("the bar says what is going on, opens half when tapped, and can be dismissed; the top bar's button brings it back", async () => {
    turns = [turn()];
    toggleNoteAi(note.id);
    phone();
    await screen.findByText("有哪些相關的筆記？");
    act(() => setNoteAiHeight(note.id, "bar"));
    const bar = within(dock()!).getByRole("status");
    expect(bar).toHaveTextContent("這是答案的第一句，後面還有很長的說明");
    fireEvent.click(bar);
    expect(height()).toBe("half");
    act(() => setNoteAiHeight(note.id, "bar"));
    fireEvent.click(screen.getByRole("button", { name: "Hide the AI bar" }));
    expect(dock()).toBeNull();
    act(() => toggleNoteAi(note.id));
    expect(height()).toBe("half");
  });

  it("an answer that is pending keeps the bar on screen even after it was dismissed, with no way to hide it", async () => {
    turns = [turn({ status: "queued", reply: null, runtime: "mcp", created_at: new Date().toISOString() })];
    toggleNoteAi(note.id);
    dismissNoteAi(note.id);
    phone();
    await waitFor(() => expect(height()).toBe("bar"));
    expect(within(dock()!).getByRole("status")).toHaveTextContent("Waiting for your computer…");
    expect(screen.queryByRole("button", { name: "Hide the AI bar" })).toBeNull();
  });

  it("the note above stays usable while the bar shows: no modal layer, nothing inert, typing goes through", async () => {
    toggleNoteAi(note.id);
    render(<><textarea aria-label="the note" defaultValue="" /><PhoneAiPanel node={note} onSelectNode={() => {}} /></>);
    await waitFor(() => expect(height()).toBe("half"));
    act(() => setNoteAiHeight(note.id, "bar"));
    const editor = screen.getByLabelText("the note");
    editor.focus();
    fireEvent.change(editor, { target: { value: "還能打字" } });
    expect(editor).toHaveValue("還能打字");
    expect(document.querySelector("dialog")).toBeNull();
    expect(editor.closest("[inert]")).toBeNull();
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(document.activeElement).toBe(editor);
  });

  it("another note keeps nothing of this note's panel on screen (the host mounts it only for the note it was opened for)", async () => {
    toggleNoteAi(note.id);
    const other = { ...note, id: "other", title: "別的筆記" };
    const { rerender } = render(<NotePhoneAiHost node={note} onSelectNode={() => {}} />);
    await waitFor(() => expect(dock()).not.toBeNull());
    rerender(<NotePhoneAiHost node={other} onSelectNode={() => {}} />);
    expect(dock()).toBeNull();
    // Back on the first note in the same visit the panel is only a conversation again, not an open one.
    act(() => toggleNoteAi("other"));
    await waitFor(() => expect(dock()).not.toBeNull());
    rerender(<NotePhoneAiHost node={note} onSelectNode={() => {}} />);
    expect(dock()).toBeNull();
  });
});

describe("empty state and starters", () => {
  it("one short line that keeps the promise, and three starters that each send a question", async () => {
    toggleNoteAi(note.id);
    phone();
    expect(await screen.findByText("Ask about this note. The AI changes nothing until you agree.")).toBeInTheDocument();
    const starters = within(screen.getByRole("list", { name: "Ways to start" })).getAllByRole("button").map((b) => b.textContent);
    expect(starters).toEqual(["Summarize this note", "Find related notes", "Suggest improvements"]);
    fireEvent.change(screen.getByLabelText("Ask the AI"), { target: { value: "半句話" } });
    fireEvent.click(screen.getByRole("button", { name: "Find related notes" }));
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toMatchObject({ text: "Which other notes relate to this one?", node_id: "open" });
    expect(screen.getByLabelText("Ask the AI")).toHaveValue("半句話"); // a starter leaves the box alone
  });
});

describe("the question box", () => {
  const box = async () => screen.findByLabelText("Ask the AI");
  const type = async (text: string) => { fireEvent.change(await box(), { target: { value: text } }); };

  it("a wide screen: Enter sends, Shift+Enter is a new line, and an IME candidate's Enter never sends", async () => {
    setPhone(false);
    render(<InfoAiTab node={note} onSelectNode={() => {}} />);
    await type("你");
    fireEvent.keyDown(await box(), { key: "Enter", shiftKey: true });
    fireEvent.keyDown(await box(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(await box(), { key: "Enter", keyCode: 229 });
    expect(sent("/api/ai/panel-chat")).toHaveLength(0);
    await act(async () => { fireEvent.keyDown(await box(), { key: "Enter" }); });
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toMatchObject({ text: "你" });
  });

  it("a phone: Enter is a new line; ⌘/Ctrl+Enter sends; the send button is an icon with a name, disabled while empty", async () => {
    toggleNoteAi(note.id);
    phone();
    const send = await screen.findByRole("button", { name: "Send question" });
    expect(send).toBeDisabled();
    await type("問題");
    expect(send).toBeEnabled();
    const enter = fireEvent.keyDown(await box(), { key: "Enter" });
    expect(enter).toBe(true); // not prevented: the browser adds the new line
    expect(sent("/api/ai/panel-chat")).toHaveLength(0);
    await act(async () => { fireEvent.keyDown(await box(), { key: "Enter", ctrlKey: true }); });
    await waitFor(() => expect(asked).toHaveLength(1));
  });

  it("is one line when empty and has no resize handle (the box grows itself, up to six lines)", async () => {
    toggleNoteAi(note.id);
    phone();
    expect((await box()).getAttribute("rows")).toBe("1");
  });

  it("the chips appear once something is added: this note, fixed (no ✕); notes added with @ can be taken out, and the row goes with the last of them", async () => {
    resetAppState({ data: { ...noWorkspaceData, nodes: [note, { ...note, id: "p", title: "專案計畫" }], tags: [] as never, actor_is_owner: true }, online: true });
    toggleNoteAi(note.id);
    phone();
    await box();
    // This note alone: the box already says what is asked about, so there is no row.
    expect(screen.queryByRole("list", { name: "What the AI will read" })).toBeNull();
    await type("看看 @專案");
    fireEvent.click(within(await screen.findByRole("listbox")).getByRole("button", { name: /專案計畫/ }));
    const list = await screen.findByRole("list", { name: "What the AI will read" });
    expect(within(list).getByText("今天")).toBeInTheDocument();
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(within(list).getByRole("button", { name: "Remove 專案計畫 from the AI's reach" }));
    expect(screen.queryByRole("list", { name: "What the AI will read" })).toBeNull();
  });
});

describe("waiting for an AI that connects by itself", () => {
  const mcpTurn = (extra: Record<string, unknown> = {}) => turn({ status: "queued", reply: null, runtime: "mcp", created_at: new Date().toISOString(), ...extra });

  it("says what the session really reports: waiting for the computer, then received, then working", async () => {
    turns = [mcpTurn()];
    toggleNoteAi(note.id);
    const { unmount } = phone();
    expect(await screen.findByText("Waiting for your computer to pick this up…")).toBeInTheDocument();
    unmount(); cleanup();
    turns = [mcpTurn({ status: "delivered" })];
    phone();
    expect(await screen.findByText("Your AI has it and is getting started…")).toBeInTheDocument();
  });

  it("after a long time with no pick-up it says the computer that answers is probably not online", async () => {
    turns = [mcpTurn({ created_at: new Date(Date.now() - 10 * 60_000).toISOString() })];
    toggleNoteAi(note.id);
    phone();
    expect(await screen.findByText(/may not be on or online/)).toBeInTheDocument();
  });

  it("Cancel really cancels the session", async () => {
    turns = [mcpTurn()];
    toggleNoteAi(note.id);
    phone();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(apiMock.mock.calls.some(([p, init]) => p === "/api/agent-sessions/s1/cancel" && init?.method === "POST")).toBe(true));
    await waitFor(() => expect(screen.getByText("Stopped.")).toBeInTheDocument());
  });
});

describe("the panel's words", () => {
  it("never name the protocol (no MCP) and show only the AI's name when there is one AI and one way", async () => {
    toggleNoteAi(note.id);
    phone();
    expect(await screen.findByText("小助手")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/MCP/);
  });

  it("an AI simply called AI is not named a second time under the panel's own title", async () => {
    roles = { roles: [{ ...ROLES.roles[0]!, name: "AI" }] };
    toggleNoteAi(note.id);
    phone();
    await screen.findByRole("textbox", { name: "Ask the AI" });
    expect(document.querySelector(".note-ai-line")).toBeNull();
    expect(document.querySelector(".note-ai-head")).toBeNull();
  });
});
