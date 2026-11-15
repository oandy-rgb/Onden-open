import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NoteEdgeOutline from "../components/NoteEdgeOutline";
import { registerOutlineTarget } from "../lib/noteOutline";

// The outline of a long note at the right edge of its text (it replaced the info panel's 「段落」 tab).

const three = "# One\ntext\n## Two\ntext\n### Three\n";
const phone = (is: boolean) => {
  window.matchMedia = vi.fn((query: string) => ({
    matches: is && /max-width/.test(query), media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};
beforeEach(() => phone(false));
afterEach(() => { cleanup(); delete (window as { matchMedia?: unknown }).matchMedia; });

describe("NoteEdgeOutline", () => {
  it("shows nothing for a note with fewer than three headings", () => {
    const { container } = render(<NoteEdgeOutline nodeId="n" markdown={"# One\n## Two\n"} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows one named, keyboard-reachable line per heading from three on", () => {
    render(<NoteEdgeOutline nodeId="n" markdown={three} />);
    const lines = screen.getAllByRole("button");
    expect(lines.map((line) => line.getAttribute("aria-label"))).toEqual(["One", "Two", "Three"]);
    expect(lines.map((line) => line.className.match(/note-edge-line--h\d/)![0])).toEqual(["note-edge-line--h1", "note-edge-line--h2", "note-edge-line--h3"]);
    lines.forEach((line) => expect(line).not.toHaveAttribute("tabindex", "-1"));
  });

  it("is not drawn on a phone", () => {
    phone(true);
    const { container } = render(<NoteEdgeOutline nodeId="n" markdown={three} />);
    expect(container.firstChild).toBeNull();
  });

  it("a click scrolls the open note to that heading and marks it", () => {
    const scrollTo = vi.fn();
    const unregister = registerOutlineTarget("n", { scrollTo, tops: (hs) => hs.map((h) => h.index * 100 - 150), scroller: () => null });
    render(<NoteEdgeOutline nodeId="n" markdown={three} />);
    fireEvent.click(screen.getByRole("button", { name: "Two" }));
    expect(scrollTo).toHaveBeenCalledWith({ index: 1, level: 2, text: "Two", line: 2 });
    expect(screen.getByRole("button", { name: "Two" })).toHaveAttribute("aria-current", "location");
    unregister();
  });

  it("marks the heading the text is scrolled to and follows the scrolling", async () => {
    const scroller = document.createElement("div");
    let tops = [-300, -40, 500];
    const unregister = registerOutlineTarget("n", { scrollTo: () => {}, tops: () => tops, scroller: () => scroller });
    render(<NoteEdgeOutline nodeId="n" markdown={three} />);
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Two" })).toHaveAttribute("aria-current", "location"));
    tops = [-600, -340, -10];
    act(() => { scroller.dispatchEvent(new Event("scroll")); });
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Three" })).toHaveAttribute("aria-current", "location"));
    unregister();
  });
});
