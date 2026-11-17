// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import OverviewEditor from "../components/OverviewEditor";
import type { ContentNode } from "../lib/api";

// With no note open the editor must not claim the space is empty when the
// list beside it has notes: "No notes yet" is only for a space with none.

vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn(async () => new Response("[]", { status: 200 })) }));

const note: ContentNode = { id: "n1", title: "Note", slug: "note", markdown: "hello", node_type: "content", source_type: "manual" };

function editor(nodes: ContentNode[]) {
  return <OverviewEditor node={null} titleDraft="" onTitleChange={() => {}} draft="" onDraftChange={() => {}}
    view="edit" setView={() => {}} saveStatus="saved" onSave={() => {}} online nodes={nodes}
    onOpenWikilink={() => {}} onCreateFirst={() => {}} onSelectNode={() => {}} />;
}

afterEach(cleanup);

describe("editor with no note open", () => {
  it("says no note is open when the space has notes", () => {
    const { queryByText } = render(editor([note]));
    expect(queryByText("No notes yet")).toBeNull();
    expect(queryByText("No note is open")).not.toBeNull();
  });

  it("says there are no notes yet only in an empty space", () => {
    const { queryByText } = render(editor([]));
    expect(queryByText("No notes yet")).not.toBeNull();
    expect(queryByText("No note is open")).toBeNull();
  });
});
