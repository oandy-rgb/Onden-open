// @vitest-environment jsdom
// 「變成子筆記」 / 「展開回內文」 in the editor: what the 「這段」 menu and the selection
// bar offer where,
// what is sent, and how the answers read — including the choice when links sit
// in notes the person can't edit, and no menu action offline.
// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import MarkdownEditor from "../components/MarkdownEditor";
import { getAppState, resetAppState, setAppState, setData, setOnline } from "../lib/appStore";
import { ApiError } from "../lib/api";
import { holdAnchored } from "./helpers/anchoredText";
import { replaceAllAnchors } from "../lib/blockAnchorStore";

const calls: Array<{ path: string; method?: string; body?: Record<string, unknown> }> = [];
let answers: Array<unknown | Error> = [];
vi.mock("../lib/api", async (original) => ({
  ...await original<typeof import("../lib/api")>(),
  api: vi.fn(async (path: string, init: RequestInit = {}) => {
    // The editor asks, once a note opens, how many links point at its paragraphs (hooks/useLinkedParagraphs): not part of what is tested here.
    if (path.endsWith("/block-link-counts")) return { counts: [] };
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next ?? {};
  }),
}));
vi.mock("../lib/localDb", () => ({ getPendingWrites: vi.fn(async () => []) }));
const confirm = vi.fn(async () => true);
vi.mock("../components/ConfirmDialog", () => ({ confirmDialog: (...args: unknown[]) => confirm(...(args as [])) }));

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;
const original = window.matchMedia;

const NODES = [
  { id: "n1", title: "Host", slug: "host", markdown: "", parent_id: null, space_id: "s1" },
  { id: "kid", title: "Kid", slug: "kid", markdown: "kid text", parent_id: "n1", space_id: "s1" },
];

function setup(doc: string) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query === "(pointer: coarse)" || query === "(max-width: 900px)",
    media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  // What the server holds is what the editor shows: the move reads the note as saved.
  setData((d) => ({ ...d, nodes: NODES.map((n) => (n.id === "n1" ? { ...n, markdown: doc } : n)) as never }));
  const utils = render(<MarkdownEditor nodeKey="n1" noteTitle="Host" value={doc} onChange={vi.fn()} nodes={NODES as never} workspaceTags={[]} onMediaInsert={vi.fn(async () => null)} />);
  const view = EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  act(() => { view.contentDOM.focus(); });
  const caretAt = (needle: string) => act(() => { view.dispatch({ selection: { anchor: doc.indexOf(needle) + 1 } }); });
  // On a touch bar only two Onden buttons carry words: 「變成子筆記」 and 「展開回內文」 wait in 更多.
  const openMenu = () => {
    const button = within(utils.container.querySelector<HTMLElement>(".md-mobile-toolbar")!).getByLabelText("More");
    act(() => { fireEvent.pointerDown(button); fireEvent.click(button); });
    return () => within(document.body);
  };
  const select = (from: string, to = from) => act(() => {
    view.dispatch({ selection: { anchor: doc.indexOf(from), head: doc.indexOf(to) + to.length } });
  });
  const bar = () => within(utils.container.querySelector<HTMLElement>(".md-mobile-toolbar")!);
  const tap = (el: HTMLElement) => act(() => { fireEvent.pointerDown(el); fireEvent.click(el); });
  return { ...utils, view, caretAt, openMenu, select, bar, tap };
}

beforeEach(() => {
  calls.length = 0; answers = []; confirm.mockClear();
  resetAppState(); setOnline(true);
  setData((d) => ({ ...d, nodes: NODES as never }));
});
afterEach(() => { window.matchMedia = original; setAppState({ toasts: [] }); replaceAllAnchors([]); });

const done = (extra: Record<string, unknown> = {}) => ({
  note: { id: "n1", markdown: "Before\n\n![[Kid]]\n" }, child_id: "kid", event_id: "42", rewritten: [], left: [], ...extra,
});

describe("the paragraph tools (更多 on the phone bar)", { timeout: 30_000 }, () => {
  it("offers 「變成子筆記」 on a paragraph, and 「展開回內文」 only on a child's embed line", () => {
    const s = setup("A paragraph\n\n![[Kid]]\n\n> a quote\n");
    s.caretAt("A paragraph");
    let menu = s.openMenu()();
    expect(menu.getByText("Turn into a child note")).toBeTruthy();
    expect(menu.queryByText("Expand back into the text")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  });

  it("shows the expand entry on the embed line", () => {
    const s = setup("A paragraph\n\n![[Kid]]\n");
    s.caretAt("![[Kid]]");
    const menu = s.openMenu()();
    expect(menu.getByText("Expand back into the text")).toBeTruthy();
    expect(menu.queryByText("Turn into a child note")).toBeNull();
  });

  it("can't make a quote a child note: the button says so, and nothing expands", () => {
    const s = setup("> a quote\n");
    s.caretAt("a quote");
    const menu = s.openMenu()();
    const item = menu.getByText("Turn into a child note").closest("[role=menuitem]") as HTMLButtonElement;
    expect(item.hasAttribute("disabled") || item.getAttribute("aria-disabled") === "true").toBe(true);
    expect(menu.getByText("This part can't be moved into a child note.")).toBeTruthy();
    expect(menu.queryByText("Expand back into the text")).toBeNull();
  });

  it("is disabled offline, with the reason", () => {
    setOnline(false);
    const s = setup("A paragraph\n");
    s.caretAt("A paragraph");
    const menu = s.openMenu()();
    const item = menu.getByText("Turn into a child note").closest("[role=menuitem]") as HTMLButtonElement;
    expect(item.hasAttribute("disabled") || item.getAttribute("aria-disabled") === "true").toBe(true);
    expect(menu.getByText("Needs a connection: this creates a note.")).toBeTruthy();
  });

  it("moves a paragraph with no anchor by its text and place: nothing is written into the note first", async () => {
    const doc = "Before\n\nA paragraph\n";
    const s = setup(doc);
    s.caretAt("A paragraph");
    answers = [done()];
    const menu = s.openMenu()();
    act(() => { fireEvent.click(menu.getByText("Turn into a child note")); });
    // The paragraph flashes where it was, so it is clear which one moved.
    expect(s.view.dom.querySelectorAll(".cm-paragraph-frame--flash").length).toBeGreaterThan(0);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/nodes/n1/block-to-child")).toBe(true));
    const sent = calls.find((c) => c.path === "/api/nodes/n1/block-to-child")!;
    expect(sent.method).toBe("POST");
    expect(sent.body).toMatchObject({ selection: { from: doc.indexOf("A paragraph"), to: doc.indexOf("A paragraph") + "A paragraph".length, text: "A paragraph" } });
    expect(sent.body).not.toHaveProperty("block_ref");
    expect(s.view.state.doc.toString()).toBe(doc);
    await waitFor(() => expect(getAppState().toasts.some((t) => t.message.includes("Moved into the child note"))).toBe(true));
    expect(getAppState().data.nodes.find((n) => n.id === "n1")?.markdown).toBe("Before\n\n![[Kid]]\n");
    expect(getAppState().toasts.find((t) => t.message.includes("Moved into"))?.action?.label).toBe("Undo");
  });

  it("moves a paragraph that has an anchor by that anchor, keeping its identity", async () => {
    const doc = holdAnchored("n1", "Before\n\nA paragraph ^k7\n");
    const s = setup(doc);
    s.caretAt("A paragraph");
    answers = [done()];
    const menu = s.openMenu()();
    act(() => { fireEvent.click(menu.getByText("Turn into a child note")); });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/nodes/n1/block-to-child")).toBe(true));
    expect(calls.find((c) => c.path === "/api/nodes/n1/block-to-child")!.body).toMatchObject({ block_ref: "k7" });
    expect(s.view.state.doc.toString()).toBe(doc);
  });

  it("asks before leaving links in notes the person can't edit, then goes on", async () => {
    const s = setup("A paragraph\n");
    s.caretAt("A paragraph");
    answers = [
      new ApiError(409, JSON.stringify({ error: "references_unwritable", notes: [{ id: "x", title: "Locked" }], hidden_count: 2 })),
      done({ left: [{ id: "x", title: "Locked" }] }),
    ];
    const menu = s.openMenu()();
    act(() => { fireEvent.click(menu.getByText("Turn into a child note")); });
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(String((confirm.mock.calls[0] as unknown[])[0])).toContain("“Locked”");
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith("/block-to-child"))).toHaveLength(2));
    expect(calls.filter((c) => c.path.endsWith("/block-to-child")).map((c) => c.body?.unwritable)).toEqual([undefined, "leave"]);
    // The refusal was a question, not a failure notice.
    expect(getAppState().toasts.some((t) => t.kind === "error")).toBe(false);
  });

  it("does nothing more when the person declines", async () => {
    confirm.mockResolvedValueOnce(false);
    const s = setup("A paragraph\n");
    s.caretAt("A paragraph");
    answers = [new ApiError(409, JSON.stringify({ error: "references_unwritable", notes: [{ id: "x", title: "Locked" }], hidden_count: 0 }))];
    const menu = s.openMenu()();
    act(() => { fireEvent.click(menu.getByText("Turn into a child note")); });
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(calls.filter((c) => c.path.endsWith("/block-to-child"))).toHaveLength(1);
  });

  it("expands by the child's id and a refusal is worded without codes", async () => {
    const s = setup("A paragraph\n\n![[Kid]]\n");
    s.caretAt("![[Kid]]");
    answers = [new ApiError(422, JSON.stringify({ error: "child_not_one_block" }))];
    const menu = s.openMenu()();
    act(() => { fireEvent.click(menu.getByText("Expand back into the text")); });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/nodes/n1/expand-child")).toBe(true));
    expect(calls.find((c) => c.path === "/api/nodes/n1/expand-child")?.body).toEqual({ child_id: "kid" });
    await waitFor(() => expect(getAppState().toasts.some((t) => t.kind === "error")).toBe(true));
    const error = getAppState().toasts.find((t) => t.kind === "error")!;
    expect(error.message).toContain("more than one paragraph");
    expect(error.message).not.toContain("child_not_one_block");
  });
});

describe("the selection bar: 變成子筆記", { timeout: 30_000 }, () => {
  const DOC = "Intro\n\nFirst idea here.\n\nSecond idea.\n\nOutro\n";

  it("sends the selected text across paragraphs as one request, with no ^id written first", async () => {
    const s = setup(DOC);
    s.select("idea here", "Second idea");
    answers = [done()];
    s.tap(s.bar().getByRole("button", { name: "Turn into a child note" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/nodes/n1/block-to-child")).toBe(true));
    const sent = calls.find((c) => c.path === "/api/nodes/n1/block-to-child")!;
    const from = DOC.indexOf("idea here"), to = DOC.indexOf("Second idea") + "Second idea".length;
    expect(sent.body).toMatchObject({ selection: { from, to, text: DOC.slice(from, to) } });
    expect(sent.body).not.toHaveProperty("block_ref");
    expect(calls.filter((c) => c.path.endsWith("/block-to-child"))).toHaveLength(1);
    // The editor wrote nothing of its own: the paragraphs are as they were typed.
    expect(s.view.state.doc.toString()).not.toContain("^");
    await waitFor(() => expect(getAppState().toasts.some((t) => t.message.includes("Moved into the child note"))).toBe(true));
  });

  it("works on half a paragraph, just the same", async () => {
    const s = setup(DOC);
    s.select("here");
    answers = [done()];
    s.tap(s.bar().getByRole("button", { name: "Turn into a child note" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/api/nodes/n1/block-to-child")).toBe(true));
    expect(calls.find((c) => c.path.endsWith("/block-to-child"))!.body).toMatchObject({ selection: { text: "here" } });
  });

  it("one undo takes the whole move back: a single restore of the one event", async () => {
    const s = setup(DOC);
    s.select("First idea here.");
    answers = [done({ event_id: "77" })];
    s.tap(s.bar().getByRole("button", { name: "Turn into a child note" }));
    await waitFor(() => expect(getAppState().toasts.some((t) => t.message.includes("Moved into"))).toBe(true));
    answers = [{}, { id: "n1", markdown: DOC }];
    const undo = getAppState().toasts.find((t) => t.message.includes("Moved into"))!.action!;
    act(() => { undo.onClick(); });
    await waitFor(() => expect(getAppState().toasts.some((t) => t.message === "Undone")).toBe(true));
    const restores = calls.filter((c) => c.path.includes("/restore"));
    expect(restores).toHaveLength(1);
    expect(restores[0]).toMatchObject({ path: "/api/events/77/restore", body: { cascade: true } });
    expect(getAppState().data.nodes.find((n) => n.id === "n1")?.markdown).toBe(DOC);
  });

  it("asks before leaving links in notes the person can't edit, as a paragraph does", async () => {
    const s = setup(DOC);
    s.select("Second idea.");
    answers = [
      new ApiError(409, JSON.stringify({ error: "references_unwritable", notes: [{ id: "x", title: "Locked" }], hidden_count: 0 })),
      done({ left: [{ id: "x", title: "Locked" }] }),
    ];
    s.tap(s.bar().getByRole("button", { name: "Turn into a child note" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith("/block-to-child"))).toHaveLength(2));
    expect(calls.filter((c) => c.path.endsWith("/block-to-child")).map((c) => c.body?.unwritable)).toEqual([undefined, "leave"]);
  });

  it("says so, and sends nothing, when the note changed under the selection", async () => {
    const s = setup(DOC);
    s.select("Second idea.");
    // The saved copy no longer matches what the editor shows (a sync moved the text).
    setData((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === "n1" ? { ...n, markdown: `More words.\n\n${DOC}` } : n)) }));
    s.tap(s.bar().getByRole("button", { name: "Turn into a child note" }));
    await waitFor(() => expect(getAppState().toasts.some((t) => t.kind === "error")).toBe(true));
    expect(getAppState().toasts.find((t) => t.kind === "error")!.message).toBe("The text changed. Select it again.");
    expect(calls.filter((c) => c.path.endsWith("/block-to-child"))).toHaveLength(0);
  });

  it("is disabled offline, with the reason", () => {
    setOnline(false);
    const s = setup(DOC);
    s.select("Second idea.");
    const button = s.bar().getByRole("button", { name: "Turn into a child note" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Needs a connection: this creates a note.");
  });
});
