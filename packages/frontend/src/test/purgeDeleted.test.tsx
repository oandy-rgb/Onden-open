// History › 最近刪除 › 永久刪除 (backend services/nodeTrash.ts purgeDeleted)
// and Settings › Spaces › delete with deleted notes left (services/spaces.ts
// deleteSpace). Who sees the button is the server's space rule
// (lib/capabilities.ts canPurgeDeleted); the confirmation lists what goes and
// needs the note's title typed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkspaceHistory } from "../components/history";
import * as historyApi from "../lib/history/workspaceHistoryApi";
import PurgeDeletedModal from "../components/PurgeDeletedModal";
import SpaceDeleteDialog from "../settings/SpaceDeleteDialog";
import { capabilitiesFor, useCapabilities, type Capabilities } from "../lib/capabilities";
import { api, ApiError } from "../lib/api";
import type { Space } from "../lib/spaces";

vi.mock("../lib/history/workspaceHistoryApi", async (original) => ({
  ...await original<typeof import("../lib/history/workspaceHistoryApi")>(),
  fetchActivity: vi.fn(async () => []), fetchFeed: vi.fn(async () => ({ days: [], earlier_day: null })), fetchDeleted: vi.fn(),
}));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: vi.fn() }));
vi.mock("../lib/capabilities", async (original) => ({
  ...await original<typeof import("../lib/capabilities")>(), useCapabilities: vi.fn(),
}));

const space = (id: string, kind: Space["kind"], role: "viewer" | "editor" | "manager"): Space => ({
  id, name: id, kind, is_default: false, owner_actor_id: null, capabilities: {},
  permission: role === "viewer" ? "view" : "edit", can_manage: role === "manager",
});

const deleted = (id: string, title: string, spaceId: string | null, blank = false) => ({
  id, title, deleted_at: "2026-10-18T09:00:00Z", space_id: spaceId, blank,
});

/** History opens on 變更; these tests are about the 最近刪除 tab. */
async function renderDeletedTab() {
  render(<WorkspaceHistory online onOpenNote={vi.fn()} />);
  fireEvent.click(await screen.findByRole("tab", { name: "Recently deleted" }));
}

const PREVIEW = {
  node: { id: "n1", title: "Old plan" },
  subtree: [{ id: "c1", title: "Old child" }],
  tasks: 2,
  live_descendants: [],
  media: { images: 3, files: 1, kept: 1 },
  versions: 5,
  attributes: 4,
  ids: ["n1", "c1", "t1", "t2"],
};

/** The write the data layer sent to `path` (lib/data sends through api()). */
const written = (path: string) => {
  const call = vi.mocked(api).mock.calls.find(([p, init]) => p === path && init?.method && init.method !== "GET");
  return call ? { method: call[1]!.method, body: JSON.parse(String(call[1]!.body)) } : undefined;
};

beforeEach(() => {
  localStorage.clear();
  vi.mocked(api).mockReset();
  // History reads the space list for its filter menu; these tests are not about it.
  vi.mocked(api).mockImplementation(async (path) => (String(path).startsWith("/api/spaces") ? { spaces: [] } : undefined));
  vi.mocked(useCapabilities).mockReset();
});

describe("who may delete for good (capabilities, the server's space rule)", () => {
  it("a manager of the note's space, or the owner in a shared space; never editors, viewers or unknown spaces", () => {
    const spaces = [space("lab", "shared", "manager"), space("team", "shared", "editor"),
      space("read", "shared", "viewer"), space("mine", "personal", "manager")];
    const member = capabilitiesFor(false, spaces, true);
    expect(member.canPurgeDeleted("lab")).toBe(true);
    expect(member.canPurgeDeleted("mine")).toBe(true);
    expect(member.canPurgeDeleted("team")).toBe(false);
    expect(member.canPurgeDeleted("read")).toBe(false);
    expect(member.canPurgeDeleted("elsewhere")).toBe(false);
    expect(member.canPurgeDeleted(null)).toBe(false);
    // The server marks a shared space can_manage for the owner, never someone's personal one.
    const owner = capabilitiesFor(true, [{ ...space("team", "shared", "viewer"), can_manage: true }, space("theirs", "personal", "viewer")], true);
    expect(owner.canPurgeDeleted("team")).toBe(true);
    expect(owner.canPurgeDeleted("theirs")).toBe(false); // never in someone's personal space
    expect(capabilitiesFor(true, spaces, false).canPurgeDeleted("lab")).toBe(false); // spaces not loaded: no
  });

  it("History shows 永久刪除 only on the deleted notes the person may delete", async () => {
    const caps = capabilitiesFor(false, [space("lab", "shared", "manager"), space("team", "shared", "editor")], true);
    vi.mocked(useCapabilities).mockReturnValue(caps as Capabilities);
    vi.mocked(historyApi.fetchDeleted).mockResolvedValue({ notes: [deleted("n-lab", "Lab note", "lab"), deleted("n-team", "Team note", "team")], older_cursor: null });
    await renderDeletedTab();
    const lab = (await screen.findByText("Lab note")).closest("li")!;
    const team = screen.getByText("Team note").closest("li")!;
    expect(within(lab).getByRole("button", { name: /Delete for good/ })).toBeInTheDocument();
    expect(within(team).queryByRole("button", { name: /Delete for good/ })).toBeNull();
  });

  it("an editor or viewer sees no 永久刪除 at all", async () => {
    vi.mocked(useCapabilities).mockReturnValue(capabilitiesFor(false, [space("lab", "shared", "editor")], true) as Capabilities);
    vi.mocked(historyApi.fetchDeleted).mockResolvedValue({ notes: [deleted("n-lab", "Lab note", "lab")], older_cursor: null });
    await renderDeletedTab();
    expect(await screen.findByText("Lab note")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete for good/ })).toBeNull();
  });
});

describe("全部永久刪除 for the blank notes", () => {
  const blankNotes = (...ids: Array<[string, string]>) => ids.map(([id, spaceId]) => deleted(id, "", spaceId, true));
  const manager = () => vi.mocked(useCapabilities).mockReturnValue(
    capabilitiesFor(false, [space("lab", "shared", "manager"), space("team", "shared", "editor")], true) as Capabilities);

  it("counts only the blank notes the person may delete for good, and says how many stay", async () => {
    manager();
    vi.mocked(historyApi.fetchDeleted).mockResolvedValue({ notes: blankNotes(["b1", "lab"], ["b2", "lab"], ["b3", "team"]), older_cursor: null });
    await renderDeletedTab();
    expect(await screen.findByRole("button", { name: "3 blank notes" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete all for good" }));
    const dialog = await screen.findByTestId("purge-blank-dialog");
    expect(within(dialog).getByText("Delete 2 blank notes for good?")).toBeInTheDocument();
    expect(within(dialog).getByText("1 more you can't delete for good stay in the list.")).toBeInTheDocument();
    expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method && init.method !== "GET")).toEqual([]);   // no write until it is confirmed
  });

  it("is not offered when none of them may be deleted for good", async () => {
    vi.mocked(useCapabilities).mockReturnValue(capabilitiesFor(false, [space("team", "shared", "editor")], true) as Capabilities);
    vi.mocked(historyApi.fetchDeleted).mockResolvedValue({ notes: blankNotes(["b1", "team"]), older_cursor: null });
    await renderDeletedTab();
    await screen.findByRole("button", { name: "1 blank notes" });
    expect(screen.queryByRole("button", { name: "Delete all for good" })).toBeNull();
    expect(screen.getByRole("button", { name: "Bring back all" })).toBeInTheDocument();
  });

  it("sends each note's own id as what to expect, and reports what was and was not deleted", async () => {
    manager();
    vi.mocked(historyApi.fetchDeleted).mockResolvedValue({ notes: blankNotes(["b1", "lab"], ["b2", "lab"], ["b3", "lab"]), older_cursor: null });
    vi.mocked(api).mockResolvedValue({ results: [
      { node_id: "b1", purged: true, media_removed: 0 },
      { node_id: "b2", purged: false, code: "not_found" },     // already gone: as asked
      { node_id: "b3", purged: false, code: "plan_changed" },
    ] });
    vi.mocked(historyApi.fetchDeleted).mockClear();
    await renderDeletedTab();
    fireEvent.click(await screen.findByRole("button", { name: "Delete all for good" }));
    const dialog = await screen.findByTestId("purge-blank-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete 3 for good" }));
    expect(await screen.findByText("Deleted 2 blank notes for good, 1 could not be deleted")).toBeInTheDocument();
    expect(screen.queryByTestId("purge-blank-dialog")).toBeNull();
    expect(written("/api/history/deleted/purge")).toEqual({ method: "POST", body: { items: [
      { node_id: "b1", expected_ids: ["b1"] }, { node_id: "b2", expected_ids: ["b2"] }, { node_id: "b3", expected_ids: ["b3"] },
    ] } });
    // The list is read again on the render after the notice (useLoad's effect), not in the same tick.
    await waitFor(() => expect(vi.mocked(historyApi.fetchDeleted)).toHaveBeenCalledTimes(2));
  });

  it("splits a long list into requests the server accepts", async () => {
    manager();
    const ids = Array.from({ length: 205 }, (_, i) => `b${i}`);
    vi.mocked(historyApi.fetchDeleted).mockResolvedValue({ notes: blankNotes(...ids.map((id): [string, string] => [id, "lab"])), older_cursor: null });
    vi.mocked(api).mockImplementation(async (_path, init) => ({
      results: JSON.parse(String(init?.body)).items.map((i: { node_id: string }) => ({ node_id: i.node_id, purged: true, media_removed: 0 })),
    }));
    await renderDeletedTab();
    fireEvent.click(await screen.findByRole("button", { name: "Delete all for good" }));
    fireEvent.click(within(await screen.findByTestId("purge-blank-dialog")).getByRole("button", { name: "Delete 205 for good" }));
    expect(await screen.findByText("Deleted 205 blank notes for good")).toBeInTheDocument();
    const sent = vi.mocked(api).mock.calls.filter(([p]) => p === "/api/history/deleted/purge").map(([, init]) => JSON.parse(String(init!.body)).items.length);
    expect(sent).toEqual([200, 5]);
  });

  it("keeps the confirmation open with a plain message when the request fails, and cancel sends nothing", async () => {
    manager();
    vi.mocked(historyApi.fetchDeleted).mockResolvedValue({ notes: blankNotes(["b1", "lab"]), older_cursor: null });
    vi.mocked(api).mockRejectedValue(new ApiError(500, "boom"));
    await renderDeletedTab();
    fireEvent.click(await screen.findByRole("button", { name: "Delete all for good" }));
    const dialog = await screen.findByTestId("purge-blank-dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete 1 for good" }));
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).toBeNull();
    expect(screen.getByTestId("purge-blank-dialog")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("purge-blank-dialog")).toBeNull();
  });
});

describe("the 永久刪除 confirmation", () => {
  it("lists what goes, says it cannot be undone, and needs the title typed", async () => {
    vi.mocked(api).mockResolvedValue(PREVIEW);
    const onPurged = vi.fn();
    render(<PurgeDeletedModal nodeId="n1" onClose={vi.fn()} onPurged={onPurged} />);
    const dialog = await screen.findByTestId("purge-dialog");
    expect(await within(dialog).findByText("Delete “Old plan” for good?")).toBeInTheDocument();
    expect(vi.mocked(api).mock.calls[0]![0]).toBe("/api/nodes/n1/purge-preview");
    expect(within(dialog).getByText(/cannot be undone from History/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Copies can stay in backups for a while/)).toBeInTheDocument();
    expect(within(dialog).getByText("1 note under it:")).toBeInTheDocument();
    expect(within(dialog).getByText("Old child")).toBeInTheDocument();
    const counts = within(dialog).getByTestId("purge-counts");
    for (const line of ["2 checklist items", "3 images used only here", "1 attached file used only here",
      "5 saved versions", "4 field values"]) expect(within(counts).getByText(line)).toBeInTheDocument();
    expect(within(dialog).getByText("1 file another note still uses stays.")).toBeInTheDocument();

    const confirm = within(dialog).getByRole("button", { name: "Delete for good" });
    expect(confirm).toBeDisabled();
    const input = within(dialog).getByLabelText("Type “Old plan” to confirm");
    fireEvent.change(input, { target: { value: "Old pla" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: "Old plan" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(onPurged).toHaveBeenCalled());
    expect(written("/api/nodes/n1/purge")).toEqual({ method: "POST", body: { expected_ids: ["n1", "c1", "t1", "t2"] } });
  });

  it("refuses, with the reason, while a note under it is live", async () => {
    vi.mocked(api).mockResolvedValue({ ...PREVIEW, live_descendants: [{ id: "x", title: "Still here" }] });
    render(<PurgeDeletedModal nodeId="n1" onClose={vi.fn()} onPurged={vi.fn()} />);
    const dialog = await screen.findByTestId("purge-dialog");
    expect(await within(dialog).findByText("Still here")).toBeInTheDocument();
    expect(within(dialog).getByText(/is not deleted, so it cannot be deleted for good/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Delete for good" })).toBeNull();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
  });
});

describe("deleting a shared space that holds deleted notes", () => {
  const lab = space("lab", "shared", "manager");

  it("lists them and offers 搬到我的個人空間 and 一起永久刪除", async () => {
    vi.mocked(api).mockResolvedValue({
      live_notes: 0, subscriptions: 0, deleted_count: 2, deleted_ids: ["a", "b"], can_move_to_personal: true,
      deleted_notes: [{ id: "a", title: "Old minutes" }, { id: "b", title: "Old draft" }],
    });
    const onClose = vi.fn();
    render(<SpaceDeleteDialog space={lab} onClose={onClose} />);
    const dialog = await screen.findByTestId("space-delete-dialog");
    expect(await within(dialog).findByText("Old minutes")).toBeInTheDocument();
    const remove = within(dialog).getByRole("button", { name: "Delete space" });
    expect(remove).toBeDisabled(); // a choice is needed
    fireEvent.click(within(dialog).getByRole("radio", { name: /Delete them for good too/ }));
    expect(remove).toBeDisabled(); // and, for 永久刪除, the space's name
    fireEvent.change(within(dialog).getByLabelText("Type “lab” to confirm"), { target: { value: "lab" } });
    expect(remove).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("radio", { name: /Move them to my personal space/ }));
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(written("/api/spaces/lab")).toEqual({ method: "DELETE", body: { deleted_notes: "move" } });
  });

  it("一起永久刪除 sends the ids it showed and warns that backups keep copies for a while", async () => {
    vi.mocked(api).mockResolvedValue({
      live_notes: 0, subscriptions: 0, deleted_count: 2, deleted_ids: ["a", "b"], can_move_to_personal: false,
      deleted_notes: [{ id: "a", title: "Old minutes" }, { id: "b", title: "Old draft" }],
    });
    const onClose = vi.fn();
    render(<SpaceDeleteDialog space={lab} onClose={onClose} />);
    const dialog = await screen.findByTestId("space-delete-dialog");
    fireEvent.click(await within(dialog).findByRole("radio", { name: /Delete them for good too/ }));
    expect(within(dialog).getByText(/Copies can stay in backups for a while/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Type “lab” to confirm"), { target: { value: "lab" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete space" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(written("/api/spaces/lab")).toEqual({ method: "DELETE", body: { deleted_notes: "purge", expected_deleted_ids: ["a", "b"] } });
  });

  it("live notes still block it", async () => {
    vi.mocked(api).mockResolvedValue({ live_notes: 3, subscriptions: 0, deleted_count: 1, deleted_ids: ["x"], can_move_to_personal: true, deleted_notes: [] });
    render(<SpaceDeleteDialog space={lab} onClose={vi.fn()} />);
    const dialog = await screen.findByTestId("space-delete-dialog");
    expect(await within(dialog).findByText(/still has 3 note\(s\) that are not deleted/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Delete space" })).toBeNull();
  });

  it("subscriptions block it too, and say how many", async () => {
    vi.mocked(api).mockResolvedValue({ live_notes: 0, subscriptions: 2, deleted_count: 0, deleted_ids: [], can_move_to_personal: true, deleted_notes: [] });
    render(<SpaceDeleteDialog space={lab} onClose={vi.fn()} />);
    const dialog = await screen.findByTestId("space-delete-dialog");
    expect(await within(dialog).findByText(/still has 2 subscription\(s\)/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Delete space" })).toBeNull();
  });
});
