import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import SelectionToolbar from "../components/SelectionToolbar";
import { DEFAULT_TOOLBAR_LAYOUT, setToolShown } from "../lib/toolbarLayout";
import { toolbarLayoutStore } from "../lib/toolbarLayoutStore";

const props = () => ({
  at: { x: 10, y: 20 },
  onWrap: vi.fn(), onQuote: vi.fn(), onHeading: vi.fn(), onLink: vi.fn(),
});
const tool = (extra: { run?: () => void; disabled?: boolean | string; opensPanel?: boolean } = {}) => ({ run: extra.run ?? vi.fn(), disabled: extra.disabled, opensPanel: extra.opensPanel });

afterEach(() => toolbarLayoutStore.forget());

// The paragraph tools come from the editor (components/ParagraphMenu `tools`, tested with the editor);
// this bar only draws what it is handed, in the person's layout.
describe("SelectionToolbar: the paragraph tools it is handed", () => {
  it("draws only the tools handed to it", () => {
    render(<SelectionToolbar {...props()} />);
    expect(document.querySelector('[data-tool="ai"]')).toBeNull();
    expect(document.querySelector('[data-tool="tag"]')).toBeNull();
  });

  it("a panel button is pressed by a click and gets the button as its anchor", () => {
    const run = vi.fn();
    render(<SelectionToolbar {...props()} paragraphTools={{ ai: tool({ run, opensPanel: true }) }} />);
    const button = document.querySelector('[data-tool="ai"]') as HTMLElement;
    fireEvent.click(button);
    expect(run).toHaveBeenCalledWith(button);
  });
});

describe("SelectionToolbar", () => {
  it("formats on press", () => {
    const p = props();
    render(<SelectionToolbar {...p} />);
    fireEvent.mouseDown(screen.getByTitle("Bold"));
    fireEvent.mouseDown(screen.getByTitle("Heading 2"));
    fireEvent.mouseDown(screen.getByTitle("Quote"));
    expect(p.onWrap).toHaveBeenCalledWith("**", "**");
    expect(p.onHeading).toHaveBeenCalledWith(2);
    expect(p.onQuote).toHaveBeenCalledOnce();
  });

  it("collects a link URL and applies it on Enter; an IME Esc does not cancel", () => {
    const p = props();
    render(<SelectionToolbar {...p} />);
    fireEvent.mouseDown(screen.getByTitle("Link"));
    const input = screen.getByPlaceholderText("https://...");
    fireEvent.change(input, { target: { value: "https://x.dev" } });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(screen.getByPlaceholderText("https://...")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(p.onLink).toHaveBeenCalledWith("https://x.dev");
    expect(screen.queryByPlaceholderText("https://...")).toBeNull();
  });

  it("draws a general format as an icon only, and an Onden action as an icon with its words", () => {
    render(<SelectionToolbar {...props()} paragraphTools={{ toChild: tool(), tag: tool({ opensPanel: true }) }} />);
    expect(screen.getByTitle("Bold").textContent).toBe("");
    expect(screen.getByTitle("Turn into a child note").textContent).toBe("Turn into a child note");
    expect(screen.getByTitle("Add tag").textContent).toBe("Add tag");
  });

  it("turns the selection into a child note in one press", () => {
    const run = vi.fn();
    render(<SelectionToolbar {...props()} paragraphTools={{ toChild: tool({ run }) }} />);
    fireEvent.mouseDown(screen.getByTitle("Turn into a child note"));
    expect(run).toHaveBeenCalledOnce();
  });

  it("explains why 變成子筆記 can't run, and does not run it", () => {
    const run = vi.fn();
    render(<SelectionToolbar {...props()} paragraphTools={{ toChild: tool({ run, disabled: "Needs a connection: this creates a note." }) }} />);
    const button = screen.getByTitle("Needs a connection: this creates a note.");
    expect(button).toBeDisabled();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.mouseDown(button);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the less used actions in 更多 until they are brought out", () => {
    const onConvertTask = vi.fn(), onBlockHistory = vi.fn();
    render(<SelectionToolbar {...props()} paragraphTools={{ convertTask: tool({ run: onConvertTask }), history: tool({ run: onBlockHistory }) }} />);
    expect(screen.queryByTitle("Convert this checkbox into an agenda task")).toBeNull();
    fireEvent.click(screen.getByTitle("More"));
    const menu = screen.getByRole("menu", { name: "More" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Convert this checkbox/ }));
    expect(onConvertTask).toHaveBeenCalledOnce();
    expect(onBlockHistory).not.toHaveBeenCalled();
  });

  it("follows the person's layout: a button turned off moves to 更多, one turned on is drawn", () => {
    let layout = setToolShown(DEFAULT_TOOLBAR_LAYOUT, "selection", "bold", false);
    layout = setToolShown(layout, "selection", "convertTask", true);
    toolbarLayoutStore.stage(layout);
    const p = props();
    const onConvertTask = vi.fn();
    render(<SelectionToolbar {...p} paragraphTools={{ convertTask: tool({ run: onConvertTask }) }} />);
    expect(screen.queryByTitle("Bold")).toBeNull();
    fireEvent.mouseDown(screen.getByTitle("Convert this checkbox into an agenda task"));
    expect(onConvertTask).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByTitle("More"));
    fireEvent.click(within(screen.getByRole("menu", { name: "More" })).getByRole("menuitem", { name: "Bold" }));
    expect(p.onWrap).toHaveBeenCalledWith("**", "**");
  });

  it("on a touch bar only the first two Onden buttons carry words; the rest wait in 更多", () => {
    let layout = setToolShown(DEFAULT_TOOLBAR_LAYOUT, "selection", "copyLink", true);
    layout = setToolShown(layout, "selection", "history", true);
    toolbarLayoutStore.stage(layout);
    render(<SelectionToolbar {...props()} variant="bar"
      paragraphTools={{ toChild: tool(), tag: tool({ opensPanel: true }), copyLink: tool(), history: tool() }} />);
    expect(screen.getByRole("button", { name: "Turn into a child note" }).textContent).toBe("Turn into a child note");
    expect(screen.getByRole("button", { name: "Add tag" }).textContent).toBe("Add tag");
    expect(screen.queryByRole("button", { name: "Copy block link" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu", { name: "More" });
    expect(within(menu).getByRole("menuitem", { name: /Copy block link/ })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: /History of this part/ })).toBeTruthy();
  });

  it("shows the task button only when offered", () => {
    toolbarLayoutStore.stage(setToolShown(DEFAULT_TOOLBAR_LAYOUT, "selection", "convertTask", true));
    const { rerender } = render(<SelectionToolbar {...props()} />);
    expect(screen.queryByTitle("Convert this checkbox into an agenda task")).toBeNull();
    const onConvertTask = vi.fn();
    rerender(<SelectionToolbar {...props()} paragraphTools={{ convertTask: tool({ run: onConvertTask }) }} />);
    fireEvent.mouseDown(screen.getByTitle("Convert this checkbox into an agenda task"));
    expect(onConvertTask).toHaveBeenCalledOnce();
  });
});
