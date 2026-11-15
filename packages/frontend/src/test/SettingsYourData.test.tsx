// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { bindAccountStorage } from "../lib/accountStorage";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// The real better-auth session store schedules its cleanup a second after the
// last unmount and touches `window` then; with the test file already torn down
// that surfaced as unhandled "window is not defined" errors. No test here needs a session.
vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }), signOut: vi.fn(), getSession: vi.fn() } }));
vi.mock("../lib/fileSystemStorage", async (original) => ({ ...await original<typeof import("../lib/fileSystemStorage")>(), isFileSystemAccessSupported: () => true }));
import SettingsModal from "../settings/SettingsModal";
import { TABS } from "../settings/registry";

// The "Your Data" tab: one line per thing, one primary button. Export, backup,
// restore, import and storage location each keep a visible row here.

function renderModal(online = false) {
  return render(
    <SettingsModal
      online={online}
      onClose={vi.fn()}
      onImportDone={vi.fn()}
      onConnect={vi.fn()}
    />,
  );
}

async function openYourData() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /data and backup/i }));
  return user;
}

describe("Settings → Your Data tab", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("registers a first-class 'Data and backup' tab", () => {
    expect(TABS.some((t) => t.id === "data" && /data and backup/i.test(t.label))).toBe(true);
  });

  it("has no lede sentence above its rows", async () => {
    renderModal();
    await openYourData();
    expect(screen.queryByText("Your notes are plain Markdown, yours to take anywhere.")).toBeNull();
  });

  it("exports Markdown from a row of its own, pointing at the markdown.zip export", async () => {
    renderModal();
    await openYourData();
    const exportLink = within(screen.getByRole("group", { name: "Export as Markdown" })).getByRole("link", { name: "Export" });
    expect(exportLink).toHaveAttribute("href", expect.stringContaining("/api/export/markdown.zip"));
    expect(exportLink).toHaveAttribute("download");
  });

  it("downloads the full backup from its row", async () => {
    renderModal();
    await openYourData();
    const link = within(screen.getByRole("group", { name: "Full backup" })).getByRole("link", { name: "Download" });
    expect(link).toHaveAttribute("href", expect.stringContaining("/api/backup/full.zip"));
  });

  it("has exactly one primary button: downloading the full backup", async () => {
    const { baseElement } = renderModal();
    const user = await openYourData();
    await user.click(screen.getByRole("button", { name: /show advanced settings/i }));
    const primary = [...baseElement.querySelectorAll(".settings-content .ui-btn--primary")];
    expect(primary).toHaveLength(1);
    expect(primary[0]).toHaveTextContent("Download");
    expect(within(screen.getByRole("group", { name: "Full backup" })).getByRole("link", { name: "Download" })).toBe(primary[0]);
  });

  it("never repeats a section heading or row title, and the two folder buttons say different things", async () => {
    const { baseElement } = renderModal();
    const user = await openYourData();
    await user.click(screen.getByRole("button", { name: /show advanced settings/i }));
    const content = baseElement.querySelector(".settings-content")!;
    const sections = [...content.querySelectorAll(".settings-section-title")].map((el) => el.textContent);
    expect(sections).toEqual(["Backup and export", "Import", "On this device"]);
    // The folder-import row is a lazy chunk (modules/importers): wait for it, or this
    // sees 7 rows whenever it is the first test in the file to need the chunk.
    await waitFor(() => expect(content.querySelectorAll(".settings-data-row-title")).toHaveLength(8));
    const titles = [...content.querySelectorAll(".settings-data-row-title")].map((el) => el.textContent);
    expect(new Set([...titles, ...sections]).size).toBe(titles.length + sections.length);
    const folderButtons = screen.getAllByRole("button", { name: /folder/i }).map((el) => el.textContent);
    expect(new Set(folderButtons).size).toBe(folderButtons.length);
    expect(folderButtons).toEqual(expect.arrayContaining(["Choose folder…", "Keep a copy in a folder…"]));
  });

  it("keeps the device copy and the tag pack file under advanced settings, with no starter-pack install rows", async () => {
    renderModal();
    const user = await openYourData();
    expect(screen.queryByRole("group", { name: "Download this device's copy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Import a tag pack" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /show advanced settings/i }));
    expect(within(screen.getByRole("group", { name: "Download this device's copy" })).getByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Restore this device's copy" })).getByRole("button", { name: "Choose file…" })).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Import a tag pack" })).getByRole("button", { name: "Choose file…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
    expect(screen.queryByText("Books")).not.toBeInTheDocument();
  });

  it("says where the notes are kept: on this device when offline", async () => {
    renderModal(false);
    await openYourData();
    expect(screen.getByText("On this device: This browser")).toBeInTheDocument();
  });

  it("connected, says the notes are on the server and this device keeps a copy", async () => {
    renderModal(true);
    await openYourData();
    expect(screen.getByText("On the server. This device's copy: This browser")).toBeInTheDocument();
    expect(screen.getByText(/your notes stay on the server/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Export" })).toBeInTheDocument();
  });

  it.each([["backup"], ["tag pack"], ["sqlite"], ["restore"], ["Obsidian"], ["folder"]])("settings search for “%s” finds the matching row", async (query) => {
    renderModal();
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Search settings…" }), query);
    const titles = () => [...document.querySelectorAll(".settings-data-row-title")].map((el) => el.textContent);
    const expected: Record<string, string> = {
      backup: "Full backup", "tag pack": "Import a tag pack", sqlite: "Download this device's copy",
      restore: "Restore from a backup", Obsidian: "Import a folder", folder: "Import a folder",
    };
    // The folder import loads when shown (modules/importers).
    await waitFor(() => expect(titles()).toContain(expected[query]));
  });

  it.each([["備份"], ["標籤包"]])("settings search in Chinese for “%s” finds a row", async (query) => {
    renderModal();
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Search settings…" }), query);
    expect(document.querySelectorAll(".settings-data-row-title").length).toBeGreaterThan(0);
  });
});

beforeEach(() => { bindAccountStorage("unit-test-account", ""); });
