import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import OndenQueryBlock from "../components/OndenQueryBlock";
import { parseQuerySpec } from "@onden/markdown";

// Audit fix 1: every failure mode of the query pipeline — transport error,
// HTTP error, and a body that fails to parse (truncated JSON) — must exit
// the loading state into the error state. The old chain left a permanent
// "loading…" spinner when res.json() threw.

function okResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) } as unknown as Response;
}

describe("OndenQueryBlock", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders rows and the match count on success", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(okResponse({
      rows: [{ id: "1", title: "Hello", slug: "hello", updated_at: "2026-01-01T00:00:00Z" }],
      total: 1, next: null,
    }))));
    render(<OndenQueryBlock source="tag: reading" />);
    expect(await screen.findByText("Hello")).toBeTruthy();
    expect(screen.getByText("1 match")).toBeTruthy();
    expect(screen.queryByText("loading…")).toBeNull();
  });

  // D66: the count is the whole match, not the page — 120 notes with the
  // default page of 50 used to read "50 matches".
  it("shows the real total when the page holds fewer rows than match", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: String(i), title: `Note ${i}`, slug: `n${i}`, updated_at: "2026-01-01T00:00:00Z" }));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(okResponse({ rows, total: 120, next: 50 }))));
    render(<OndenQueryBlock source="tag: reading" />);
    expect(await screen.findByText("120 matches · showing 50")).toBeTruthy();
    expect(screen.queryByText("50 matches")).toBeNull();
  });

  it("a single tag is sent as a one-item list (the API accepts only arrays)", async () => {
    const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve(okResponse({ rows: [], total: 0, next: null })));
    vi.stubGlobal("fetch", fetchMock);
    render(<OndenQueryBlock source={"tags: reading\nsort: -title"} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.tags).toEqual(["reading"]);
    expect(body.sort).toBe("-title");
  });

  it("an HTTP error surfaces the mapped server message and clears the spinner", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: false,
      text: () => Promise.resolve(JSON.stringify({ error: "invalid_args" })),
      json: () => Promise.reject(new Error("not json")),
    } as unknown as Response)));
    render(<OndenQueryBlock source="tags: x" />);
    expect(await screen.findByText("The request wasn't valid.")).toBeTruthy();
    expect(screen.queryByText("loading…")).toBeNull();
  });

  it("a truncated body (res.json() throws) lands in the error state, not a permanent spinner", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
      text: () => Promise.resolve(""),
    } as unknown as Response)));
    render(<OndenQueryBlock source="tag: reading" />);
    expect(await screen.findByText("query failed")).toBeTruthy();
    expect(screen.queryByText("loading…")).toBeNull();
    expect(screen.queryByText(/match/)).toBeNull(); // no stale result row
  });

  it("a transport failure (fetch rejects) lands in the error state", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    render(<OndenQueryBlock source="tag: reading" />);
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();
    expect(screen.queryByText("loading…")).toBeNull();
  });

  it("an empty result shows 'no matches'", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(okResponse({ rows: [], total: 0, next: null }))));
    render(<OndenQueryBlock source="tag: nothing" />);
    expect(await screen.findByText("no matches")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("loading…")).toBeNull());
  });

  // A user's block `tag: 課程` listed every note: the parser passed `tag`
  // through, the API dropped the unknown key, and no filter ran.
  it("`tag:` is an alias of `tags:` and a CJK tag name goes out as the filter", async () => {
    const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve(okResponse({
      rows: [{ id: "1", title: "微積分講義", slug: "calc", updated_at: "2026-01-01T00:00:00Z" }],
      total: 1, next: null,
    })));
    vi.stubGlobal("fetch", fetchMock);
    render(<OndenQueryBlock source="tag: 課程" />);
    expect(await screen.findByText("微積分講義")).toBeTruthy();
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body).toEqual({ tags: ["課程"] });
  });

  it("an unknown key shows an inline error and never runs an unfiltered query", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse({ rows: [], total: 0, next: null })));
    vi.stubGlobal("fetch", fetchMock);
    render(<OndenQueryBlock source="tagz: 課程" />);
    expect(await screen.findByText(/Unknown query key “tagz”/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("no matches")).toBeNull();
  });

  it("a line that is not `key: value` shows an inline error", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse({ rows: [], total: 0, next: null })));
    vi.stubGlobal("fetch", fetchMock);
    render(<OndenQueryBlock source="this is not a spec at all" />);
    expect(await screen.findByText(/Can't read this query line/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("parseQuerySpec", () => {
  it("merges tag/tags lines, strips a leading #, keeps where/sort/limit", () => {
    expect(parseQuerySpec("tag: #課程\ntags: reading, 數學\nwhere:\n  stage: doing\nsort: -title\nlimit: 5")).toEqual({
      ok: true,
      spec: { tags: ["課程", "reading", "數學"], where: { stage: "doing" }, sort: "-title", limit: 5 },
    });
  });

  it("a block row, in the same list, names its note and opens it; an old `blocks: include` line still runs", async () => {
    const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve(okResponse({
      rows: [
        { id: "1", title: "Course", slug: "course", updated_at: "2026-01-01T00:00:00Z" },
        { id: "2", title: "Algorithms", slug: "algorithms", updated_at: "2026-01-02T00:00:00Z", block: { id: "b1", ref: "a2", label: "邊界 lo <= hi" } },
      ],
      total: 2, next: null,
    })));
    vi.stubGlobal("fetch", fetchMock);
    const opened: string[] = [];
    render(<OndenQueryBlock source={"tags: 課程\nblocks: include"} onSelectNode={(slug) => opened.push(slug)} />);
    (await screen.findByText("邊界 lo <= hi")).click();
    expect(opened).toEqual(["algorithms"]);
    expect(screen.getByText("Algorithms")).toBeTruthy();
    expect(screen.getByText("2 matches")).toBeTruthy();
    // Blocks take no tags from above (2026-11-09), so the line asks for nothing.
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ tags: ["課程"] });
  });

  it("a `blocks:` line is skipped, whatever it says", () => {
    expect(parseQuerySpec("tags: x\nblocks: all")).toEqual({ ok: true, spec: { tags: ["x"] } });
    expect(parseQuerySpec("tags: x")).toEqual({ ok: true, spec: { tags: ["x"] } });
  });
});

