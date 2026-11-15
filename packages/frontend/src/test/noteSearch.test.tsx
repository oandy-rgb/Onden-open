import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { SnippetText } from "../components/SnippetText";
import { ApiError, noWorkspaceData, type ContentNode, type Tag } from "../lib/api";
import { resetAppState } from "../lib/appStore";

const apiMock = vi.fn();
const localMock = vi.fn();
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: (...args: unknown[]) => apiMock(...args) }));
vi.mock("../lib/localDb", () => ({ searchNodes: (...args: unknown[]) => localMock(...args) }));
const { reads } = await import("../lib/data");
const searchNotes = reads.notes.search;


const nodes = [
  { id: "a", title: "Alpha", node_type: "content", hidden: false, markdown: "alpha notes", class_tag_ids: [], label_tag_ids: ["book"], updated_at: "2026-01-02" },
  { id: "t", title: "A task row", node_type: "content", hidden: true, markdown: "", class_tag_ids: [], label_tag_ids: [], updated_at: "2026-01-01" },
  { id: "k", title: "Kafka streams", node_type: "content", hidden: false, markdown: "log processing", class_tag_ids: [], label_tag_ids: ["book"], updated_at: "2026-01-03" },
  { id: "b", title: "Bravo", node_type: "content", hidden: false, markdown: "", class_tag_ids: [], label_tag_ids: ["sub"], updated_at: "2026-01-04" },
] as unknown as ContentNode[];
const tags = [
  { id: "book", name: "Book" },
  { id: "sub", name: "Novel", parent_id: "book" },
] as unknown as Tag[];

function setOnline(online: boolean) { vi.spyOn(navigator, "onLine", "get").mockReturnValue(online); }

describe("searchNotes", () => {
  beforeEach(() => {
    apiMock.mockReset(); localMock.mockReset(); vi.restoreAllMocks();
    resetAppState({ data: { ...noWorkspaceData, nodes, tags } });
  });

  it("asks the server first", async () => {
    apiMock.mockResolvedValue([{ id: "a", title: "Alpha", node_type: "content", snippet: { text: "alpha", ranges: [[0, 2]] } }]);
    const out = await searchNotes("al");
    expect(out).toMatchObject({ offline: false, fieldFilterSkipped: false });
    expect(out.rows).toHaveLength(1);
    expect(localMock).not.toHaveBeenCalled();
  });

  it("falls back to the local index when the request fails for a retryable reason (hidden notes stay findable)", async () => {
    apiMock.mockRejectedValue(new TypeError("Failed to fetch"));
    localMock.mockResolvedValue([{ id: "a", snippet: { text: "Alpha", ranges: [[0, 2]] } }, { id: "t", snippet: null }, { id: "gone", snippet: null }]);
    const out = await searchNotes("al");
    expect(out.offline).toBe(true);
    expect(out.rows).toEqual([
      { id: "a", title: "Alpha", node_type: "content", snippet: { text: "Alpha", ranges: [[0, 2]] } },
      { id: "t", title: "A task row", node_type: "content", snippet: null },
    ]);
  });

  it("a one-character query (one Chinese character) is answered by this device's index: the server takes two or more", async () => {
    localMock.mockResolvedValue([{ id: "k", snippet: null }]);
    const out = await searchNotes("書");
    expect(apiMock).not.toHaveBeenCalled();
    expect(localMock).toHaveBeenCalledWith("書");
    expect(out).toMatchObject({ offline: false, rows: [{ id: "k", title: "Kafka streams" }] });
  });

  it("does not turn a permanent refusal into a local answer", async () => {
    apiMock.mockRejectedValue(new ApiError(403, "{}"));
    await expect(searchNotes("al")).rejects.toThrow();
    expect(localMock).not.toHaveBeenCalled();
  });

  it("goes straight to the local index while offline", async () => {
    setOnline(false);
    localMock.mockResolvedValue([{ id: "k", snippet: null }]);
    const out = await searchNotes("kafka");
    expect(apiMock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ offline: true, rows: [{ id: "k" }] });
  });

  it("finds a mistyped title from the server's empty answer, and offline too", async () => {
    apiMock.mockResolvedValue([]);
    expect((await searchNotes("kafak streams")).rows.map((r) => r.id)).toEqual(["k"]);
    setOnline(false);
    localMock.mockResolvedValue([]);
    const out = await searchNotes("kafak streams");
    expect(out.offline).toBe(true);
    expect(out.rows.map((r) => r.id)).toEqual(["k"]);
  });

  it("offline, #tag keeps the notes under that tag (child tags count) and the text still matches", async () => {
    setOnline(false);
    localMock.mockResolvedValue([{ id: "a", snippet: null }, { id: "b", snippet: null }, { id: "t", snippet: null }]);
    expect(localMock).not.toHaveBeenCalled();
    const out = await searchNotes("a #book");
    expect(localMock).toHaveBeenCalledWith("a");
    expect(out.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out.fieldFilterSkipped).toBe(false);
  });

  it("offline, a query of only #tag lists that tag's notes, newest first; an unknown tag lists none", async () => {
    setOnline(false);
    expect((await searchNotes("#book")).rows.map((r) => r.id)).toEqual(["b", "k", "a"]);
    expect((await searchNotes("#nothing")).rows).toEqual([]);
  });

  it("offline, key:value cannot be applied: the outcome says so", async () => {
    setOnline(false);
    localMock.mockResolvedValue([{ id: "k", snippet: null }]);
    const out = await searchNotes("kafka status:reading");
    expect(localMock).toHaveBeenCalledWith("kafka");
    expect(out).toMatchObject({ offline: true, fieldFilterSkipped: true });
    expect((await searchNotes("status:reading")).rows).toEqual([]);
  });
});

describe("SnippetText", () => {
  it("renders only the ranges as marks; markup in the text stays text", () => {
    const text = "a hit <img src=x onerror=alert(1)> <mark>no</mark>";
    const { container } = render(<SnippetText snippet={{ text, ranges: [[2, 5]] }} markClassName="hl" />);
    expect(container.querySelectorAll("mark.hl")).toHaveLength(1);
    expect(container.querySelectorAll("mark")).toHaveLength(1);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe(text);
  });

  it("skips an out-of-order or out-of-bounds range instead of repeating text", () => {
    const { container } = render(<SnippetText snippet={{ text: "abcdef", ranges: [[2, 4], [1, 3], [5, 99]] }} />);
    expect(container.textContent).toBe("abcdef");
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["cd"]);
  });
});
