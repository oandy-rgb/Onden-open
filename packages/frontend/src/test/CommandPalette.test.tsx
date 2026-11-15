// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CommandPalette from "../components/CommandPalette";
import type { PaletteItem } from "../lib/paletteItem";
import { createRef } from "react";
import { formatChord, resetShortcuts, setShortcutChord } from "../lib/shortcuts";

const makeItems = (): PaletteItem[] => [
  { kind: "node",   id: "n1", title: "Alpha Note",   hint: "draft",  group: "Recent Notes" },
  { kind: "node",   id: "n2", title: "Beta Note",    hint: "published", group: "Recent Notes" },
  { kind: "action", id: "a1", label: "Go to Overview", hint: "mode", group: "Navigate", run: vi.fn() },
];

function renderPalette(overrides: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  const onSelect = vi.fn();
  const onClose  = vi.fn();
  const onQueryChange = vi.fn();
  const onIndexChange = vi.fn();
  const ref = createRef<HTMLInputElement>();

  const props = {
    open: true,
    onClose,
    query: "",
    onQueryChange,
    index: 0,
    onIndexChange,
    items: makeItems(),
    inputRef: ref,
    searching: false,
    onSelect,
    ...overrides,
  };

  const { rerender } = render(<CommandPalette {...props} />);
  return { onSelect, onClose, onQueryChange, onIndexChange, rerender, props };
}

describe("CommandPalette", () => {
  it("renders nothing when closed", () => {
    renderPalette({ open: false });
    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
  });

  it("renders all items when open", () => {
    renderPalette();
    expect(screen.getByText("Alpha Note")).toBeInTheDocument();
    expect(screen.getByText("Beta Note")).toBeInTheDocument();
    expect(screen.getByText("Go to Overview")).toBeInTheDocument();
  });

  it("shows group headers", () => {
    renderPalette();
    expect(screen.getByText("Recent Notes")).toBeInTheDocument();
    expect(screen.getByText("Navigate")).toBeInTheDocument();
  });

  it("highlights the active item", () => {
    renderPalette({ index: 1 });
    const buttons = screen.getAllByRole("button").filter(
      (b) => b.classList.contains("palette-item"),
    );
    expect(buttons[1]).toHaveClass("active");
  });

  it("calls onClose on Escape", async () => {
    const { onClose } = renderPalette();
    const input = screen.getByRole("searchbox");
    await userEvent.type(input, "{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onSelect with the active item on Enter", async () => {
    const { onSelect } = renderPalette({ index: 0 });
    const input = screen.getByRole("searchbox");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    fireEvent(input, enter);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "n1" }));
    expect(enter.defaultPrevented).toBe(true);
  });

  it("calls onIndexChange on ArrowDown", async () => {
    const { onIndexChange } = renderPalette({ index: 0 });
    const input = screen.getByRole("searchbox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it("does not go above index 0 on ArrowUp", async () => {
    const { onIndexChange } = renderPalette({ index: 0 });
    const input = screen.getByRole("searchbox");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onIndexChange).toHaveBeenCalledWith(0);
  });

  it("keeps the command prefix in the editable query", () => {
    renderPalette({ query: ">some command" });
    expect(screen.getByRole("searchbox")).toHaveValue(">some command");
    expect(screen.getByRole("searchbox")).toHaveAttribute("placeholder", "Run a command…");
  });

  it("shows searching indicator", () => {
    renderPalette({ searching: true, items: [] });
    expect(screen.getByText(/searching/i)).toBeInTheDocument();
  });

  it("shows empty state when no items and not searching", () => {
    renderPalette({ items: [] });
    expect(screen.getByText(/no results/i)).toBeInTheDocument();
  });

  it("calls onSelect when an item is clicked", async () => {
    const { onSelect } = renderPalette();
    const betaButton = screen.getByText("Beta Note").closest("button")!;
    fireEvent.click(betaButton);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "n2" }));
  });

  // Regression: the client once typed the snippet `string[]` and rendered
  // `snippet[0]` — only the first CHARACTER. The whole snippet, with its
  // highlight, must render (contract since D76: { text, ranges }).
  it("renders the full node snippet, not just its first character", () => {
    const item: PaletteItem = {
      kind: "node",
      id: "n3",
      title: "Kafka Notes",
      hint: "draft",
      group: "Notes",
      snippet: { text: "intro to kafka streaming", ranges: [[9, 14]] },
    };
    renderPalette({ items: [item] });
    const snip = document.querySelector(".palette-item-snippet")!;
    expect(snip).toBeInTheDocument();
    // Full text reconstructed across the text/<mark> fragments.
    expect(snip.textContent).toBe("intro to kafka streaming");
    // The highlight is a real <mark>, not the literal first char "<".
    const mark = snip.querySelector("mark.palette-hl")!;
    expect(mark).toBeInTheDocument();
    expect(mark.textContent).toBe("kafka");
  });
});


it("ignores Enter while results are hidden by an ongoing search", () => {
  const { onSelect } = renderPalette({ searching: true });
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
  expect(onSelect).not.toHaveBeenCalled();
});

it("navigates in visible group order even when the input items are interleaved", () => {
  const { onIndexChange } = renderPalette({ items: [
    { kind: "action", id: "a", label: "A", hint: "", group: "Navigate", run: vi.fn() },
    { kind: "action", id: "b", label: "B", hint: "", group: "Actions", run: vi.fn() },
    { kind: "action", id: "c", label: "C", hint: "", group: "Navigate", run: vi.fn() },
  ] });
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
  expect(onIndexChange).toHaveBeenCalledWith(2);
});

it("supports keyboard activation, keeps Tab inside, and returns focus to the opener", async () => {
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  const { onSelect, rerender, props } = renderPalette();
  expect(screen.getByRole("searchbox")).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Tab", shiftKey: true });
  expect(screen.getByRole("button", { name: "Dismiss hint" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(screen.getByRole("searchbox")).toHaveFocus();
  const row = screen.getByText("Alpha Note").closest("button")!;
  row.focus(); await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "n1" }));
  rerender(<CommandPalette {...props} open={false} />);
  expect(opener).toHaveFocus(); opener.remove();
});

it("keeps the query and offers retry when search fails", () => {
  const retry = vi.fn();
  renderPalette({ items: [], query: "My query", searchError: true, onRetrySearch: retry });
  expect(screen.getByRole("alert")).toHaveTextContent("Search is unavailable");
  expect(screen.queryByText("No results")).toBeNull();
  expect(screen.getByRole("searchbox")).toHaveValue("My query");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledOnce();
});

it("does not close or submit twice while an action is pending", () => {
  const { onSelect, onClose } = renderPalette({ busy: true });
  const input = screen.getByRole("searchbox");
  expect(input).toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "Escape" });
  const layer = document.querySelector("dialog.palette-backdrop")!;
  fireEvent.pointerDown(layer); fireEvent.click(layer);
  expect(onSelect).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

// D85: the palette stops keys from reaching the app's dispatcher, so it must
// close on its own chord as this device has it — not on a literal ⌘K.
it("closes on the open-palette chord in effect, not on a hard-coded ⌘K", () => {
  try {
    setShortcutChord("open-palette", "$mod+j");
    const { onClose } = renderPalette();
    const input = screen.getByRole("searchbox");
    fireEvent.keyDown(input, { key: "k", code: "KeyK", ctrlKey: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "j", code: "KeyJ", ctrlKey: true });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByText(formatChord("$mod+j")).tagName).toBe("KBD");
  } finally {
    resetShortcuts();
  }
});
