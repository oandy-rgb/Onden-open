// 白板複製貼上：用真的 InkEngine 與 useBoardHistory，筆記寫入換成記錄用的替身。
// 契約：貼上＝新筆記、新連線、新筆畫；相對位置不變；一個 ⌘Z 全部復原、⌘⇧Z 全部回來；
// 文字輸入有焦點時不攔截；外部純文字貼上建一張卡片；只有一端被選的連線不複製。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { InkEngine } from "../lib/ink/engine";
import { registerInkEdit } from "../lib/ink/boardHistory";
import type { ICommittedRenderer } from "../lib/ink/committed";
import type { CanvasData, ContentNode, NodeEdge } from "../lib/api";
import { useBoardHistory } from "../hooks/useBoardHistory";
import { useBoardClipboard, type BoardClipboardOps } from "../hooks/useBoardClipboard";
import { buildBoardClip, cardFromText, heldBoardClip, holdBoardClip, shiftToAnchor } from "../lib/boardClipboard";
import type { CanvasInkHandle } from "../components/CanvasInkLayer";

const renderer = (): ICommittedRenderer => ({ kind: "canvas2d", commitStrokes() {}, setView() {}, resize() {}, destroy() {} });
const note = (id: string, title: string, markdown = ""): ContentNode => ({ id, title, markdown, slug: id, source_type: "manual", node_type: "content" });
const edge = (id: string, a: string, b: string, extra: Partial<NodeEdge> = {}): NodeEdge => ({ id, source_node_id: a, target_node_id: b, edge_type: "knowledge_link", status: "active", origin: "manual", ...extra });
const stroke = (id: string, x: number, y: number) => ({ id, points: [[x, y], [x + 5, y + 5]] as [number, number][], color: "#000", size: 4, toolId: "pen" as const });

const NOTES = [note("a", "Alpha", "alpha body"), note("b", "Beta", "beta body"), note("c", "Gamma")];
const LAYOUT: CanvasData = { nodes: [{ nodeId: "a", x: 100, y: 100 }, { nodeId: "b", x: 400, y: 160, width: 300 }, { nodeId: "c", x: 900, y: 900 }] };

function setup(selected: string[] = ["a", "b"]) {
  const created: string[] = [];
  const placed = new Map<string, { x: number; y: number; width?: number }>();
  const trashed: string[] = [];
  const connects: Array<[string, string]> = [];
  let seq = 0;
  const ops: BoardClipboardOps = {
    duplicateNote: vi.fn(async (id: string) => { const n = note(`copy-${id}-${++seq}`, `${id} (Copy)`); created.push(n.id); return n; }),
    createNote: vi.fn(async (title: string, markdown: string) => { const n = note(`text-${++seq}`, title, markdown); created.push(n.id); return n; }),
    placeCard: vi.fn(async (id, at) => { placed.set(id, at); }),
    connect: vi.fn(async (s, t) => { connects.push([s, t]); return edge(`e${connects.length}`, s, t); }),
    removeCards: vi.fn(async (ids: string[]) => { for (const id of ids) placed.delete(id); }),
    trashNote: vi.fn(async (id: string) => { trashed.push(id); return true; }),
    untrashNote: vi.fn(async (id: string) => { trashed.splice(trashed.indexOf(id), 1); return true; }),
    insertImages: vi.fn(async () => {}),
  };
  const panel = document.createElement("section");
  document.body.appendChild(panel);
  const wrap = document.createElement("div");
  wrap.className = "kw-canvas-wrap";
  wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400, x: 0, y: 0, toJSON() {} });
  panel.appendChild(wrap);
  const rfInstance = { screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }) } as never;

  let engine!: InkEngine;
  const history = renderHook(() => useBoardHistory({ canvasId: "c1" }));
  engine = new InkEngine({
    committedRenderer: renderer(), wetCanvas: document.createElement("canvas"), manageCanvasSize: false,
    gestures: { pan() {}, zoom() {} },
    onRecord: (op) => registerInkEdit(history.result.current, () => engine, op),
  });
  engine.load({ version: 1, strokes: [stroke("s1", 120, 120), stroke("s2", 140, 120), stroke("s3", 420, 180)], erased: {}, page: { width: 800 } });
  // The ink layer's selection, as the layer holds it.
  let inkSelection: { strokeIds: string[]; shapeIds: string[] } | null = { strokeIds: ["s1", "s2", "s3"], shapeIds: [] };
  const inkHandle: CanvasInkHandle = {
    selectIn: () => false, clearSelection: () => { inkSelection = null; }, moveSelection: () => {}, removeSelection: () => false,
    copySelection: () => (inkSelection ? engine.copyItems(inkSelection) : null),
    pasteClip: (clip, dx, dy) => { const added = engine.pasteClip(clip, dx, dy); if (added) inkSelection = added; return !!added; },
  };
  const onPasted = vi.fn();
  const view = renderHook((props: { enabled: boolean }) => useBoardClipboard({
    enabled: props.enabled, boardId: "c1", panelRef: { current: panel }, rfInstance, history: history.result.current,
    inkRef: { current: inkHandle }, ops, layout: () => LAYOUT, notes: () => NOTES,
    edges: () => [edge("e-ab", "a", "b"), edge("e-bc", "b", "c"), edge("e-wiki", "a", "b", { origin: "wikilink" })],
    selectedCardIds: () => selected, onPasted,
  }), { initialProps: { enabled: true } });
  return { ops, panel, engine, history, created, placed, trashed, connects, onPasted, view, setInk: (s: typeof inkSelection) => { inkSelection = s; } };
}

/** What a real page does on ⌘C / ⌘V: the copy event writes text, the paste event reads it back. */
function copyEvent(target: EventTarget, store: Record<string, string>) {
  const ev = new Event("copy", { bubbles: true, cancelable: true });
  Object.assign(ev, { clipboardData: { setData: (k: string, v: string) => { store[k] = v; } } });
  target.dispatchEvent(ev);
  return ev;
}
function pasteEvent(target: EventTarget, text: string, files: File[] = []) {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.assign(ev, { clipboardData: { getData: (k: string) => (k === "text/plain" ? text : ""), files } });
  target.dispatchEvent(ev);
  return ev;
}
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
const undoKey = (shiftKey = false) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey })); await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  window.getSelection()?.removeAllRanges();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("board copy and paste", () => {
  it("two linked cards and three strokes: paste makes 2 notes, 1 arrow, 3 strokes, same relative layout, one undo step", async () => {
    const t = setup();
    const store: Record<string, string> = {};
    copyEvent(document.body, store);
    expect(store["text/plain"]).toBe("# Alpha\n\nalpha body\n\n# Beta\n\nbeta body"); // the cards' words, as Markdown, for other apps
    // The pointer is over the board: paste lands there, top-left corner at the pointer.
    act(() => { t.panel.dispatchEvent(new MouseEvent("pointermove", { clientX: 600, clientY: 500 })); });
    const ev = pasteEvent(document.body, store["text/plain"]!);
    expect(ev.defaultPrevented).toBe(true);
    await flush();

    expect(t.created).toHaveLength(2);
    expect(t.connects).toEqual([[t.created[0], t.created[1]]]); // only a→b: b→c has one end outside, the [[link]] arrow is the text's
    expect(t.engine.serialize().strokes).toHaveLength(6);
    // Origin of the selection is (100,100) (card a; the strokes start at 120): shifted to (600,500).
    expect(t.placed.get(t.created[0]!)).toEqual({ x: 600, y: 500 });
    expect(t.placed.get(t.created[1]!)).toEqual({ x: 900, y: 560, width: 300 });
    const first = t.engine.serialize().strokes.filter((s) => !["s1", "s2", "s3"].includes(s.id));
    expect(first.map((s) => s.points[0])).toEqual([[620, 520], [640, 520], [920, 580]]);
    expect(new Set(t.engine.serialize().strokes.map((s) => s.id)).size).toBe(6);
    expect(t.onPasted).toHaveBeenCalledWith(t.created);

    // ONE undo takes everything back, ONE redo everything again.
    await undoKey();
    expect(t.engine.serialize().strokes).toHaveLength(3);
    expect(t.placed.size).toBe(0);
    expect(t.trashed.sort()).toEqual([...t.created].sort());
    await undoKey(true);
    expect(t.engine.serialize().strokes).toHaveLength(6);
    expect(t.trashed).toEqual([]);
    expect(t.placed.size).toBe(2);
    expect(t.connects).toHaveLength(2); // the arrow drawn again
    // Nothing left to undo beyond that single step.
    await undoKey();
    expect(t.history.result.current.canUndo).toBe(false);
  });

  it("without the pointer over the board, paste lands in the middle of what is on screen", async () => {
    const t = setup(["c"]);
    t.setInk(null);
    const store: Record<string, string> = {};
    copyEvent(document.body, store);
    pasteEvent(document.body, store["text/plain"]!);
    await flush();
    expect(t.placed.get(t.created[0]!)).toEqual({ x: 400, y: 200 });
  });

  it("⌘D duplicates in place, offset a little, and selects the copies", async () => {
    const t = setup(["a"]);
    t.setInk(null);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", metaKey: true, bubbles: true, cancelable: true })); });
    await flush();
    expect(t.placed.get(t.created[0]!)).toEqual({ x: 132, y: 132 });
    expect(t.onPasted).toHaveBeenCalledWith(t.created);
  });

  it("a field or the card editor with focus keeps ⌘C / ⌘V / ⌘D for its text", async () => {
    const t = setup();
    for (const tag of ["input", "textarea"]) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      const store: Record<string, string> = {};
      expect(copyEvent(el, store).defaultPrevented).toBe(false);
      expect(pasteEvent(el, "hello").defaultPrevented).toBe(false);
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true, cancelable: true }));
      expect(store["text/plain"]).toBeUndefined();
    }
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const line = document.createElement("div");
    editor.appendChild(line);
    t.panel.appendChild(editor);
    expect(pasteEvent(line, "hello").defaultPrevented).toBe(false);
    await flush();
    expect(t.ops.duplicateNote).not.toHaveBeenCalled();
    expect(t.ops.createNote).not.toHaveBeenCalled();
  });

  it("text the person selected on the page is theirs: the board does not copy over it", () => {
    const t = setup();
    const p = document.createElement("p");
    p.textContent = "some words";
    document.body.appendChild(p);
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()!.addRange(range);
    expect(copyEvent(document.body, {}).defaultPrevented).toBe(false);
    expect(t.ops.duplicateNote).not.toHaveBeenCalled();
  });

  it("text copied elsewhere pastes as a new card: first line the title, the rest the body", async () => {
    const t = setup();
    act(() => { t.panel.dispatchEvent(new MouseEvent("pointermove", { clientX: 50, clientY: 70 })); });
    const ev = pasteEvent(document.body, "Shopping list\n\n- milk\n- eggs\n");
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(t.ops.createNote).toHaveBeenCalledWith("Shopping list", "- milk\n- eggs");
    expect(t.placed.get(t.created[0]!)).toEqual({ x: 50, y: 70 });
    await undoKey();
    expect(t.placed.size).toBe(0);
    expect(t.trashed).toEqual(t.created);
  });

  it("pictures on the clipboard go to the board's own picture insert", async () => {
    const t = setup();
    const png = new File(["x"], "a.png", { type: "image/png" });
    act(() => { t.panel.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 20 })); });
    pasteEvent(document.body, "", [png]);
    await flush();
    expect(t.ops.insertImages).toHaveBeenCalledWith([png], { x: 10, y: 20 });
  });

  it("when the system clipboard was overwritten later, the held board copy is no longer used", async () => {
    const t = setup();
    const store: Record<string, string> = {};
    copyEvent(document.body, store);
    pasteEvent(document.body, "something else entirely");
    await flush();
    expect(t.ops.duplicateNote).not.toHaveBeenCalled();
    expect(t.ops.createNote).toHaveBeenCalledWith("something else entirely", "");
  });

  it("disabled (a tag's board, pen mode): nothing is intercepted", () => {
    const t = setup();
    t.view.rerender({ enabled: false });
    expect(copyEvent(document.body, {}).defaultPrevented).toBe(false);
    expect(pasteEvent(document.body, "text").defaultPrevented).toBe(false);
  });

  it("a note that cannot be copied is skipped; its neighbours still paste", async () => {
    const t = setup();
    (t.ops.duplicateNote as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => null);
    const store: Record<string, string> = {};
    copyEvent(document.body, store);
    pasteEvent(document.body, store["text/plain"]!);
    await flush();
    expect(t.created).toHaveLength(1);
    expect(t.connects).toEqual([]); // an arrow needs both new cards
  });
});

describe("the clip itself", () => {
  it("builds from the selection only: arrows need both ends, hand-drawn only", () => {
    const clip = buildBoardClip({
      cardIds: ["a", "b"], cards: LAYOUT.nodes, notes: NOTES,
      edges: [edge("1", "a", "b"), edge("2", "b", "a"), edge("3", "a", "c"), edge("4", "a", "b", { origin: "wikilink" }), edge("5", "a", "b", { edge_type: "supports" })],
      ink: null,
    });
    expect(clip.cards.map((c) => c.nodeId)).toEqual(["a", "b"]);
    expect(clip.links).toEqual([{ source: "a", target: "b" }, { source: "b", target: "a" }]);
    expect(shiftToAnchor(clip, { x: 0, y: 0 })).toEqual({ dx: -100, dy: -100 });
  });

  it("the held copy matches only while the system clipboard still has our text", () => {
    const clip = buildBoardClip({ cardIds: ["a"], cards: LAYOUT.nodes, notes: NOTES, edges: [], ink: null });
    const text = holdBoardClip(clip);
    expect(heldBoardClip(`${text}\r\n`)).toBe(clip);
    expect(heldBoardClip("not ours")).toBeNull();
  });

  it("text becomes a title and a body", () => {
    expect(cardFromText("\n  ## Title \nbody\nmore")).toEqual({ title: "Title", markdown: "body\nmore" });
    expect(cardFromText("   \n ")).toBeNull();
    // scan 08 #9: one long paragraph keeps every character, in the body.
    const paragraph = "長".repeat(600);
    expect(cardFromText(paragraph)).toEqual({ title: `${"長".repeat(79)}…`, markdown: paragraph });
    expect(cardFromText(`${paragraph}\nsecond`)?.markdown).toBe(`${paragraph}\nsecond`);
  });
});
