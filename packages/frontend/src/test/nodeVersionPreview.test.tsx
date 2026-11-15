// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import NoteVersionHistory from "./versionHistoryHarness";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";

const { restore, versionsRead } = vi.hoisted(() => ({ restore: vi.fn(), versionsRead: vi.fn() }));
vi.mock("../hooks/useVersionRestore", () => ({ useVersionRestore: () => ({ restore, restoringVersionId: null, feedback: null }) }));
vi.mock("../lib/accountSession", () => ({ useAccountSession: () => null }));
vi.mock("../lib/data", async (original) => ({ ...await original<typeof import("../lib/data")>(), reads: { notes: { versions: versionsRead, inkEdits: async () => [] } } }));

const node: ContentNode = { id: "a", title: "Note", slug: "a", markdown: "Saved", source_type: "manual", node_type: "content" };
const versions = [4, 3, 2, 1].map((day) => ({
  id: `version-${day}`, title: "Note", markdown: `Body ${day} being reviewed`,
  changed_at: `2026-09-0${day}T00:00:00Z`, actor_name: `Author ${day}`, actor_type: "user", saves: day,
}));
const props = { onSelectNode: vi.fn() };
// The dialog (NoteHistory) and its body preview (OverviewPreview) are
// React.lazy chunks. Their first import transforms and evaluates the lib/data
// and markdown graphs, which takes 1.2–1.5s on a cold run and more under load;
// that exceeded findByRole's 1s wait, so whichever test opened the dialog first
// failed at random. Load both modules once here so each test measures the
// component's behaviour, not module-transform time. The lazy boundaries still
// suspend once on first render, so body text is awaited with findByText.
beforeAll(async () => {
  await Promise.all([import("../components/history"), import("../components/OverviewPreview")]);
});
beforeEach(() => {
  restore.mockReset().mockResolvedValue({ status: "refused", message: "Retry" });
  versionsRead.mockReset().mockImplementation(() => new Promise(() => {}));
  setLocalePref("en");
  resetAppState({ data: { ...noWorkspaceData, nodes: [node] }, selectedId: node.id, overviewDraft: "Unsaved draft", online: true });
});
afterEach(() => { cleanup(); resetAppState(); setLocalePref("system"); });

const slider = () => screen.getByRole("slider");

it("shows only the three latest saves and opens the history screen from one heading action", async () => {
  render(<NoteVersionHistory {...props} node={node} nodeVersions={versions} />);
  expect(screen.getByRole("button", { name: /Author 4 4 saves/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Author 1/ })).toBeNull();
  expect(screen.queryByText("Body 4 being reviewed")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "All versions" }));
  const dialog = await screen.findByRole("dialog");
  // The slider has a stop for each of the four saves, plus the present.
  expect(slider()).toHaveAttribute("aria-valuemax", "4");
  expect(await within(dialog).findByText("Body 4 being reviewed")).toBeVisible();
});

it("opens on the clicked save and keeps that snapshot while the list changes underneath", async () => {
  const { rerender } = render(<NoteVersionHistory {...props} node={node} nodeVersions={versions} />);
  fireEvent.click(screen.getByRole("button", { name: /Author 3 3 saves/ }));
  // The clicked version is captured before the lazy screen has finished loading.
  rerender(<NoteVersionHistory {...props} node={node} nodeVersions={[{ ...versions[0], id: "new", markdown: "New saved body" }]} />);
  const dialog = await screen.findByRole("dialog");
  expect(slider()).toHaveAttribute("aria-valuenow", "2");
  expect(await within(dialog).findByText("Body 3 being reviewed")).toBeVisible();

  rerender(<NoteVersionHistory {...props} node={{ ...node, id: "b" }} nodeVersions={[]} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(<NoteVersionHistory {...props} node={node} nodeVersions={versions} />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("returns focus to the recent-save row and reopens against the refreshed version list", async () => {
  const { rerender } = render(<NoteVersionHistory {...props} node={node} nodeVersions={versions} />);
  const row = screen.getByRole("button", { name: /Author 2 2 saves/ });
  row.focus();
  fireEvent.click(row);
  expect((await screen.findByRole("dialog")).querySelector(".nh")).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(row).toHaveFocus();

  rerender(<NoteVersionHistory {...props} node={node} nodeVersions={[{ ...versions[0], id: "fresh", markdown: "Fresh body" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "All versions" }));
  expect(await screen.findByText("Fresh body")).toBeVisible();
});

it("goes back to the shown version through the shared restore", async () => {
  render(<NoteVersionHistory {...props} node={node} nodeVersions={versions} />);
  fireEvent.click(screen.getByRole("button", { name: /Author 3 3 saves/ }));
  await screen.findByRole("dialog");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Go back to this version" })); });
  expect(restore).toHaveBeenCalledExactlyOnceWith("a", "version-3", { restoreTitle: false });
  expect(screen.getByText("Retry")).toBeVisible();
});

it("does not close a different note's new screen when an older restore finishes", async () => {
  let finish!: (outcome: { status: string; message: string }) => void;
  restore.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { rerender } = render(<NoteVersionHistory {...props} node={node} nodeVersions={versions} />);
  fireEvent.click(screen.getByRole("button", { name: /Author 4 4 saves/ }));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: "Go back to this version" }));
  expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");

  const nextNode = { ...node, id: "b", title: "Next note" };
  rerender(<NoteVersionHistory {...props} node={nextNode} nodeVersions={[{ ...versions[0], id: "b-version", actor_name: "Next author" }]} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Next author/ }));
  await screen.findByRole("dialog");
  await act(async () => { finish({ status: "applied", message: "Restored" }); });
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(screen.getByText("Next note")).toBeVisible();
});
