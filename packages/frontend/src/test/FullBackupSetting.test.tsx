import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RestoreJob, RestorePreview } from "@onden/contract";
import type { SettingContext } from "../lib/settingsTypes";

const api = vi.hoisted(() => ({ historySize: vi.fn(), upload: vi.fn(), preview: vi.fn(), apply: vi.fn(), job: vi.fn(), discard: vi.fn() }));
vi.mock("../lib/data", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/data")>()), backupRestore: api }));
vi.mock("../lib/data/backupLimits", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/data/backupLimits")>()), backupLimits: { restoreLimitBytes: async () => 16 * 1024 ** 3, downloadBytes: async () => null } }));
vi.mock("../lib/spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/spaces")>()),
  useSpaces: () => ({ loaded: true, spaces: [
    { id: "s-shared", name: "Team", kind: "shared", is_default: false, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: true },
    { id: "s-empty", name: "Fresh", kind: "shared", is_default: false, owner_actor_id: null, capabilities: {}, permission: "edit", can_manage: true },
    { id: "s-personal", name: "Me", kind: "personal", is_default: false, owner_actor_id: "me", capabilities: {}, permission: "edit", can_manage: true },
    { id: "s-view", name: "Read only", kind: "shared", is_default: false, owner_actor_id: null, capabilities: {}, permission: "view", can_manage: false },
  ] }),
}));
const confirm = vi.hoisted(() => vi.fn());
vi.mock("../components/ConfirmDialog", () => ({ confirmDialog: confirm }));

import { FullBackupDownload, FullBackupRestore } from "../settings/FullBackupSetting";
import type { RestoreReport } from "@onden/contract";

const ctx: SettingContext = { online: true, onClose: vi.fn(), onImportDone: vi.fn(), onConnect: vi.fn() };

const counts = { notes_new: 3, notes_new_deleted: 1, notes_unchanged: 5, notes_conflict: 1, notes_updated: 0, notes_in_history: 0, notes_new_id: 0, notes_second_copy: 0,
  tasks: 0, tags_existing: 2, tags_new: 1, attachments_new: 2, attachments_existing: 0 };
const movable = vi.hoisted(() => ({ on: false, holds: false, history: null as null | { notes: number; versions: number; bytes: number } }));
const previewFor = (space: string, mode: "empty" | "merge" | "workspace"): RestorePreview => ({
  mode, target: { id: space, name: space === "s-shared" ? "Team" : "Fresh", kind: "shared", notes: space === "s-shared" ? 9 : 0 },
  manifest: { format: "onden-backup", version: 1, created_at: "2026-10-18T10:00:00Z", workspace_id: "w1", created_by: { id: "u1", name: "你" },
    counts: { notes: 9, deleted_notes: 0, tags: 3, tasks: 0, canvases: 0, drawings: 0, attachments: 2, spaces: 2 } },
  new_parent: null, holds_history: movable.holds,
  refusal: mode === "workspace" ? (movable.on ? null : "workspace_not_new") : mode === "empty" && space === "s-shared" ? "target_not_empty" : null,
  move: mode === "workspace" ? {
    spaces: [{ name: "Only me", kind: "personal", notes: 4, had_others: false }, { name: "Lab", kind: "shared", notes: 2, had_others: true }],
    carries: [{ kind: "progress", count: 3 }, { kind: "feeds", count: 1 }, { kind: "settings", count: 2 }, { kind: "site", count: 1 }], clears: { notes: 5, tags: 2 }, history: movable.history, not_moved: [],
  } : null,
  counts, conflicts: [{ id: "n1", title: "Weekly plan" }], title_clashes: [{ id: "n2", title: "Reading list" }],
  new_notes: [{ id: "n3", title: "Ideas", deleted: false }],
});

const report: RestoreReport = { event_id: "9", created: 3, superseded: 0, parent_note_id: null, copies: 1, unchanged: 5, in_history: 0, deleted_again: 1, tags_created: 1, attachments_written: 2, tasks: 1, views: 2,
  skipped: { tags: 0, attributes: 0, links: 0, positions: 0, tag_settings: 0, tag_automation: 0, tasks: 0, views: 0, functions: 0, attachments_too_large: 0, attachments_unreadable: 0, attachments_not_yours: 0 }, moved: null };
const jobOf = (over: Partial<RestoreJob>): RestoreJob => ({
  id: "j-1", upload_id: "u-1", space_id: "s-shared", mode: "merge", status: "running", phase: "notes", done: 0, total: 10,
  event_id: null, error: null, error_status: null, rolled_back: false, result: null, retryable: false, created_at: "2026-10-18T10:00:00Z", updated_at: "2026-10-18T10:00:00Z", ...over,
});

describe("Settings › Your Data › full backup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    movable.on = false;
    movable.history = null;
    movable.holds = false;
    api.historySize.mockResolvedValue({ notes: 0, versions: 0, bytes: 0 });
    api.upload.mockResolvedValue({ upload_id: "u-1", bytes: 10, manifest: { format: "onden-backup", version: 1, created_at: "2026-10-18T10:00:00Z", created_by: { id: "a", name: "Andy" }, counts: {} } });
    api.preview.mockImplementation(async (_id: string, space: string, mode: "empty" | "merge" | "workspace") => previewFor(space, mode));
    api.apply.mockResolvedValue(jobOf({ status: "done", phase: "done", done: 10, event_id: "9", result: report }));
  });

  it("downloads the full backup and says what it leaves out", () => {
    render(<FullBackupDownload ctx={ctx} />);
    const link = within(screen.getByRole("group", { name: "Full backup" })).getByRole("link", { name: "Download" });
    expect(link).toHaveAttribute("href", expect.stringContaining("/api/backup/full.zip"));
    expect(link).toHaveAttribute("download");
    expect(screen.getByText(/other members' private notes/i)).toBeInTheDocument();
  });

  it("offers version history as one switch with its size, on by default, and the download link follows it", async () => {
    const user = userEvent.setup();
    api.historySize.mockResolvedValue({ notes: 12, versions: 340, bytes: 7 * 1024 * 1024 });
    render(<FullBackupDownload ctx={ctx} />);
    const toggle = await screen.findByRole("switch", { name: "Include version history" });
    expect(toggle).toBeChecked();
    expect(screen.getByText(/340 versions, about 7 MB/)).toBeInTheDocument();
    const link = within(screen.getByRole("group", { name: "Full backup" })).getByRole("link", { name: "Download" });
    expect(link).toHaveAttribute("href", expect.stringContaining("/api/backup/full.zip?history=1"));
    await user.click(toggle);
    expect(link.getAttribute("href")).not.toContain("history=1");
    expect(screen.getByText(/other members' private notes, accounts and keys/)).not.toHaveTextContent(/version history/);
  });

  it("starts the switch off when the history is very large, and offers none when there is none", async () => {
    api.historySize.mockResolvedValue({ notes: 900, versions: 90000, bytes: 900 * 1024 * 1024 });
    const { unmount } = render(<FullBackupDownload ctx={ctx} />);
    expect(await screen.findByRole("switch", { name: "Include version history" })).not.toBeChecked();
    unmount();
    api.historySize.mockResolvedValue({ notes: 0, versions: 0, bytes: 0 });
    render(<FullBackupDownload ctx={ctx} />);
    await waitFor(() => expect(api.historySize).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("says what a move does with version history, and what it could not carry", async () => {
    const user = userEvent.setup();
    movable.on = true;
    movable.history = { notes: 4, versions: 31, bytes: 1000 };
    render(<FullBackupRestore ctx={ctx} />);
    await user.upload(screen.getByLabelText(/full backup file/i), new File(["zip"], "b.zip", { type: "application/zip" }));
    await user.click(await screen.findByRole("radio", { name: /Move the whole workspace/ }));
    expect(await screen.findByText("Version history comes along: 31 versions of 4 notes.")).toBeInTheDocument();
    expect(screen.getByText(/Does not come along: the edit log/)).toBeInTheDocument();
    confirm.mockResolvedValue(true);
    api.apply.mockResolvedValue(jobOf({ status: "done", phase: "done", mode: "workspace", done: 10, event_id: "9", result: { ...report, moved: {
      spaces_created: 0, need_reinvite: [], carried: { review: 0, focus: 0, rss: 0, prefs: 0, moduleSettings: 0, modules: false, site: false }, cleared: { notes: 0, tags: 0 },
      not_moved: ["operation_log"], history: { notes: 3, versions: 20, failed: ["Weekly plan", ""] } } } }));
    await user.click(screen.getByRole("button", { name: /^restore$/i }));
    expect(await screen.findByText("Version history came along: 20 versions of 3 notes.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Weekly plan、Untitled");
    expect(screen.getByText(/Not moved: the edit log/)).toBeInTheDocument();
  });

  it("tells an ordinary restore that history in the file stays behind — from what the server counted, not the manifest's claim", async () => {
    const user = userEvent.setup();
    api.upload.mockResolvedValue({ upload_id: "u-1", bytes: 10, manifest: { format: "onden-backup", version: 3, created_at: "2026-10-18T10:00:00Z", history: { notes: 999, versions: 999, bytes: 1 }, counts: {} } });
    render(<FullBackupRestore ctx={ctx} />);
    await user.upload(screen.getByLabelText(/full backup file/i), new File(["zip"], "b.zip", { type: "application/zip" }));
    await screen.findByText("New notes: 3");
    expect(screen.queryByText(/This backup holds version history/)).not.toBeInTheDocument(); // the manifest says so, the files do not
    movable.holds = true;
    api.preview.mockImplementation(async (_id: string, space: string, mode: "empty" | "merge" | "workspace") => previewFor(space, mode));
    await user.upload(screen.getByLabelText(/full backup file/i), new File(["zip"], "c.zip", { type: "application/zip" }));
    expect(await screen.findByText(/This backup holds version history\. It comes back only when you move/)).toBeInTheDocument();
  });

  it("previews a restore — counts, kept-and-copied notes, title clashes — before anything is written", async () => {
    const user = userEvent.setup();
    render(<FullBackupRestore ctx={ctx} />);
    await user.upload(screen.getByLabelText(/full backup file/i), new File(["zip"], "onden-backup-20261018.zip", { type: "application/zip" }));
    await screen.findByText("New notes: 3");
    expect(api.preview).toHaveBeenLastCalledWith("u-1", "s-shared", "merge");
    expect(screen.getByText(/current kept, backup added as a copy: 1/)).toBeInTheDocument();
    expect(screen.getByText("Weekly plan")).toBeInTheDocument();
    expect(screen.getByText("Reading list")).toBeInTheDocument();
    // Only spaces the person manages are offered.
    expect(screen.queryByRole("option", { name: /read only/i })).not.toBeInTheDocument();
    expect(api.apply).not.toHaveBeenCalled();
  });

  it("offers moving the whole workspace only when the server says this workspace is new", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<FullBackupRestore ctx={ctx} />);
    await user.upload(screen.getByLabelText(/full backup file/i), new File(["zip"], "a.zip"));
    await screen.findByText("New notes: 3");
    await waitFor(() => expect(api.preview).toHaveBeenCalledWith("u-1", "s-personal", "workspace"));
    expect(screen.queryByRole("radio", { name: /move the whole workspace/i })).not.toBeInTheDocument();
    unmount();

    movable.on = true;
    render(<FullBackupRestore ctx={ctx} />);
    await user.upload(screen.getByLabelText(/full backup file/i), new File(["zip"], "b.zip"));
    await user.click(await screen.findByRole("radio", { name: /move the whole workspace/i }));
    // The preview lists the spaces that will be made again and what comes along, in words.
    await screen.findByText(/Lab · 2 notes · had other members/);
    expect(screen.getByText(/Review progress: 3/)).toBeInTheDocument();
    expect(screen.getByText(/sample notes and tags here are removed/)).toBeInTheDocument();
    expect(screen.getByText(/Does not come along/)).toBeInTheDocument();
    // It goes into the person's own space; there is no space to pick.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    confirm.mockResolvedValue(true);
    api.apply.mockResolvedValue(jobOf({ status: "done", phase: "done", mode: "workspace", done: 10, event_id: "9", result: { ...report, moved: {
      spaces_created: 1, need_reinvite: ["Lab"], carried: { review: 3, focus: 0, rss: 1, prefs: 2, moduleSettings: 0, modules: false, site: true }, cleared: { notes: 5, tags: 2 }, not_moved: ["history"], history: null } } }));
    await user.click(screen.getByRole("button", { name: /^restore$/i }));
    await waitFor(() => expect(api.apply).toHaveBeenCalledWith("u-1", "s-personal", "workspace"));
    expect(await screen.findByText(/Invite them again: Lab/)).toBeInTheDocument();
    expect(screen.getByText(/Not moved: version history/)).toBeInTheDocument();
  });

  it("an empty-space restore into a space with notes is refused in the preview", async () => {
    const user = userEvent.setup();
    render(<FullBackupRestore ctx={ctx} />);
    await user.upload(screen.getByLabelText(/full backup file/i), new File(["zip"], "b.zip"));
    await screen.findByText("New notes: 3");
    await user.click(screen.getByRole("radio", { name: /restore into an empty space/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already has 9 notes/);
    expect(screen.getByRole("button", { name: /^restore$/i })).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox"), "s-empty");
    await waitFor(() => expect(screen.getByRole("button", { name: /^restore$/i })).toBeEnabled());
    expect(api.preview).toHaveBeenLastCalledWith("u-1", "s-empty", "empty");
  });

  it("restores only after confirming, and reports what happened", async () => {
    const user = userEvent.setup();
    render(<FullBackupRestore ctx={ctx} />);
    await user.upload(screen.getByLabelText(/full backup file/i), new File(["zip"], "b.zip"));
    await screen.findByText("New notes: 3");
    confirm.mockResolvedValueOnce(false);
    await user.click(screen.getByRole("button", { name: /^restore$/i }));
    expect(api.apply).not.toHaveBeenCalled();
    confirm.mockResolvedValueOnce(true);
    await user.click(screen.getByRole("button", { name: /^restore$/i }));
    expect(api.apply).toHaveBeenCalledWith("u-1", "s-shared", "merge");
    const result = await screen.findByRole("status", { name: /restore result/i });
    // Brought back, by kind: notes (tasks are counted apart), tasks, views, tags, attachments, what was already here.
    for (const line of ["Notes added: 3", "Tasks: 1", "Saved views: 2", "Tags: 1", "Attachments: 2", "Notes already here and unchanged: 5"]) expect(result).toHaveTextContent(line);
    expect(result).not.toHaveTextContent("Left out");
    expect(ctx.onImportDone).toHaveBeenCalled();
  });

  it("lists in words what the restore left out, and why", async () => {
    const user = userEvent.setup();
    api.apply.mockResolvedValue(jobOf({ status: "done", phase: "done", done: 10, event_id: "9", result: {
      ...report, skipped: { ...report.skipped, tasks: 2, views: 1, functions: 7, attachments_too_large: 3, attachments_unreadable: 4, attachments_not_yours: 5, tags: 6 },
    } }));
    render(<FullBackupRestore ctx={ctx} />);
    await user.upload(screen.getByLabelText(/full backup file/i), new File(["zip"], "b.zip"));
    await screen.findByText("New notes: 3");
    confirm.mockResolvedValueOnce(true);
    await user.click(screen.getByRole("button", { name: /^restore$/i }));
    const result = await screen.findByRole("status", { name: /restore result/i });
    expect(result).toHaveTextContent("Left out:");
    for (const line of [
      "Tasks left out because the note they belong to is not in this space: 2", "Saved views left out", "Functions that tags provide (with their settings) that were not brought back: 7", "Attachments left out because they are too large: 3",
      "damaged or of a type that is not allowed: 4", "belongs to someone else's upload: 5", "Tags that could not be put back on notes: 6",
    ]) expect(result).toHaveTextContent(line);
    // Counts that are zero are not listed, and nothing on screen is an id or a code.
    expect(result).not.toHaveTextContent("Fields that were refused");
    expect(result.textContent).not.toMatch(/attachments_|skipped|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("follows a running restore with a progress bar until it is done", async () => {
    api.apply.mockResolvedValue(jobOf({ phase: "notes", done: 0, total: 120 }));
    api.job
      .mockResolvedValueOnce(jobOf({ phase: "notes", done: 50, total: 120, event_id: "9" }))
      .mockResolvedValueOnce(jobOf({ status: "done", phase: "done", done: 120, total: 120, event_id: "9", result: report }));
    confirm.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<FullBackupRestore ctx={ctx} />);
    await user.upload(screen.getByLabelText(/full backup file/i), new File(["zip"], "b.zip"));
    await screen.findByText("New notes: 3");
    await user.click(screen.getByRole("button", { name: /^restore$/i }));
    expect(await screen.findByText("Restoring notes: 0 / 120")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /restore progress/i })).toHaveAttribute("max", "120");
    expect(await screen.findByText("Restoring notes: 50 / 120", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(await screen.findByText("Notes added: 3", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(api.job).toHaveBeenCalledWith("j-1");
    expect(ctx.onImportDone).toHaveBeenCalled();
  });

  it("a restore that failed before committing can be tried again; one undone part way cannot", async () => {
    confirm.mockResolvedValue(true);
    api.apply.mockResolvedValueOnce(jobOf({ status: "failed", error: "insufficient_storage", error_status: 507, retryable: true }));
    const user = userEvent.setup();
    render(<FullBackupRestore ctx={ctx} />);
    await user.upload(screen.getByLabelText(/full backup file/i), new File(["zip"], "b.zip"));
    await screen.findByText("New notes: 3");
    await user.click(screen.getByRole("button", { name: /^restore$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/enough room/);
    // The preview stays: same upload, another try.
    api.apply.mockResolvedValueOnce(jobOf({ status: "failed", error: "restore_failed", error_status: 500, event_id: "9", rolled_back: true }));
    await user.click(screen.getByRole("button", { name: /^restore$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/did not finish.*removed.*safe/);
    expect(screen.queryByLabelText(/restore preview/i)).not.toBeInTheDocument();
  });

  it("a failed restore whose upload expired, or that was already done, offers no retry", async () => {
    confirm.mockResolvedValue(true);
    api.apply.mockResolvedValueOnce(jobOf({ status: "failed", error: "interrupted", error_status: 500, retryable: false }));
    const user = userEvent.setup();
    const { unmount } = render(<FullBackupRestore ctx={ctx} />);
    await user.upload(screen.getByLabelText(/full backup file/i), new File(["zip"], "b.zip"));
    await screen.findByText("New notes: 3");
    await user.click(screen.getByRole("button", { name: /^restore$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired; upload it again/);
    expect(screen.queryByLabelText(/restore preview/i)).not.toBeInTheDocument();
    unmount();
    api.apply.mockResolvedValueOnce(jobOf({ status: "failed", error: "already_restored", error_status: 409, retryable: false }));
    render(<FullBackupRestore ctx={ctx} />);
    await user.upload(screen.getByLabelText(/full backup file/i), new File(["zip"], "b.zip"));
    await screen.findByText("New notes: 3");
    await user.click(screen.getByRole("button", { name: /^restore$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already restored/);
    expect(screen.queryByLabelText(/restore preview/i)).not.toBeInTheDocument();
  });

  it("shows why a file was refused and keeps nothing staged", async () => {
    const { ApiError } = await import("../lib/api");
    api.upload.mockRejectedValueOnce(new ApiError(400, JSON.stringify({ error: "unsafe_entry", entry: "../evil.md" })));
    const user = userEvent.setup();
    render(<FullBackupRestore ctx={ctx} />);
    await user.upload(screen.getByLabelText(/full backup file/i), new File(["zip"], "evil.zip"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/points outside it/);
    expect(screen.queryByLabelText(/restore preview/i)).not.toBeInTheDocument();
  });
});
