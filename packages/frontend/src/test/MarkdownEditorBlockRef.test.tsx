// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

// `((` in the editor: the popup lists 「最近存的段落」 first and searches the
// paragraphs of every note; choosing a row writes the part link `[[Note/words]]`
// (the same one `[[Note#` writes), `!((` the embed of it.

const h = vi.hoisted(() => ({ body: vi.fn(), search: vi.fn() }));
vi.mock("../lib/data/reads", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/data/reads")>();
  return { ...real, reads: { ...real.reads, notes: { ...real.reads.notes, body: h.body, search: h.search } } };
});

import MarkdownEditor from "../components/MarkdownEditor";
import { bindAccountStorage } from "../lib/accountStorage";
import { recentBlocksStore, rememberBlock } from "../lib/recentBlocksStore";
import { resetAppState, setAppState } from "../lib/appStore";
import { noWorkspaceData } from "../lib/api";
import { holdAnchored } from "./helpers/anchoredText";

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const NODES = [
  { id: "n1", title: "Current", node_type: "content", markdown: "" },
  { id: "n2", title: "Graph theory", node_type: "content", markdown: "" },
  { id: "n3", title: "Cooking", node_type: "content", markdown: "" },
];
// The paragraphs' ids are anchors the device holds (the text has none): n2's second paragraph is st1, n3's is salt.
const BODIES: Record<string, string> = {
  n2: holdAnchored("n2", "Intro\n\nA spanning tree touches every vertex once. ^st1\n\n# Shortest paths"),
  n3: holdAnchored("n3", "Salt the water before the pasta goes in. ^salt"),
};

beforeEach(async () => {
  bindAccountStorage("block-ref-test", "");
  recentBlocksStore.save(null);
  resetAppState();
  setAppState({ online: true, data: { ...noWorkspaceData, nodes: NODES as never } });
  h.body.mockReset(); h.search.mockReset();
  h.body.mockImplementation(async (n: { id: string }) => BODIES[n.id] ?? null);
  h.search.mockImplementation(async (q: string) => ({
    rows: NODES.filter((n) => (BODIES[n.id] ?? "").toLowerCase().includes(q.toLowerCase())).map((n) => ({ id: n.id })),
    offline: false, fieldFilterSkipped: false,
  }));
});

function setup(value: string) {
  const utils = render(<MarkdownEditor nodeKey="n1" noteTitle="Current" value={value} onChange={vi.fn()} nodes={NODES as never}
    workspaceTags={[]} onMediaInsert={vi.fn(async () => null)} />);
  const view = EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const type = (text: string) => act(() => {
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
  });
  const popup = () => document.querySelector<HTMLElement>(".slash-menu-popup");
  act(() => { view.contentDOM.focus(); view.dispatch({ selection: { anchor: view.state.doc.length } }); });
  return { ...utils, view, type, popup, text: () => view.state.doc.toString() };
}
/** The popup row whose words (the marked part included) read `text`. */
const row = (text: string) => waitFor(() => {
  const found = Array.from(document.querySelectorAll<HTMLElement>(".slash-menu-item")).find((b) => b.querySelector(".slash-menu-title")?.textContent?.includes(text));
  expect(found, text).toBeTruthy();
  return found!;
});
const pick = (el: HTMLElement) => act(() => { fireEvent.mouseDown(el); });

describe("the (( popup", { timeout: 30_000 }, () => {
  it("with nothing typed lists only the recently saved paragraphs, with their notes", async () => {
    rememberBlock("n2", "st1", 10);
    const s = setup("see ");
    s.type("((");
    const popup = await waitFor(() => { const p = s.popup(); expect(p).toBeTruthy(); expect(within(p!).getByText("Recently saved paragraphs")).toBeTruthy(); return p!; });
    expect(within(popup).getByText("A spanning tree touches every vertex once.")).toBeTruthy();
    expect(within(popup).getByText("Graph theory")).toBeTruthy();
    expect(h.search).not.toHaveBeenCalled();
  });

  it("searches other notes' paragraphs by their words and writes a link to the one chosen", async () => {
    const s = setup("see ");
    s.type("((pasta");
    const salt = await row("water before the pasta goes in.");
    expect(salt.querySelector(".search-hl")?.textContent).toBe("pasta");
    pick(salt);
    expect(s.text()).toBe("see [[Cooking/Salt the water before the pasta goes in.]]");
    expect(s.popup()).toBeNull();
  });

  it("!(( writes the embed", async () => {
    const s = setup("");
    s.type("!((pasta");
    pick(await row("water before the pasta"));
    expect(s.text()).toBe("![[Cooking/Salt the water before the pasta goes in.]]");
  });

  it("a paragraph without an id is linked by its words too: nothing is written into its note", async () => {
    const s = setup("");
    s.type("((Intro");
    pick(await row("Intro"));
    expect(s.text()).toBe("[[Graph theory/Intro]]");
  });

  it("opens nothing inside inline code or a fenced code block", async () => {
    const inline = setup("`code ");
    inline.type("((pasta");
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(inline.popup()).toBeNull();
    inline.unmount();
    const fenced = setup("```\nsome code\n");
    fenced.type("((pasta");
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(fenced.popup()).toBeNull();
    expect(h.search).not.toHaveBeenCalled();
  });

  it("Escape closes it and the words stay as text; a space keeps searching", async () => {
    const s = setup("");
    s.type("((salt the");
    await row("Salt the water");
    act(() => { fireEvent.keyDown(s.view.contentDOM, { key: "Escape" }); });
    expect(s.popup()).toBeNull();
    expect(s.text()).toBe("((salt the");
  });

  it("[[ lists the recent paragraphs above the notes", async () => {
    rememberBlock("n3", "salt", 10);
    const s = setup("");
    s.type("[[");
    const popup = await waitFor(() => { const p = s.popup(); expect(within(p!).getByText("Recently saved paragraphs")).toBeTruthy(); return p!; });
    const items = Array.from(popup.querySelectorAll(".slash-menu-item")).map((b) => b.textContent);
    expect(items[0]).toContain("Salt the water");
    expect(items.some((text) => text?.includes("Graph theory"))).toBe(true);
  });
});
