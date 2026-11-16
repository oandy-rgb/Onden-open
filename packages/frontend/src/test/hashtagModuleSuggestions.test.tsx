// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import MarkdownEditor from "../components/MarkdownEditor";
import type { Tag } from "../lib/api";
import { resetAppState, setAppState } from "../lib/appStore";
import { getCompletions, type CompletionContext } from "../lib/editorCompletion";
import { hashtagSuggestionTags } from "../lib/moduleLibrary";
import { moduleStatusFor } from "../modules";

// The editor's { menu (內建功能預設全開, docs/architecture/module-library.md):
// your tags, tags of functions that are on (「來自「X」模組」), tags a function has
// not made yet or that is turned off (「加上「X」功能」: chosen, the host turns the
// function on — asking once first only for one that waits for the owner's yes —
// and writes the tag name). Only someone who may decide is offered
// the tags that need it.

// jsdom has no layout: CodeMirror's caret coordinates need these on Range.
const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const reading: Tag = { id: "reading", name: "讀書", color: "", schema_id: null, schema_extends: [], effective_modules: [] };
const reviewTag: Tag = { id: "review-tag", name: "複習", color: "", schema_id: "review-tag",
  schema_module: "review", schema_extends: [], effective_modules: ["review"] };
const project: Tag = { id: "project", name: "複雜系統", color: "", schema_id: null, schema_extends: [], effective_modules: [] };

function workspace(modules: string[]) {
  resetAppState();
  setAppState((s) => ({ data: { ...s.data, tags: [reading, reviewTag, project], actor_is_owner: true, workspace: { ...s.data.workspace, modules } } }));
}
afterEach(() => resetAppState());

describe("{ suggestions", () => {
  const ctx = (tags: CompletionContext["tags"]): CompletionContext =>
    ({ nodes: [], tags, attrClassTags: [], canSetAttr: false, canInsertPage: false, canCreateNote: false });
  const hashtag = (query: string) => ({ type: "blocktag" as const, query });

  it("lists your tags, tags of functions that are on, tags a function has not made yet", () => {
    const tags = hashtagSuggestionTags([reading, reviewTag, project], moduleStatusFor(["review"], []), { canImport: true });
    // Tasks and review have no tag of their own any more (migrations 195, 196) and skills has a note switch: nothing is offered by a name.
    expect(tags.filter((tag) => tag.virtual).map((tag) => tag.module?.id).sort()).toEqual([]);
    const rows = getCompletions(hashtag("複"), ctx(tags));
    expect(rows).toEqual([
      { id: "project", name: "複雜系統", color: "", kind: "own" },
      { id: "review-tag", name: "複習", color: "", kind: "function", module: { id: "review", title: "Review", state: "imported" } },
    ]);
    // A turned-off function's tag (here the one #複習 left when Review was turned off).
    const removed = hashtagSuggestionTags([reviewTag], moduleStatusFor([], []), { canImport: true });
    expect(getCompletions(hashtag("複"), ctx(removed))).toEqual([
      { id: "review-tag", name: "複習", color: "", kind: "function", module: { id: "review", title: "Review", state: "needs-import" } },
    ]);
  });

  it("a hidden tag of any kind is offered only for its full name (D104)", () => {
    const hiddenOwn: Tag = { ...project, hidden: true };
    const hiddenModule: Tag = { ...reviewTag, hidden: true };
    for (const imported of [["review"], []]) {
      const tags = hashtagSuggestionTags([reading, hiddenModule, hiddenOwn], moduleStatusFor(imported, []), { canImport: true });
      // A hidden module tag still counts as the module's tag: no virtual twin.
      expect(tags.filter((tag) => tag.module?.id === "review")).toHaveLength(1);
      const ids = (query: string) => getCompletions(hashtag(query), ctx(tags)).map((row) => (row as { id: string }).id);
      expect(ids("複")).toEqual([]);
      expect(ids("")).not.toContain("project");
      expect(ids("")).not.toContain("review-tag");
      expect(ids("複雜系統")).toEqual(["project"]);
      expect(ids("複習")).toEqual(["review-tag"]);
    }
  });

  it("someone who cannot decide gets no tags of functions they would have to turn on", () => {
    const tags = hashtagSuggestionTags([reviewTag], moduleStatusFor([], []), { canImport: false });
    expect(tags).toEqual([{ id: "review-tag", name: "複習", color: "", kind: "function", module: { id: "review", title: "Review", state: "not-imported" } }]);
  });

  it("a body # opens no list; the first finished #word still offers {word} once", async () => {
    workspace([]);
    const tags = hashtagSuggestionTags([project], moduleStatusFor([], []), { canImport: true });
    const { container } = render(<MarkdownEditor value="" onChange={vi.fn()} nodes={[]} onMediaInsert={vi.fn(async () => null)}
      workspaceTags={tags} onImportModuleTag={vi.fn(async () => null)} />);
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    const type = (insert: string) => { const at = view.state.doc.length; view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: "input.type" }); };
    type("#");
    type("複");
    expect(screen.queryByRole("button", { name: /複雜系統/ })).toBeNull();
    type(" ");
    expect(await screen.findByText("Tag this paragraph?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add tag" })).toBeInTheDocument();
  });
});
