// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";

// @xyflow/react drags in a hoisted root copy of zustand →
// use-sync-external-store → React 18, which collides with the frontend's React
// 19 under vitest (the cjs shim require()s the wrong React, null dispatcher →
// "Cannot read properties of null (reading 'useRef')"). CardNode only uses
// xyflow for the zoom selector + a few presentational wrappers, so stub the
// module: useStore feeds a fixed transform (zoom = 1, full detail) and the
// wrappers render as plain elements. This keeps the test focused on the actual
// behaviour under test — lazy CodeMirror construction — without the real store.
const viewport = vi.hoisted(() => ({ zoom: 1 }));
beforeEach(() => { viewport.zoom = 1; });
vi.mock("@xyflow/react", () => ({
  useUpdateNodeInternals: () => () => {},
  useStore: (sel: (s: { transform: [number, number, number] }) => unknown) =>
    sel({ transform: [0, 0, viewport.zoom] }),
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { ReactFlowProvider } from "@xyflow/react";
import { CardNode } from "../components/CardNode";
import { GraphCallbacksContext } from "../components/graphCallbacks";
import { EditorView } from "@codemirror/view";
import { act } from "@testing-library/react";
import { matchShortcut, resetShortcuts, setShortcutChord } from "../lib/shortcuts";

// Regression guard for the canvas-scale cliff (e2e fullstack/canvasScale.spec.ts):
// each CardNode used to build a full CodeMirror EditorView on mount, so a board
// of hundreds of cards spun up hundreds of editors synchronously and never
// finished its first paint. The editor must be LAZY — no `.cm-editor` exists
// until the card is actually being edited.

function cardProps(props: Partial<Parameters<typeof CardNode>[0]> = {}) {
  const base = {
    id: "n1",
    type: "card",
    dragging: false,
    zIndex: 0,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    width: 260,
    height: 200,
    selected: false,
    data: { label: "Card", content: "hello **world**" },
  } as unknown as Parameters<typeof CardNode>[0];
  return { ...base, ...props };
}
function renderCard(props: Partial<Parameters<typeof CardNode>[0]> = {}) {
  return render(
    <ReactFlowProvider>
      <CardNode {...cardProps(props)} />
    </ReactFlowProvider>,
  );
}

/** A card whose workspace callbacks are the given ones (the rest do nothing). */
function renderCardWith(props: Partial<Parameters<typeof CardNode>[0]>, callbacks: Partial<React.ContextType<typeof GraphCallbacksContext>>) {
  return render(
    <GraphCallbacksContext.Provider value={{ onNodeUpdate: vi.fn(), onNodeEditStart: vi.fn(), onNodeResized: vi.fn(), onSectionResized: vi.fn(), onSectionRemove: vi.fn(),
      onSectionTitleChange: vi.fn(), onNodeTitleChange: vi.fn(), onClickWikilink: vi.fn(), onSetFolded: vi.fn(), onFocusCard: vi.fn(),
      onOpenCard: vi.fn(), onOpenSubCanvas: vi.fn(), onToggleBranch: vi.fn(), onShowMoreChildren: vi.fn(), ...callbacks }}>
      <ReactFlowProvider><CardNode {...cardProps(props)} /></ReactFlowProvider>
    </GraphCallbacksContext.Provider>,
  );
}

describe("CardNode lazy CodeMirror", () => {
  it("hands the latest input to the writer before blur removes the editor", async () => {
    const onNodeUpdate = vi.fn(() => new Promise<void>(() => {}));
    const releaseEditorCamera = vi.fn();
    const onNodeEditStart = vi.fn(() => releaseEditorCamera);
    const { container, unmount } = render(
      <GraphCallbacksContext.Provider value={{ onNodeUpdate, onNodeEditStart, onNodeResized: vi.fn(), onSectionResized: vi.fn(), onSectionRemove: vi.fn(),
        onSectionTitleChange: vi.fn(), onNodeTitleChange: vi.fn(), onClickWikilink: vi.fn(),
        onSetFolded: vi.fn(), onFocusCard: vi.fn(), onOpenCard: vi.fn(), onOpenSubCanvas: vi.fn(), onToggleBranch: vi.fn(), onShowMoreChildren: vi.fn() }}>
        <CardNode {...cardProps({ selected: true })} />
      </GraphCallbacksContext.Provider>,
    );
    fireEvent.doubleClick(container.querySelector(".card-node")!);
    expect(onNodeEditStart).toHaveBeenCalledExactlyOnceWith("n1");
    // A word-selection double click inside the editor must not move the camera.
    fireEvent.doubleClick(container.querySelector(".cm-content")!);
    expect(onNodeEditStart).toHaveBeenCalledTimes(1);
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "Newest input" } }));
    fireEvent.blur(container.querySelector(".cm-content")!, { relatedTarget: document.body });
    expect(releaseEditorCamera).toHaveBeenCalledOnce();
    expect(onNodeUpdate).toHaveBeenCalledExactlyOnceWith("n1", "Newest input", { keepalive: false, base: expect.any(String) });
    expect(container.textContent).toContain("Newest input");
    fireEvent.doubleClick(container.querySelector(".card-node")!);
    expect(container.querySelector(".cm-content")?.textContent).toBe("Newest input");
    unmount();
    expect(releaseEditorCamera).toHaveBeenCalledTimes(2);
  });
  // D85: the card saves on "Save draft" as this device has it, through
  // matchShortcut — not on a Mod-s of its own.
  it("saves on the save-draft chord in effect, not on a hard-coded ⌘S", () => {
    try {
      setShortcutChord("save-draft", "$mod+j");
      const onNodeUpdate = vi.fn(() => new Promise<void>(() => {}));
      const { container } = render(
        <GraphCallbacksContext.Provider value={{ onNodeUpdate, onNodeEditStart: vi.fn(), onNodeResized: vi.fn(), onSectionResized: vi.fn(), onSectionRemove: vi.fn(),
          onSectionTitleChange: vi.fn(), onNodeTitleChange: vi.fn(), onClickWikilink: vi.fn(),
          onSetFolded: vi.fn(), onFocusCard: vi.fn(), onOpenCard: vi.fn(), onOpenSubCanvas: vi.fn(), onToggleBranch: vi.fn(), onShowMoreChildren: vi.fn() }}>
          <CardNode {...cardProps({ selected: true })} />
        </GraphCallbacksContext.Provider>,
      );
      fireEvent.doubleClick(container.querySelector(".card-node")!);
      const content = container.querySelector<HTMLElement>(".cm-content")!;
      const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
      act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "Saved by chord" } }));
      fireEvent.keyDown(content, { key: "s", code: "KeyS", ctrlKey: true });
      expect(onNodeUpdate).not.toHaveBeenCalled();
      const press = new KeyboardEvent("keydown", { key: "j", code: "KeyJ", ctrlKey: true, bubbles: true, cancelable: true });
      content.dispatchEvent(press);
      expect(onNodeUpdate).toHaveBeenCalledExactlyOnceWith("n1", "Saved by chord", expect.anything());
      // CodeMirror marks the press handled, so the app's dispatcher leaves it.
      expect(press.defaultPrevented).toBe(true);
      expect(matchShortcut(press)).toBeUndefined();
    } finally {
      resetShortcuts();
      cleanup();
    }
  });

  // D103: the card's ⌘B / ⌘I are the main editor's (lib/editorFormat
  // FORMAT_KEYS → toggleWrap): a second press unwraps instead of nesting.
  it("toggles bold and italic like the main editor, unwrapping on a second press", () => {
    try {
      const { container } = render(
        <GraphCallbacksContext.Provider value={{ onNodeUpdate: vi.fn(() => new Promise<void>(() => {})), onNodeEditStart: vi.fn(),
          onNodeResized: vi.fn(), onSectionResized: vi.fn(), onSectionRemove: vi.fn(), onSectionTitleChange: vi.fn(), onNodeTitleChange: vi.fn(),
          onClickWikilink: vi.fn(), onSetFolded: vi.fn(), onFocusCard: vi.fn(), onOpenCard: vi.fn(), onOpenSubCanvas: vi.fn(), onToggleBranch: vi.fn(), onShowMoreChildren: vi.fn() }}>
          <CardNode {...cardProps({ selected: true })} />
        </GraphCallbacksContext.Provider>,
      );
      fireEvent.doubleClick(container.querySelector(".card-node")!);
      const content = container.querySelector<HTMLElement>(".cm-content")!;
      const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
      const press = (key: string) => fireEvent.keyDown(content, { key, code: `Key${key.toUpperCase()}`, ctrlKey: true });
      act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "**x**" }, selection: { anchor: 2, head: 3 } }));
      press("b");
      expect(view.state.doc.toString()).toBe("x");
      press("b");
      expect(view.state.doc.toString()).toBe("**x**");
      act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "y" }, selection: { anchor: 0, head: 1 } }));
      press("i");
      expect(view.state.doc.toString()).toBe("*y*");
      press("i");
      expect(view.state.doc.toString()).toBe("y");
    } finally {
      cleanup();
    }
  });

  it("builds NO CodeMirror editor while at rest (not editing)", () => {
    const { container } = renderCard();
    // The preview renders, but the heavy editor must not be instantiated.
    expect(container.querySelector(".cm-editor")).toBeNull();
  });

  it("builds the editor only after entering edit mode (double-click)", async () => {
    const { container } = renderCard({ selected: true } as never);
    expect(container.querySelector(".cm-editor")).toBeNull();
    const card = container.querySelector(".card-node") as HTMLElement;
    fireEvent.doubleClick(card);
    // The lazy effect builds the EditorView once isEditing flips true.
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
    cleanup();
  });
  it("a folded card is its title bar: no body, no editor, a button that expands it, and the paragraph count", () => {
    const onSetFolded = vi.fn();
    const { container } = renderCardWith({ data: { label: "Folded note", content: "One\n\nTwo\n\nThree", folded: true } }, { onSetFolded });
    expect((container.querySelector(".card-node-title-input") as HTMLInputElement).value).toBe("Folded note");
    expect(container.querySelector(".card-node-body")).toBeNull();
    expect(container.querySelector(".cm-editor")).toBeNull();
    expect(container.querySelector(".card-node-fold-count")?.textContent).toBe("3 paragraphs");
    const button = container.querySelector(".card-node-fold-btn")!;
    expect(button.getAttribute("aria-label")).toBe("Expand card");
    fireEvent.click(button);
    expect(onSetFolded).toHaveBeenCalledWith("n1", false);
    cleanup();
  });

  it("an expanded card's arrow folds only that card", () => {
    const onSetFolded = vi.fn();
    const { container } = renderCardWith({ data: { label: "Note", content: "Body" } }, { onSetFolded });
    expect(container.querySelector(".card-node-body")).not.toBeNull();
    fireEvent.click(container.querySelector(".card-node-fold-btn")!);
    expect(onSetFolded).toHaveBeenCalledWith("n1", true);
    cleanup();
  });

  it("below 30% zoom a card keeps only its title, in a screen-sized font, and mounts no body or editor", () => {
    viewport.zoom = 0.2;
    const onFocusCard = vi.fn();
    const { container } = renderCardWith({ data: { label: "Far note", content: "Long body", maxTitleWidth: 400 } }, { onFocusCard });
    const title = container.querySelector(".card-node-title-only") as HTMLElement;
    expect(title.textContent).toBe("Far note");
    expect(container.querySelector(".card-node-body")).toBeNull();
    expect(container.querySelector(".cm-editor")).toBeNull();
    // 16px on screen at 20% is 80px in the canvas.
    expect((container.querySelector(".card-node") as HTMLElement).style.getPropertyValue("--title-only-size")).toBe("80px");
    fireEvent.click(title);
    expect(onFocusCard).toHaveBeenCalledWith("n1");
    viewport.zoom = 1;
    cleanup();
  });

  it("with the switch off, far zoom still draws the card as folded or expanded", () => {
    viewport.zoom = 0.2;
    const { container } = renderCard({ data: { label: "Note", content: "Body", titleOnlyFar: false } });
    expect(container.querySelector(".card-node-title-only")).toBeNull();
    expect(container.querySelector(".card-node-body")).not.toBeNull();
    viewport.zoom = 1;
    cleanup();
  });

  it("zooming out while editing never removes the active editor", async () => {
    const { container, rerender } = renderCard({ selected: true } as never);
    fireEvent.doubleClick(container.querySelector(".card-node")!);
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
    const editor = container.querySelector(".cm-editor");
    viewport.zoom = 0.2;
    rerender(<ReactFlowProvider><CardNode {...cardProps({ id: "n1", selected: true,
      data: { label: "Card", content: "hello **world**", containedSectionId: "section" },
    })} /></ReactFlowProvider>);
    expect(container.querySelector(".cm-editor")).toBe(editor);
    cleanup();
  });

});
