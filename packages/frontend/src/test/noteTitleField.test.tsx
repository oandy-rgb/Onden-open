// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import OverviewEditor from "../components/OverviewEditor";
import { apiFetch, type ContentNode } from "../lib/api";
import { displayTitle, isPlaceholderTitle, noteLabel } from "../lib/noteLabel";

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn() }));

// jsdom has no layout; the body editor's measure pass (a frame after render) needs these on Range,
// or it throws after the test ends and the run reports an unhandled error.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const note: ContentNode = { id: "n1", title: "Untitled", slug: "u", markdown: "", node_type: "content", source_type: "manual" };

function editor(titleDraft: string, onTitleChange: (t: string) => void = () => {}) {
  return <OverviewEditor node={note} titleDraft={titleDraft} onTitleChange={onTitleChange} draft="" onDraftChange={() => {}}
    view="edit" setView={() => {}} saveStatus="saved" onSave={() => {}} online nodes={[note]}
    onOpenWikilink={() => {}} onCreateFirst={() => {}} onSelectNode={() => {}} />;
}
const title = () => screen.getByRole("textbox", { name: "Note title" }) as HTMLTextAreaElement;

describe("a new note's title", () => {
  it("shows the placeholder title as an empty field with a placeholder", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response("[]", { status: 200 }));
    await act(async () => { render(editor("Untitled")); });
    expect(title().value).toBe("");
    expect(title().placeholder).toBe("Untitled");
  });

  it("takes focus when asked for, even before anything is typed", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response("[]", { status: 200 }));
    const { requestNoteTitleFocus } = await import("../lib/cardTitleFocus");
    requestNoteTitleFocus(note.id);
    await act(async () => { render(editor("Untitled")); });
    expect(document.activeElement).toBe(title());
  });

  it("keeps typed text as it is and never puts a line break in it", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response("[]", { status: 200 }));
    const changes: string[] = [];
    await act(async () => { render(editor("", (v) => changes.push(v))); });
    fireEvent.change(title(), { target: { value: "期中考\n複習計畫" } });
    expect(changes).toEqual(["期中考 複習計畫"]);
  });

  it("Enter leaves the title for the body; Shift+Enter and IME Enter add no line break", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response("[]", { status: 200 }));
    await act(async () => { render(editor("Hello")); });
    title().focus();
    const plain = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => { title().dispatchEvent(plain); });
    expect(plain.defaultPrevented).toBe(true);
    const shift = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    await act(async () => { title().dispatchEvent(shift); });
    expect(shift.defaultPrevented).toBe(true);
    // Composing: the IME takes Enter to confirm a candidate; the title is left alone.
    title().focus();
    const ime = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
    await act(async () => { title().dispatchEvent(ime); });
    expect(ime.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(title());
  });
});

describe("a note nobody named", () => {
  it("is 「未命名」 in lists, whether its title is blank or the placeholder", () => {
    expect(isPlaceholderTitle("Untitled")).toBe(true);
    expect(isPlaceholderTitle("  ")).toBe(true);
    expect(isPlaceholderTitle("期中考")).toBe(false);
    expect(displayTitle("")).toBe("Untitled");
    expect(noteLabel({ title: "Untitled", markdown: "" })).toBe("Untitled");
    expect(noteLabel({ title: "", markdown: "# 計畫\n內文" })).toBe("計畫");
  });
});
