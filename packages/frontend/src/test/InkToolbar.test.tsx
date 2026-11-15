// The shared ink toolbar: Hand is a tool in the same group as the drawing
// tools (one of four, aria-pressed); the old finger toggle is gone; the
// the device's finger switch is in the ⋯ menu, not here.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import InkToolbar from "../components/InkToolbar";
import type { InkActiveTool } from "../lib/ink/types";

function renderToolbar(props: Partial<React.ComponentProps<typeof InkToolbar>> = {}) {
  const onToolChange = vi.fn();
  const utils = render(
    <InkToolbar
      tool="pen" onToolChange={onToolChange}
      color="#15130d" onColorChange={() => {}} sizeId="medium" onSizeChange={() => {}}
      canUndo={false} canRedo={true} onUndo={() => {}} onRedo={() => {}}
      {...props}
    />,
  );
  return { ...utils, onToolChange };
}

describe("InkToolbar", () => {
  it("offers Pen, Highlighter, Eraser and Hand as ONE group of four toggle buttons", () => {
    renderToolbar();
    const group = screen.getByRole("group", { name: "Tool" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("data-ink-tool"))).toEqual(["pen", "highlighter", "eraser", "hand"]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Pen", "Highlighter", "Eraser", "Hand"]);
  });

  it("reflects the selected tool in aria-pressed, Hand included", () => {
    renderToolbar({ tool: "hand" });
    const group = screen.getByRole("group", { name: "Tool" });
    expect(within(group).getByRole("button", { name: "Hand" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(group).getByRole("button", { name: "Pen" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("picking a tool reports it", () => {
    const { onToolChange } = renderToolbar();
    const picked: InkActiveTool[] = [];
    onToolChange.mockImplementation((tool: InkActiveTool) => picked.push(tool));
    const group = screen.getByRole("group", { name: "Tool" });
    for (const name of ["Hand", "Eraser", "Highlighter", "Pen"]) fireEvent.click(within(group).getByRole("button", { name }));
    expect(picked).toEqual(["hand", "eraser", "highlighter", "pen"]);
  });

  it("has no finger toggle any more; undo / redo stay", () => {
    const { container } = renderToolbar();
    expect(container.querySelector("[data-ink-finger]")).toBeNull();
    expect(screen.queryByRole("button", { name: /finger/i })).toBeNull();
    const history = screen.getByRole("group", { name: "History" });
    const [undo, redo] = within(history).getAllByRole("button");
    expect((undo as HTMLButtonElement).disabled).toBe(true);
    expect((redo as HTMLButtonElement).disabled).toBe(false);
  });

  it("has no input switch: the finger switch lives in the ⋯ menu (PageMoreMenu), not on the toolbar", () => {
    renderToolbar();
    expect(screen.queryByRole("button", { name: /fingers only scroll|Finger draws/ })).toBeNull();
  });

  it("is a single non-wrapping row: tool group first, history group pinned last", () => {
    const { container } = renderToolbar();
    // The tools scroll inside their own box; undo / redo sit outside it, so
    // they stay in view however narrow the pane is.
    const scroll = container.querySelector(".ink-note-toolbar > .ink-toolbar-scroll")!;
    expect(scroll.querySelector(".ink-toolbar-group")!.getAttribute("aria-label")).toBe("Tool");
    expect(scroll.querySelector(".ink-toolbar-group--history")).toBeNull();
    expect(container.querySelector(".ink-note-toolbar > .ink-toolbar-group--history")).not.toBeNull();
  });

  it("without host tools the toolbar is exactly the notes' one: four tools, no extras, no trailing group", () => {
    const { container } = renderToolbar();
    expect(container.querySelectorAll(".ink-toolbar-group--trailing")).toHaveLength(0);
    expect(container.querySelectorAll("[data-pdf-tool]")).toHaveLength(0);
    expect(container.querySelectorAll('[role="group"][aria-label="Tool"] button')).toHaveLength(4);
  });

  it("host tools join the same group around the built-in ones, and `trailing` is pinned after history", () => {
    const onToolChange = vi.fn();
    const { container } = renderToolbar({
      tool: "box" as never,
      onToolChange,
      leadingTools: [{ id: "first", label: "Select", icon: <i />, dataAttr: "data-pdf-tool", hint: "A hint" }] as never,
      trailingTools: [{ id: "box", label: "Rectangle", icon: <i /> }] as never,
      trailing: <button type="button">more</button>,
    });
    const group = screen.getByRole("group", { name: "Tool" });
    const ids = within(group).getAllByRole("button").map((b) => b.getAttribute("data-pdf-tool") ?? b.getAttribute("data-ink-tool"));
    expect(ids).toEqual(["first", "pen", "highlighter", "eraser", "hand", "box"]);
    expect(within(group).getByRole("button", { name: "Select — A hint" }).getAttribute("data-pdf-tool")).toBe("first");
    expect(within(group).getByRole("button", { name: "Rectangle" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "Hand" }));
    expect(onToolChange).toHaveBeenCalledWith("hand");
    const last = container.querySelector(".ink-note-toolbar")!.lastElementChild!;
    expect(last.className).toContain("ink-toolbar-group--trailing");
    expect(last.previousElementSibling!.className).toContain("ink-toolbar-group--history");
  });

  it("readOnly keeps Hand and the host's tools only: no colour, size or history", () => {
    renderToolbar({
      readOnly: true,
      leadingTools: [{ id: "first", label: "Select", icon: <i /> }] as never,
      trailing: <button type="button">more</button>,
    });
    const group = screen.getByRole("group", { name: "Tool" });
    expect(within(group).getAllByRole("button").map((b) => b.getAttribute("data-ink-tool") ?? "first")).toEqual(["first", "hand"]);
    for (const name of ["Color", "Size", "History"]) expect(screen.queryByRole("group", { name })).toBeNull();
    expect(screen.getByRole("button", { name: "more" })).toBeTruthy();
  });
});
