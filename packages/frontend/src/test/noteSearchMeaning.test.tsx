// The one note search adds notes near the query's meaning, only when semantic search is on and the
// device is online, always after the exact matches (lib/data/noteSearch.ts).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";

const apiMock = vi.fn();
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: (...args: unknown[]) => apiMock(...args) }));
vi.mock("../lib/localDb", () => ({ searchNodes: vi.fn(async () => []) }));
await import("../modules"); // registers the modules' shell features
const { reads } = await import("../lib/data");

const note = (id: string, title: string): ContentNode => ({ id, title, slug: id, markdown: "", source_type: "manual", node_type: "content", hidden: false } as unknown as ContentNode);
const nodes = [note("exact", "Cats"), note("near", "Felines"), note("far", "Taxes")];

function workspace(modules: string[] | undefined) {
  resetAppState({ data: { ...noWorkspaceData, nodes, workspace: { ...noWorkspaceData.workspace, modules } } });
}
/** The server's text search answers `exact`; the meaning route answers `meaning`. */
function server(exact: unknown[], meaning: unknown[] | Error) {
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/semantic/search")) { if (meaning instanceof Error) throw meaning; return meaning; }
    return exact;
  });
}
const exactRow = { id: "exact", title: "Cats", node_type: "content", snippet: null };

describe("search by meaning in the one note search", () => {
  beforeEach(() => { apiMock.mockReset(); vi.restoreAllMocks(); });

  it("adds notes near the meaning after the exact matches, without repeating one", async () => {
    workspace(["semantic"]);
    server([exactRow], [{ id: "exact", title: "Cats", distance: 0 }, { id: "near", title: "Felines", distance: 0.1 }]);
    const out = await reads.notes.search("cats");
    expect(out.rows.map((r) => r.id)).toEqual(["exact", "near"]);
    expect(out.rows[1]).toMatchObject({ title: "Felines", node_type: "content", snippet: null });
  });

  it("with nothing exact, the meaning matches are the answer", async () => {
    workspace(["semantic"]);
    server([], [{ id: "near", title: "Felines", distance: 0.1 }]);
    expect((await reads.notes.search("kittens")).rows.map((r) => r.id)).toEqual(["near"]);
  });

  it("asks for none while semantic search is off, unknown to an older server, or the query has a filter", async () => {
    server([exactRow], [{ id: "near", title: "Felines", distance: 0.1 }]);
    for (const [modules, query] of [[["rss"], "cats"], [undefined, "cats"], [["semantic"], "cats #pets"], [["semantic"], "cats status:open"]] as const) {
      workspace(modules as string[] | undefined);
      apiMock.mockClear();
      await reads.notes.search(query);
      expect(apiMock.mock.calls.some(([path]) => String(path).startsWith("/api/semantic/search"))).toBe(false);
    }
  });

  it("a note this device does not have is not listed, and a failing meaning search costs only its own rows", async () => {
    workspace(["semantic"]);
    server([exactRow], [{ id: "unknown", title: "Gone", distance: 0.1 }]);
    expect((await reads.notes.search("cats")).rows.map((r) => r.id)).toEqual(["exact"]);
    server([exactRow], new Error("model unavailable"));
    expect((await reads.notes.search("cats")).rows.map((r) => r.id)).toEqual(["exact"]);
  });

  it("offline there is no meaning search", async () => {
    workspace(["semantic"]);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await reads.notes.search("cats");
    expect(apiMock).not.toHaveBeenCalled();
  });
});
