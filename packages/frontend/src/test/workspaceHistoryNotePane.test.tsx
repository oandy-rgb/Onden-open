import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import WorkspaceHistoryNotePane from "../components/history/WorkspaceHistoryNotePane";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";

const h = vi.hoisted(() => ({ versions: vi.fn(), hydrate: vi.fn() }));
vi.mock("../hooks/useVersionRestore", () => ({ useVersionRestore: () => ({ restore: vi.fn(), restoringVersionId: null, feedback: null }) }));
vi.mock("../lib/accountSession", () => ({ useAccountSession: () => null }));
vi.mock("../lib/data", async (original) => ({
  ...await original<typeof import("../lib/data")>(),
  reads: { notes: { versions: h.versions, inkEdits: async () => [] } },
  dataSync: { hydrateNode: h.hydrate },
}));

const note: ContentNode = { id: "n1", title: "Plan", slug: "plan", markdown: "Now text", source_type: "manual", node_type: "content" };
const versions = [
  { id: "v2", title: "Plan", markdown: "Second text", changed_at: "2026-09-02T08:00:00Z", actor_name: "Me", actor_type: "user" },
  { id: "v1", title: "Plan", markdown: "First text", changed_at: "2026-09-01T08:00:00Z", actor_name: "Me", actor_type: "user" },
];

beforeAll(async () => { await import("../components/OverviewPreview"); });
beforeEach(() => {
  h.versions.mockReset().mockResolvedValue(versions);
  h.hydrate.mockReset().mockResolvedValue(undefined);
  setLocalePref("en");
  resetAppState({ data: { ...noWorkspaceData, nodes: [note] }, online: true });
});
afterEach(() => { cleanup(); resetAppState(); setLocalePref("system"); });

const pane = (over: Partial<React.ComponentProps<typeof WorkspaceHistoryNotePane>> = {}) =>
  render(<WorkspaceHistoryNotePane noteId="n1" day="2026-09-01" online onOpenNote={vi.fn()} onChanged={vi.fn()} {...over} />);

it("shows the note's own slider (no dialog), on the end of the row's day", async () => {
  pane();
  expect(await screen.findByText("First text")).toBeVisible();
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "0");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("opens the note itself from the button at the top", async () => {
  const onOpenNote = vi.fn();
  pane({ onOpenNote });
  fireEvent.click(await screen.findByRole("button", { name: "Open note" }));
  expect(onOpenNote).toHaveBeenCalledExactlyOnceWith("n1");
});

it("reads the body first when the list only has the slim row", async () => {
  resetAppState({ data: { ...noWorkspaceData, nodes: [{ ...note, markdown: "", body_len: 8 }] }, online: true });
  pane();
  expect(screen.getByText("Loading…")).toBeVisible();
  expect(h.hydrate).toHaveBeenCalledWith("n1");
});

it("says so when the note is not in this device's list", () => {
  pane({ noteId: "gone" });
  expect(screen.getByText("This note's text is not available here yet.")).toBeVisible();
});
