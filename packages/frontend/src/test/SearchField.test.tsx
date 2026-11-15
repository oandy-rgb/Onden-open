import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchField, type SearchNav } from "../components/ui";

function Harness({ nav, onEscape, onEnter, shortcut }: { nav?: Omit<SearchNav, "active" | "onActive">; onEscape?: () => void; onEnter?: () => void; shortcut?: string }) {
  const [value, setValue] = useState("");
  const [active, setActive] = useState(0);
  return <SearchField label="Search notes…" value={value} onValueChange={setValue} shortcut={shortcut}
    nav={nav ? { ...nav, active, onActive: setActive } : undefined} onEscape={onEscape} onEnter={onEnter} />;
}
const box = () => screen.getByRole("searchbox", { name: "Search notes…" });

afterEach(() => vi.unstubAllGlobals());

describe("SearchField", () => {
  it("is a search box with the search key and the label as placeholder", () => {
    render(<Harness />);
    expect(box()).toHaveAttribute("type", "search");
    expect(box()).toHaveAttribute("enterkeyhint", "search");
    expect(box()).toHaveAttribute("placeholder", "Search notes…");
  });

  it("shows a clear button only with text; clearing keeps focus in the box", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    await user.type(box(), "abc");
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(box()).toHaveValue("");
    expect(box()).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  it("Esc calls onEscape; Esc during IME composition does not", () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    fireEvent.keyDown(box(), { key: "Escape", isComposing: true });
    expect(onEscape).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("arrows move through the results and Enter picks the active one", () => {
    const onPick = vi.fn();
    render(<Harness nav={{ count: 3, onPick }} />);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(1);
  });

  it("arrows and Enter do nothing while an input method is composing, or with no results", () => {
    const onPick = vi.fn();
    const { rerender } = render(<Harness nav={{ count: 3, onPick }} />);
    fireEvent.keyDown(box(), { key: "ArrowDown", isComposing: true });
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(box(), { key: "Enter", keyCode: 229 });
    expect(onPick).not.toHaveBeenCalled();
    rerender(<Harness nav={{ count: 0, onPick }} />);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("skips disabled rows and does not pick one", () => {
    const onPick = vi.fn();
    render(<Harness nav={{ count: 3, onPick, isDisabled: (i) => i === 1 }} />);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(2);
  });

  it("Enter without a list calls onEnter, not during composition", () => {
    const onEnter = vi.fn();
    render(<Harness onEnter={onEnter} />);
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    expect(onEnter).not.toHaveBeenCalled();
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it("shows the shortcut only where a keyboard is likely, never on a phone", () => {
    const match = (coarse: boolean) => vi.fn((q: string) => ({ matches: coarse && q.includes("pointer: coarse"), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal("matchMedia", match(true));
    const phone = render(<Harness shortcut="focus-search" />);
    expect(box().getAttribute("placeholder")).toBe("Search notes…");
    phone.unmount();
    vi.stubGlobal("matchMedia", match(false));
    render(<Harness shortcut="focus-search" />);
    expect(box().getAttribute("placeholder")).toMatch(/^Search notes… \(.+\)$/);
  });
});
