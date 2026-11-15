import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import PresentationPlayer from "./PresentationPlayer";
import { resetAppState } from "../../lib/appStore";
import { noWorkspaceData, type ContentNode } from "../../lib/api";

// Playing a note: keys and swipes move between slides, each slide names the
// sources it cites, and choosing one leaves the deck and opens that note.
const deck = "## One\nFirst [1]\n\n---\n\n## Two\nSecond\n\n---\n\n## Three\nThird\n\n---\n\n## Sources\n\n[1] [[ch-1|Chapter one]]\n";

beforeAll(() => {
  // jsdom has no <dialog> top layer.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  // The first render and the first slide changes in a file pay the one-time
  // cost of the renderer, the modal and React itself (~1 s here, five times
  // that on a busy machine). A synchronous test cannot wait that out: it
  // crossed the 5 s timeout of whichever test came first. Pay it here, with
  // its own budget, so each test times only its own keys and swipes.
  render(<PresentationPlayer markdown={deck} title="Deck" onClose={() => {}} />);
  for (const key of ["ArrowRight", "End"]) fireEvent.keyDown(document.querySelector(".presentation")!, { key });
  cleanup();
}, 30_000);
beforeEach(() => {
  resetAppState({ data: { ...noWorkspaceData, nodes: [{ id: "n-ch1", title: "Chapter one", slug: "ch-1", markdown: "", node_type: "content", source_type: "manual" } as ContentNode] } });
});
afterEach(cleanup);

const heading = () => screen.getByRole("heading").textContent;
const surface = () => document.querySelector(".presentation")!;

describe("presentation player", () => {
  it("moves with the arrow keys and a swipe, and never past either end", () => {
    render(<PresentationPlayer markdown={deck} title="Deck" onClose={() => {}} />);
    expect(heading()).toBe("One");
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    fireEvent.keyDown(surface(), { key: "ArrowLeft" });
    expect(heading()).toBe("One");
    fireEvent.keyDown(surface(), { key: "ArrowRight" });
    expect(heading()).toBe("Two");
    fireEvent.pointerDown(surface(), { isPrimary: true, clientX: 300, clientY: 100 });
    fireEvent.pointerUp(surface(), { isPrimary: true, clientX: 100, clientY: 110 });
    expect(heading()).toBe("Three");
    fireEvent.keyDown(surface(), { key: "End" });
    fireEvent.keyDown(surface(), { key: "ArrowRight" });
    expect(heading()).toBe("Three");
    fireEvent.keyDown(surface(), { key: "Home" });
    expect(heading()).toBe("One");
  });

  it("a short or vertical drag is not a swipe", () => {
    render(<PresentationPlayer markdown={deck} title="Deck" onClose={() => {}} />);
    fireEvent.pointerDown(surface(), { isPrimary: true, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(surface(), { isPrimary: true, clientX: 80, clientY: 100 });
    fireEvent.pointerDown(surface(), { isPrimary: true, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(surface(), { isPrimary: true, clientX: 40, clientY: 300 });
    expect(heading()).toBe("One");
  });

  it("the footer names this slide's sources; choosing one leaves and opens the note", () => {
    const onClose = vi.fn();
    const onOpenNode = vi.fn();
    render(<PresentationPlayer markdown={deck} title="Deck" onClose={onClose} onOpenNode={onOpenNode} />);
    fireEvent.click(screen.getByRole("button", { name: "[1] Chapter one" }));
    expect(onClose).toHaveBeenCalled();
    expect(onOpenNode).toHaveBeenCalledWith("n-ch1");
  });

  it("the source list is not played as a slide, and a slide citing nothing has no footer", () => {
    render(<PresentationPlayer markdown={deck} title="Deck" onClose={() => {}} />);
    fireEvent.keyDown(surface(), { key: "ArrowRight" });
    expect(document.querySelector(".presentation-sources")).toBeNull();
    fireEvent.keyDown(surface(), { key: "End" });
    expect(heading()).toBe("Three");
  });
});

describe("presenting on a phone held upright", () => {
  const request = vi.fn(async () => {});
  const lock = vi.fn(async () => {});
  const unlock = vi.fn();
  function upright(matches: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: matches && /orientation: portrait/.test(query), media: query, addEventListener() {}, removeEventListener() {} }));
    Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: request });
    Object.defineProperty(window.screen, "orientation", { configurable: true, value: { lock, unlock } });
  }
  afterEach(() => { vi.unstubAllGlobals(); request.mockClear(); lock.mockClear(); unlock.mockClear(); });

  it("asks for full screen turned sideways, and says to turn the phone", async () => {
    upright(true);
    const { unmount } = render(<PresentationPlayer markdown={deck} title="Deck" onClose={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Turn your phone sideways");
    expect(request).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(lock).toHaveBeenCalledWith("landscape"));
    unmount();
    expect(unlock).toHaveBeenCalled();
  });

  it("shows no error when the browser refuses", async () => {
    upright(true);
    request.mockRejectedValueOnce(new Error("denied"));
    render(<PresentationPlayer markdown={deck} title="Deck" onClose={() => {}} />);
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    expect(lock).not.toHaveBeenCalled();
    expect(screen.queryByText(/denied/)).toBeNull();
    expect(heading()).toBe("One");
  });

  it("leaves a wide or sideways screen alone", () => {
    upright(false);
    render(<PresentationPlayer markdown={deck} title="Deck" onClose={() => {}} />);
    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector(".presentation-rotate")).toBeNull();
  });
});
