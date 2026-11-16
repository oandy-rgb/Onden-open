// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import OverviewEditor from "../components/OverviewEditor";
import type { ContentNode } from "../lib/api";
import type { SaveStatus } from "../lib/appStore";
import { SLOW_SAVE_MS } from "../lib/useSaveNotice";

// Save feedback is for problems only: routine autosave must not flash text or
// a button, and the action row must not change while typing.

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn(async () => new Response("[]", { status: 200 })) }));

const note: ContentNode = { id: "note-a", title: "A", slug: "a", markdown: "text", node_type: "content", source_type: "manual" };

const editor = (saveStatus: SaveStatus, onSave = () => {}, online = true) => (
  <OverviewEditor node={note} titleDraft={note.title} onTitleChange={() => {}} draft={note.markdown ?? ""} onDraftChange={() => {}}
    view="edit" setView={() => {}} saveStatus={saveStatus} onSave={onSave} online={online} nodes={[note]}
    onOpenWikilink={() => {}} onCreateFirst={() => {}} onSelectNode={() => {}} />
);

const notice = (c: HTMLElement) => c.querySelector<HTMLElement>(".obsidian-save-notice")!;

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("note editor save notice", () => {
  it("shows no text or button for saved / unsaved / saving, and the live region stays mounted", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(editor("saved"));
    for (const s of ["saved", "unsaved", "saving", "saved"] as const) {
      rerender(editor(s));
      expect(notice(container).textContent).toBe("");
      expect(notice(container).getAttribute("aria-live")).toBe("polite");
      expect(container.querySelector(".obsidian-save-button, .obsidian-save-state")).toBeNull();
    }
  });

  it("keeps the quiet 'Waiting to sync' text for queued", () => {
    const { container } = render(editor("queued", undefined, false));
    expect(notice(container).textContent).toBe("Waiting to sync");
    expect(container.querySelector("button.obsidian-save-button")).toBeNull();
  });

  it("keeps the 'Retry saving' button for rejected, calling onSave", () => {
    const onSave = vi.fn();
    const { getByRole } = render(editor("rejected", onSave));
    fireEvent.click(getByRole("button", { name: "Retry saving" }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("shows plain 'Saving…' text, no button, after 5s unsaved online", () => {
    vi.useFakeTimers();
    const { container } = render(editor("unsaved"));
    act(() => { vi.advanceTimersByTime(SLOW_SAVE_MS); });
    expect(notice(container).textContent).toBe("Saving…");
    expect(container.querySelector("button.obsidian-save-button")).toBeNull();
  });
});
