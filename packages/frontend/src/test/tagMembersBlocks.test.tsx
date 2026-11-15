import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import TagMembers from "../components/tagPage/TagMembers";
import type { ContentNode, Tag } from "../lib/api";

// A tag's page lists, after its notes, the paragraphs carrying the tag themselves (`{…}`), read from the server a page
// at a time: each its words and its note, opening that note.

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) } as unknown as Response;
}

const tag = { id: "t1", name: "考點" } as Tag;
const note = { id: "n1", title: "演算法", updated_at: "2026-11-01T00:00:00Z", markdown: "" } as ContentNode;
const props = { tag, childTags: [], extenderTags: [], fieldModel: { allFields: [] } };

describe("TagMembers — the tag's paragraphs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists them after the notes, a page at a time, and a row opens its note", async () => {
    const fetchMock = vi.fn((url: unknown) => Promise.resolve(okResponse(String(url).includes("offset=1")
      ? { rows: [{ id: "b2", note_id: "n2", note_title: "資料結構", label: "堆積的高度" }], total: 2, next: null }
      : { rows: [{ id: "b1", note_id: "n1", note_title: "演算法", label: "二分搜尋的邊界" }], total: 2, next: 1 })));
    vi.stubGlobal("fetch", fetchMock);
    const opened: string[] = [];
    render(<TagMembers {...props} instances={[note]} onOpenNode={(id) => opened.push(id)} />);

    fireEvent.click(await screen.findByText("二分搜尋的邊界"));
    expect(opened).toEqual(["n1"]);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/api/tags/t1/blocks");
    fireEvent.click(screen.getByText("Show more"));
    expect(await screen.findByText("堆積的高度")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Show more")).toBeNull());
    expect(screen.getByText("資料結構")).toBeTruthy();
  });

  it("a tag only paragraphs carry does not say no note uses it; a failed read lists none", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(okResponse({ rows: [{ id: "b1", note_id: "n1", note_title: "演算法", label: "只在段落" }], total: 1, next: null }))));
    const { unmount } = render(<TagMembers {...props} instances={[]} />);
    expect(await screen.findByText("只在段落")).toBeTruthy();
    expect(screen.queryByText(/No notes use this tag yet/)).toBeNull();
    unmount();

    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("offline"))));
    render(<TagMembers {...props} instances={[]} />);
    expect(await screen.findByText(/No notes use this tag yet/)).toBeTruthy();
    expect(screen.queryByText("Paragraphs")).toBeNull();
  });

  it("an answer that is not a page (an older server, an error body) lists none and breaks nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(okResponse({ error: "not found" }))));
    render(<TagMembers {...props} instances={[note]} />);
    expect(await screen.findByText("演算法")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Paragraphs")).toBeNull());
  });
});
