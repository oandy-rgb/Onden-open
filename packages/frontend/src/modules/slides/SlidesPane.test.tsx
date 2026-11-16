// The note's 「簡報」 tab and the player: the pages come from the note's text, a
// chosen layout or theme is written as the note's slides_data (through the
// attribute writer), and the player draws the very same slide.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSlidesData } from "@onden/markdown";
import { noWorkspaceData, type ContentNode } from "../../lib/api";
import { resetAppState } from "../../lib/appStore";
import SlidesPane from "./SlidesPane";
import PresentationPlayer from "./PresentationPlayer";

const writes = vi.hoisted(() => ({ set: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) }));
vi.mock("../../lib/data/domainWriters", async (load) => ({ ...await load<typeof import("../../lib/data/domainWriters")>(), propertyWriter: { set: writes.set, remove: writes.remove } }));

const MD = "# Deck\n\nOpening line\n\n---\n\n## Plan\n\nSpeaker words.\n\n- one\n- two\n- three\n\n---\n\n## Why\n\nBecause.";
let NODE_ID = "";
let noteCount = 0;
const note = (attrs?: Record<string, string>) => ({ id: NODE_ID, title: "My talk", slug: "my-talk", markdown: MD, node_type: "content", source_type: "manual", attrs } as unknown as ContentNode);

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
}, 30_000);
beforeEach(() => {
  resetAppState({ data: { ...noWorkspaceData, nodes: [note()] } });
  // A fresh note id per test: the page a note was left on is remembered for the whole page load.
  NODE_ID = `00000000-0000-4000-8000-${String(++noteCount).padStart(12, "0")}`;
  writes.set.mockClear(); writes.remove.mockClear();
});
afterEach(cleanup);

const pane = (n = note(), canEdit = true) => render(<SlidesPane node={n} canEdit={canEdit} onOpenNode={() => {}} />);
const thumbs = () => screen.getAllByRole("button", { name: /^Slide \d+$/ });
const big = () => document.querySelector(".sp-big .sv-canvas") as HTMLElement;
const lastWrite = () => parseSlidesData(String((writes.set.mock.calls.at(-1) as unknown[])[2]));

describe("the 簡報 tab", () => {
  it("shows the note's pages without anything stored, and names the speaker's words apart", () => {
    pane();
    expect(thumbs()).toHaveLength(3);
    expect(big().dataset.layout).toBe("cover"); // first page: heading and one line
    fireEvent.click(thumbs()[1]);
    expect(big().dataset.layout).toBe("three"); // three short points
    expect(big().textContent).not.toContain("Speaker words");
    expect(screen.getByText("Speaker notes")).toBeInTheDocument();
    expect(writes.set).not.toHaveBeenCalled();
  });

  it("changes a page's layout and writes only the choice, keyed by the page", async () => {
    pane();
    fireEvent.click(thumbs()[1]);
    fireEvent.click(screen.getByRole("button", { name: /^Layout:/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "Bullets" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(writes.set).toHaveBeenCalledTimes(1));
    expect(writes.set).toHaveBeenCalledWith(NODE_ID, "slides_data", expect.any(String));
    expect(lastWrite()).toEqual({ v: 1, theme: "site", layouts: { "h:plan": "bullets" } });
  });

  it("previews 「Change to…」 on the page's own words and saves only on Apply", async () => {
    pane();
    fireEvent.click(thumbs()[1]);
    expect(big().dataset.layout).toBe("three");
    fireEvent.click(screen.getByRole("button", { name: /^Layout:/ }));
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled(); // nothing to apply until another layout is shown
    fireEvent.mouseEnter(await screen.findByRole("radio", { name: "Bullets" }));
    expect(big().dataset.layout).toBe("bullets");
    expect(big().textContent).toContain("two"); // the real words of this page, not a sample
    expect(writes.set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(big().dataset.layout).toBe("three"); // back to what was saved
    expect(writes.set).not.toHaveBeenCalled();
  });

  it("opens 「Change to…」 from a press on the slide, and a half-chosen layout stays with its page", async () => {
    pane();
    fireEvent.click(thumbs()[1]);
    fireEvent.click(document.querySelector(".sp-big .sp-hit") as HTMLElement);
    fireEvent.click(await screen.findByRole("radio", { name: "Paragraphs" }));
    expect(big().dataset.layout).toBe("text");
    fireEvent.click(thumbs()[2]);
    expect(screen.queryByRole("radio", { name: "Paragraphs" })).toBeNull();
    expect(big().dataset.layout).not.toBe("text");
  });

  it("shows a stored choice, and 「Automatic」 takes it back by removing the attribute", async () => {
    pane(note({ slides_data: JSON.stringify({ v: 1, theme: "site", layouts: { "h:plan": "text" } }) }));
    fireEvent.click(thumbs()[1]);
    expect(big().dataset.layout).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: /^Layout:/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "Automatic" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(writes.remove).toHaveBeenCalledWith(NODE_ID, "slides_data"));
  });

  it("choosing on a page whose old and new keys collide with another's keeps the other page's choice", async () => {
    const stored = note({ slides_data: JSON.stringify({ v: 1, theme: "site", layouts: { "p:hello": "quote", "p:hello~2": "stat" } }) });
    stored.markdown = "- a\n\nhello\n\n---\n\nhello";
    pane(stored);
    fireEvent.click(thumbs()[1]);
    expect(big().dataset.layout).toBe("stat"); // page 2 reads its own old key, not page 1's
    fireEvent.click(screen.getByRole("button", { name: /^Layout:/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "Paragraphs" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(writes.set).toHaveBeenCalledTimes(1));
    expect(lastWrite().layouts).toEqual({ "p:a": "quote", "p:hello": "text" });
  });

  it("a stored choice still finds its page after the page's other words change", () => {
    const stored = note({ slides_data: JSON.stringify({ v: 1, theme: "site", layouts: { "h:plan": "text" } }) });
    stored.markdown = MD.replace("- one", "- uno").replace("Speaker words.", "New speaker words.");
    pane(stored);
    fireEvent.click(thumbs()[1]);
    expect(big().dataset.layout).toBe("text");
  });

  it("chooses the theme (the whole deck) and writes it", async () => {
    pane();
    fireEvent.click(screen.getByRole("button", { name: /Like my website/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Dark/ }));
    await waitFor(() => expect(writes.set).toHaveBeenCalled());
    expect(lastWrite().theme).toBe("dark");
  });

  it("← and → change the page from anywhere in the pane, and the thumbnails take all four arrows", () => {
    pane();
    const current = () => thumbs().findIndex((b) => b.getAttribute("aria-current") === "true");
    fireEvent.click(thumbs()[0]);
    const strip = screen.getByRole("list", { name: "Slides" });
    fireEvent.keyDown(document.querySelector(".sp-big .sp-hit")!, { key: "ArrowRight" });
    expect(current()).toBe(1);
    fireEvent.keyDown(thumbs()[1], { key: "ArrowRight" }); // a row of thumbnails (a phone)
    expect(current()).toBe(2);
    fireEvent.keyDown(thumbs()[2], { key: "ArrowRight" }); // never past the end
    expect(current()).toBe(2);
    fireEvent.keyDown(thumbs()[2], { key: "ArrowLeft" });
    expect(current()).toBe(1);
    fireEvent.keyDown(thumbs()[1], { key: "ArrowDown" }); // a column (a desktop)
    expect(current()).toBe(2);
    fireEvent.keyDown(strip, { key: "ArrowUp" });
    expect(current()).toBe(1);
  });

  it("keeps ← and → for a menu or field, and for the 「Change to…」 list", async () => {
    pane();
    fireEvent.click(thumbs()[1]);
    fireEvent.click(screen.getByRole("button", { name: /^Layout:/ }));
    fireEvent.keyDown(await screen.findByRole("radio", { name: "Bullets" }), { key: "ArrowRight" });
    expect(thumbs()[1]).toHaveAttribute("aria-current", "true");
  });

  it("Esc closes 「Change to…」 on a desktop and puts the page back", async () => {
    pane();
    fireEvent.click(thumbs()[1]);
    fireEvent.click(screen.getByRole("button", { name: /^Layout:/ }));
    fireEvent.mouseEnter(await screen.findByRole("radio", { name: "Bullets" }));
    expect(big().dataset.layout).toBe("bullets");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("radio", { name: "Bullets" })).toBeNull();
    expect(big().dataset.layout).toBe("three");
    expect(writes.set).not.toHaveBeenCalled();
  });

  it("lets a reader look and play but not change anything", () => {
    pane(note(), false);
    expect(screen.getByRole("button", { name: /^Layout:/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Like my website/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Play/ })).toBeEnabled();
  });
});

describe("the view and the player are one rendering", () => {
  it("draws the same slide, with the same layout and theme", async () => {
    const stored = note({ slides_data: JSON.stringify({ v: 1, theme: "dark", layouts: { "h:plan": "bullets" } }) });
    const { unmount } = pane(stored);
    fireEvent.click(thumbs()[1]);
    const inView = big();
    const view = { layout: inView.dataset.layout, html: inView.innerHTML, vars: inView.style.getPropertyValue("--s-bg") };
    unmount();
    render(<PresentationPlayer markdown={stored.markdown!} title="My talk" from={stored} data={parseSlidesData(stored.attrs!.slides_data)} startAt={1} onClose={() => {}} />);
    const inPlayer = document.querySelector(".presentation .sv-canvas") as HTMLElement;
    expect(view.layout).toBe("bullets");
    expect({ layout: inPlayer.dataset.layout, html: inPlayer.innerHTML, vars: inPlayer.style.getPropertyValue("--s-bg") }).toEqual(view);
    expect(within(document.querySelector(".presentation") as HTMLElement).getByText("2 / 3")).toBeInTheDocument();
  });
});

describe("the 簡報 tab keeps its page", () => {
  const deckOf = (...names: string[]) => names.map((n) => `## ${n}\n\n- a\n- b`).join("\n\n---\n\n");
  const withMarkdown = (id: string, markdown: string) => ({ ...note(), id, markdown } as ContentNode);
  const on = () => thumbs().findIndex((b) => b.getAttribute("aria-current") === "true") + 1;
  const FIVE = deckOf("Alpha", "Beta", "Gamma", "Delta", "Epsilon");

  it("comes back to the same page after the tab is closed and opened", () => {
    const n = withMarkdown("00000000-0000-4000-8000-0000000000b1", FIVE);
    const first = pane(n);
    fireEvent.click(thumbs()[2]);
    first.unmount();
    pane(n);
    expect(on()).toBe(3);
  });

  it("stays on the same slide when a page is added before it", () => {
    const id = "00000000-0000-4000-8000-0000000000b2";
    const first = pane(withMarkdown(id, FIVE));
    fireEvent.click(thumbs()[2]);
    first.unmount();
    pane(withMarkdown(id, deckOf("Zero", "Alpha", "Beta", "Gamma", "Delta", "Epsilon")));
    expect(on()).toBe(4);
  });

  it("moves to the next page when the chosen one is deleted, and to the last when it was last", () => {
    const id = "00000000-0000-4000-8000-0000000000b3";
    const first = pane(withMarkdown(id, FIVE));
    fireEvent.click(thumbs()[2]);
    first.unmount();
    const second = pane(withMarkdown(id, deckOf("Alpha", "Beta", "Delta", "Epsilon")));
    expect(on()).toBe(3);
    fireEvent.click(thumbs()[3]);
    second.unmount();
    pane(withMarkdown(id, deckOf("Alpha", "Beta", "Delta")));
    expect(on()).toBe(3);
  });

  it("keeps each note's own page", () => {
    const a = withMarkdown("00000000-0000-4000-8000-0000000000b4", FIVE);
    const b = withMarkdown("00000000-0000-4000-8000-0000000000b5", FIVE);
    const first = pane(a);
    fireEvent.click(thumbs()[3]);
    first.unmount();
    const other = pane(b);
    expect(on()).toBe(1);
    other.unmount();
    pane(a);
    expect(on()).toBe(4);
  });

  it("selects the last page seen while playing when the player closes", async () => {
    const n = withMarkdown("00000000-0000-4000-8000-0000000000b6", FIVE);
    pane(n);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    const surface = await waitFor(() => { const el = document.querySelector(".presentation"); if (!el) throw new Error("not yet"); return el; });
    fireEvent.keyDown(surface, { key: "End" });
    fireEvent.click(screen.getByRole("button", { name: "Leave the slides" }));
    await waitFor(() => expect(on()).toBe(5));
  });
});
