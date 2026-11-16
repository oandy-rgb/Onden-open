// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { noWorkspaceData, type ContentNode, type Tag } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { useNoteFunctions } from "../hooks/useNoteFunctions";
import { tagWriter } from "../lib/data";
import { loadNoteFunctionModules } from "./helpers/noteFunctionModules";
// The info panel asks for its modules' files with import() as it mounts; they are loaded first so that no test ends while one is still on its way.
await loadNoteFunctionModules();

// 「還能用在這則」 reads the function catalog (lib/tagFunctions): each function
// the note does not have yet, with the catalog's sentence and a button that puts
// the function's tag on this note.

vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), getPendingWrites: vi.fn(async () => []) }));
vi.mock("../lib/data", async (original) => {
  const actual = await original<typeof import("../lib/data")>();
  return { ...actual, tagWriter: { ...actual.tagWriter, apply: vi.fn(async () => ({ status: "synced" })) } };
});

const note = { id: "n1", title: "An article", node_type: "content", parent_id: null, hidden: false, markdown: "", class_tag_ids: [], label_tag_ids: [] } as unknown as ContentNode;
const reviewTag = { id: "review-tag", name: "review", color: "", schema_id: "review-tag", schema_module: "review", schema_extends: [], effective_modules: ["review"] } as Tag;
const nav = { openNote: vi.fn(), setMode: vi.fn(), openCanvas: vi.fn() };

function start(tags: Tag[], modules: string[], current: ContentNode = note) {
  resetAppState({ data: { ...noWorkspaceData, actor_role: "admin", actor_is_owner: true, nodes: [current], tags, workspace: { ...noWorkspaceData.workspace, modules } } });
  return renderHook(() => useNoteFunctions(current, nav, vi.fn()));
}

beforeEach(() => vi.mocked(tagWriter.apply).mockClear());

describe("the info panel's 還能用在這則", () => {
  it("lists no catalog function row today: skills has its own switch row and review is a note command (the rows come back with the next tag function)", async () => {
    const { result } = start([reviewTag], ["review", "skills"]);
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));
    await import("../components/functionCatalog"); // the hook loads the catalog lazily: let it finish before the test ends
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));
    expect(result.current.some((row) => row.id.startsWith("function:"))).toBe(false);
    expect(result.current.some((row) => row.id === "function:skills")).toBe(false);
  });

  it("leaves out a function the note already has, and the task switches (they belong to a tag)", async () => {
    const tagged = { ...note, class_tag_ids: ["review-tag"] } as ContentNode;
    const { result } = start([reviewTag], ["review", "skills", "tasks"], tagged);
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));
    expect(result.current.some((row) => row.id === "function:review")).toBe(false);
    expect(result.current.some((row) => row.id.startsWith("function:tasks_"))).toBe(false);
  });
});
