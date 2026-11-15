vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  getPendingWrites: vi.fn(async () => []), getNodeAttributeRecord: vi.fn(async () => null),
  upsertAttribute: vi.fn(async () => {}), removeAttribute: vi.fn(async () => {}),
}));
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import OverviewEditorHost from "../components/OverviewEditorHost";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";
// History rows read the session; the real store keeps a 1 s unmount timer that can outlive the test environment.
vi.mock("../lib/accountSession", () => ({ useAccountSession: () => null }));

// Version history is a header action: "Edited 3 minutes ago" under the title
// (the phrase itself is the link) and "Version history" in the ⋯ menu open the same
// compare/restore dialog the timeline uses (useVersionHistoryDialog).

vi.mock("../hooks/useVersionRestore", () => ({ useVersionRestore: () => ({ restore: vi.fn(), restoringVersionId: null, feedback: null }) }));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const node: ContentNode = { id: "a", title: "Note", slug: "a", markdown: "Saved", source_type: "manual", node_type: "content",
  updated_at: minutesAgo(3) };
const versions = [{ id: "v1", title: "Note", markdown: "Older body", changed_at: minutesAgo(30), actor_name: "Ada", actor_type: "user", saves: 2 }];
const noteActions = {
  exportNote: async () => true, copyMarkdown: async () => true, exportBusy: false,
  runNoteCommand: () => {},
};

function host(nodeVersions = versions) {
  return <OverviewEditorHost onOpenWikilink={() => {}} onCreateFirst={() => {}} nodeVersions={nodeVersions} noteActions={noteActions} />;
}

beforeAll(async () => {
  // The dialog and its preview are lazy chunks: load them once (see
  // nodeVersionPreview.test.tsx).
  await Promise.all([import("../components/history"), import("../components/OverviewPreview")]);
});
beforeEach(() => {
  global.fetch = vi.fn(async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
  act(() => setLocalePref("en"));
  resetAppState({ data: { ...noWorkspaceData, nodes: [node] }, selectedId: node.id, overviewDraft: "Saved", overviewTitleDraft: "Note", online: true });
});
afterEach(() => { cleanup(); resetAppState(); act(() => setLocalePref("system")); vi.restoreAllMocks(); });

describe("version history in the note header", () => {
  it("says when the note was edited and opens the versions dialog", async () => {
    render(host());
    const link = screen.getByRole("button", { name: "Edited 3 minutes ago, open this note's history" });
    expect(within(link).getByText("Edited 3 minutes ago").tagName).toBe("TIME");
    expect(screen.queryByText("·")).toBeNull();
    fireEvent.click(link);
    const dialog = await screen.findByRole("dialog", { name: "Version history" });
    expect(await within(dialog).findByText("Older body")).toBeVisible();
  });

  it("the ⋯ menu opens the same dialog", async () => {
    render(host());
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "History of this note" }));
    expect(await screen.findByRole("dialog", { name: "Version history" })).toBeVisible();
  });

  it("the command palette's 「這篇筆記的歷史」 opens the same dialog", async () => {
    render(host());
    act(() => { window.dispatchEvent(new CustomEvent("onden-open-note-history")); });
    expect(await screen.findByRole("dialog", { name: "Version history" })).toBeVisible();
  });

  it("offers no version history before the note has saved versions", () => {
    render(host([]));
    expect(screen.getByText("Edited 3 minutes ago")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open this note's history/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitem", { name: "History of this note" })).toBeNull();
  });

  it("reads 「3 分鐘前修改」 as the history link under zh-TW", () => {
    act(() => setLocalePref("zh-TW"));
    render(host());
    expect(screen.getByRole("button", { name: "3 分鐘前修改，打開這篇筆記的歷史" })).toHaveTextContent("3 分鐘前修改");
    expect(screen.queryByText("版本歷史")).toBeNull();
  });
});
