import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { NodeProps } from "@xyflow/react";
const flow = vi.hoisted(() => ({ zoom: 1, resizeVisible: false }));
vi.mock("@xyflow/react", () => ({
  useUpdateNodeInternals: () => () => {},
  useStore: (select: (s: { transform: number[] }) => number) => select({ transform: [0, 0, flow.zoom] }),
  NodeResizer: ({ isVisible }: { isVisible: boolean }) => { flow.resizeVisible = isVisible; return null; },
  Handle: () => null,
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
}));
import { SectionNode } from "../components/SectionNode";
import { GraphCallbacksContext } from "../components/graphCallbacks";

afterEach(() => { cleanup(); flow.zoom = 1; });
it("keeps unfinished title input through the LOD boundary and commits only on Enter/blur", async () => {
  const save = vi.fn();
  const paneDoubleClick = vi.fn();
  const props = { id: "section-s", data: { sectionId: "s", title: "Before", cardCount: 2 }, selected: false } as unknown as NodeProps;
  const draw = () => <GraphCallbacksContext.Provider value={{ onNodeUpdate: vi.fn(), onNodeEditStart: vi.fn(),
    onNodeResized: vi.fn(), onSectionResized: vi.fn(), onSectionRemove: vi.fn(), onSectionTitleChange: save,
    onNodeTitleChange: vi.fn(), onClickWikilink: vi.fn(), onSetFolded: vi.fn(), onFocusCard: vi.fn(), onOpenCard: vi.fn(), onOpenSubCanvas: vi.fn(), onToggleBranch: vi.fn(), onShowMoreChildren: vi.fn() }}>
    <div onDoubleClick={paneDoubleClick}><SectionNode {...props} /></div>
  </GraphCallbacksContext.Provider>;
  const { rerender } = render(draw());
  const input = screen.getByRole("textbox");
  fireEvent.focus(input); fireEvent.change(input, { target: { value: "Unfinished title" } });
  expect(flow.resizeVisible).toBe(false);
  flow.zoom = 0.2; rerender(draw());
  expect(screen.getByRole("textbox")).toBe(input);
  expect(input).toHaveValue("Unfinished title");
  expect(save).not.toHaveBeenCalled();
  fireEvent.doubleClick(input);
  expect(paneDoubleClick).not.toHaveBeenCalled();
  input.focus();
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(save).not.toHaveBeenCalled();
  await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
  expect(save).toHaveBeenCalledExactlyOnceWith("s", "Unfinished title");
});


it("waits for acceptance, preserves a refused title and retries only by explicit action", async () => {
  let reject!: (error: Error) => void;
  let accept!: () => void;
  const save = vi.fn().mockImplementationOnce(() => new Promise<void>((_, no) => { reject = no; }))
    .mockImplementationOnce(() => new Promise<void>(yes => { accept = yes; }));
  const props = { id: "section-s", data: { sectionId: "s", title: "Before", cardCount: 2 }, selected: true } as unknown as NodeProps;
  const callbacks = { onNodeUpdate: vi.fn(), onNodeEditStart: vi.fn(), onNodeResized: vi.fn(), onSectionResized: vi.fn(), onSectionRemove: vi.fn(),
    onSectionTitleChange: save, onNodeTitleChange: vi.fn(), onClickWikilink: vi.fn(), onSetFolded: vi.fn(), onFocusCard: vi.fn(), onOpenCard: vi.fn(), onOpenSubCanvas: vi.fn(), onToggleBranch: vi.fn(), onShowMoreChildren: vi.fn() };
  const draw = () => <GraphCallbacksContext.Provider value={callbacks}><SectionNode {...props} /></GraphCallbacksContext.Provider>;
  const { rerender } = render(draw());
  const input = screen.getByRole("textbox");
  expect(flow.resizeVisible).toBe(true);
  fireEvent.focus(input); fireEvent.change(input, { target: { value: "Keep this draft" } }); fireEvent.blur(input);
  expect(screen.getByRole("status")).toHaveTextContent("Saving…");
  expect(input).toHaveAttribute("readonly");
  fireEvent.blur(input);
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("refused")));
  expect(input).toHaveValue("Keep this draft");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).not.toHaveAttribute("readonly");
  props.data = { ...props.data, title: "Another accepted title" }; rerender(draw());
  expect(input).toHaveValue("Keep this draft");
  fireEvent.focus(input); fireEvent.blur(input);
  expect(save).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry saving" }));
  expect(save).toHaveBeenLastCalledWith("s", "Keep this draft");
  expect(save).toHaveBeenCalledTimes(2);
  props.data = { ...props.data, title: "Keep this draft" }; rerender(draw());
  await act(async () => accept());
  expect(screen.queryByRole("button", { name: "Retry saving" })).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
  expect(input).toHaveValue("Keep this draft");
  props.data = { ...props.data, title: "Later accepted edit" }; rerender(draw());
  expect(input).toHaveValue("Later accepted edit");
});

it("scan 08 #3: a selected frame offers 「刪除群組框」, an unselected one does not; it asks for this frame only", () => {
  const remove = vi.fn();
  const callbacks = { onNodeUpdate: vi.fn(), onNodeEditStart: vi.fn(), onNodeResized: vi.fn(), onSectionResized: vi.fn(), onSectionRemove: remove,
    onSectionTitleChange: vi.fn(), onNodeTitleChange: vi.fn(), onClickWikilink: vi.fn(), onSetFolded: vi.fn(), onFocusCard: vi.fn(), onOpenCard: vi.fn(), onOpenSubCanvas: vi.fn(), onToggleBranch: vi.fn(), onShowMoreChildren: vi.fn() };
  const draw = (selected: boolean) => <GraphCallbacksContext.Provider value={callbacks}>
    <SectionNode {...({ id: "section-s", data: { sectionId: "s", title: "G", cardCount: 1 }, selected } as unknown as NodeProps)} />
  </GraphCallbacksContext.Provider>;
  const { rerender } = render(draw(false));
  expect(screen.queryByRole("button", { name: "Delete group frame" })).toBeNull();
  rerender(draw(true));
  fireEvent.click(screen.getByRole("button", { name: "Delete group frame" }));
  expect(remove).toHaveBeenCalledExactlyOnceWith("s");
});
