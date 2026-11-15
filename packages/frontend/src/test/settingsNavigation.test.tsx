// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The widgets that load from the server are stand-ins: this file is about the
// settings shell (the list, search, advanced settings, titles).
// The account row reads the session; the real better-auth store cleans up a
// second after its last subscriber leaves, after this file and its window are gone.
vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }) } }));
vi.mock("../settings/spacesAndMembers", () => ({ default: () => <div>spaces widget</div> }));
vi.mock("../settings/ModulesSetting", () => ({ default: () => <div>modules widget</div> }));

import SettingsModal from "../settings/SettingsModal";
import { resetAppState, setAppState } from "../lib/appStore";
import { matchShortcut, resetShortcuts, shortcutById } from "../lib/shortcuts";

function open(online = true) {
  render(<SettingsModal online={online} onClose={vi.fn()} onImportDone={vi.fn()} onConnect={vi.fn()} />);
  return userEvent.setup();
}

beforeEach(() => { localStorage.clear(); resetShortcuts(); resetAppState(); });

function withModules(modules: string[]) {
  setAppState((s) => ({ data: { ...s.data, actor_role: "admin", actor_is_owner: true, workspace: { ...s.data.workspace, modules } } }));
}

/** The list's rows by tab id, in the blocks the list draws. */
const blocks = () => Array.from(document.querySelectorAll<HTMLElement>(".settings-sidebar [data-block]"))
  .map((block) => Array.from(block.querySelectorAll<HTMLElement>("[data-tab]")).map((row) => row.dataset.tab));
const row = (tab: string) => document.querySelector<HTMLElement>(`.settings-sidebar [data-tab="${tab}"]`)!;

describe("settings shell", () => {
  it("switching tabs leaves none of the previous tab's rows behind", async () => {
    // Appearance groups theme.* · note.* · theme.reduce_motion: the theme
    // prefix comes back, and two sections under one React key stayed on
    // screen after leaving the tab (seen on 伺服器 2026-10-26).
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = open();
    for (let i = 0; i < 3; i++) {
      await user.click(row("appearance"));
      expect(screen.getAllByRole("radiogroup", { name: "Theme" })).toHaveLength(1);
      await user.click(row("account"));
      expect(screen.queryByRole("radiogroup", { name: "Theme" })).toBeNull();
    }
    expect(err.mock.calls.filter((c) => String(c[0]).includes("same key"))).toEqual([]);
    err.mockRestore();
  });

  it("lists the pages in five unnamed blocks, with no danger zone and no group names", () => {
    open();
    expect(blocks()).toEqual([
      ["account"],
      ["appearance", "notes", "capture", "handwriting", "navigation", "notifications", "shortcuts"],
      ["spaces", "modules"],
      ["language", "time"],
      ["data", "about"],
    ]);
    for (const old of ["This device", "Your account", "Workspace", "Features", "Data & system", "Danger zone"]) {
      expect(screen.queryByRole("group", { name: old })).toBeNull();
    }
    expect(screen.queryByRole("button", { name: "Danger zone" })).toBeNull();
    expect(screen.queryByText(/other devices and people are not affected/i)).toBeNull();
    expect(screen.queryByText(/shared by everyone in this workspace/i)).toBeNull();
    // No collapsing on the desktop: every row showing.
    expect(document.querySelector(".settings-nav-group [aria-expanded]")).toBeNull();
  });

  it("marks only the pages kept on this device with the small phone icon", () => {
    open();
    const marked = Array.from(document.querySelectorAll<HTMLElement>(".settings-sidebar [data-tab]"))
      .filter((r) => within(r).queryByRole("img", { name: "Only on this device" }))
      .map((r) => r.dataset.tab);
    expect(marked).toEqual(["appearance", "notes", "notifications", "language"]);
  });

  it("shows each page's current value at the right of its row, and follows a change made on the page", async () => {
    withModules(["rss", "daily"]);
    setAppState((s) => ({ data: { ...s.data, workspace: { ...s.data.workspace, time_zone: "Asia/Taipei", day_start_hour: 4 } } }));
    const user = open();
    expect(within(row("language")).getByText("System")).toBeInTheDocument();
    expect(within(row("appearance")).getByText(/^System · /)).toBeInTheDocument();
    expect(within(row("notes")).getByText("Serif · Standard")).toBeInTheDocument();
    expect(within(row("time")).getByText(/4/)).toBeInTheDocument();
    expect(within(row("modules")).getByText(/^\d+ of \d+ on$/)).toBeInTheDocument();
    await user.click(row("language"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Language" }), "en");
    expect(within(row("language")).getByText("English")).toBeInTheDocument();
    await user.click(row("notes"));
    await user.click(await screen.findByRole("radio", { name: "Kai (brush)" }));
    expect(within(row("notes")).getByText("Kai (brush) · Standard")).toBeInTheDocument();
  });

  it("search finds settings across pages by label, keyword and option, advanced ones included", async () => {
    const user = open();
    const search = screen.getByRole("searchbox", { name: "Search settings…" });
    await user.type(search, "dark");
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "成員");
    expect(screen.getByText("spaces widget")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "sqlite");
    expect(screen.getByRole("group", { name: "Download this device's copy" })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "no such setting");
    expect(screen.getByText(/no settings match/i)).toBeInTheDocument();
  });

  it("a search result's page name opens that page", async () => {
    const user = open();
    await user.type(screen.getByRole("searchbox", { name: "Search settings…" }), "text size");
    const results = document.querySelector<HTMLElement>(".settings-content")!;
    await user.click(within(results).getByRole("button", { name: "Notes" }));
    expect(screen.getByRole("searchbox", { name: "Search settings…" })).toHaveValue("");
    expect(screen.getByRole("slider", { name: "Text size" })).toBeInTheDocument();
  });

  it("folds the backend URL under advanced settings while connected, and shows it when not", async () => {
    let user = open(true);
    await user.click(row("account"));
    expect(screen.queryByRole("textbox", { name: "Server address" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show advanced settings" }));
    expect(screen.getByRole("textbox", { name: "Server address" })).toBeInTheDocument();
    cleanup();
    user = open(false);
    await user.click(row("account"));
    expect(screen.getByRole("textbox", { name: "Server address" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show advanced settings" })).toBeNull();
  });

  it("offline, the Account page says the device can't reach the server, and the empty URL field shows this site", async () => {
    let user = open(true);
    await user.click(row("account"));
    expect(screen.queryByText(/can't reach the server/)).toBeNull();
    cleanup();
    user = open(false);
    await user.click(row("account"));
    expect(screen.getByText(/This device can't reach the server/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Server address" })).toHaveAttribute("placeholder", window.location.origin);
  });

  it("opens an imported feature's page from the Features row's list, not from the settings list", async () => {
    withModules(["rss"]);
    const user = open();
    // The list has no second 「功能」 group and no feature rows of its own.
    expect(within(row("modules")).queryByText("Reading")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reading" })).toBeNull();
    await user.click(row("modules"));
    expect(screen.getByText("modules widget")).toBeInTheDocument();
  });

  it("the old Writing page is gone: its toolbar is under Notes, the pen under Features and the shortcuts have their own page", async () => {
    const user = open();
    expect(screen.queryByRole("button", { name: "Writing" })).toBeNull();
    await user.click(row("notes"));
    expect(screen.getByRole("heading", { name: "Toolbar" })).toBeInTheDocument();
    expect(screen.queryByText("Turn a held stroke into a shape")).toBeNull();
    await user.click(row("shortcuts"));
    expect(screen.getByRole("button", { name: "Change “Focus search”" })).toBeInTheDocument();
  });

  it("changes a shortcut on this device, refuses one that is taken, and resets it", async () => {
    const user = open();
    await user.click(row("shortcuts"));
    await user.click(screen.getByRole("button", { name: "Change “Focus search”" }));
    expect(screen.getByText("Press keys…")).toBeInTheDocument();
    // ⌘K is the command palette's: refused, and the shortcut stays as it was.
    await user.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("alert")).toHaveTextContent(/already “Open command palette”/);
    expect(shortcutById("focus-search")!.chord).toBe("$mod+f");
    // ⌘B is bold in the editor, `c` picks the card tool on a board: refused too.
    await user.keyboard("{Control>}b{/Control}");
    expect(screen.getByRole("alert")).toHaveTextContent(/text editor's own key/);
    await user.keyboard("c");
    expect(screen.getByRole("alert")).toHaveTextContent(/picks a whiteboard tool/);
    expect(shortcutById("focus-search")!.chord).toBe("$mod+f");
    await user.keyboard("{Control>}{Shift>}f{/Shift}{/Control}");
    expect(shortcutById("focus-search")!.chord).toBe("$mod+shift+f");
    const press = (init: KeyboardEventInit & { code: string }) => matchShortcut(new KeyboardEvent("keydown", init))?.id;
    expect(press({ code: "KeyF", key: "F", ctrlKey: true, shiftKey: true })).toBe("focus-search");
    expect(press({ code: "KeyF", key: "f", ctrlKey: true })).toBeUndefined();
    expect(JSON.parse(localStorage.getItem("onden.shortcuts")!)).toEqual({ "focus-search": "$mod+shift+f" });
    await user.click(screen.getByRole("button", { name: "Reset “Focus search”" }));
    expect(shortcutById("focus-search")!.chord).toBe("$mod+f");
    expect(localStorage.getItem("onden.shortcuts")).toBeNull();
  });

  it("Escape cancels recording without closing settings or changing the shortcut", async () => {
    const user = open();
    await user.click(row("shortcuts"));
    await user.click(screen.getByRole("button", { name: "Change “Save draft”" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Press keys…")).toBeNull();
    expect(screen.getByRole("button", { name: "Change “Save draft”" })).toBeInTheDocument();
    expect(shortcutById("save-draft")!.chord).toBe("$mod+s");
  });

  it("there is no danger zone page: replacing this device's copy closes the Data page, in red", async () => {
    const user = open();
    await user.click(row("data"));
    await user.click(screen.getByRole("button", { name: "Show advanced settings" }));
    // No trash to empty: deleted notes stay, and come back from History.
    expect(screen.queryByText("Empty the trash")).toBeNull();
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".settings-content [data-setting-id]"));
    const last = rows.at(-1)!;
    expect(last).toHaveAttribute("data-setting-id", "data.backup_restore");
    expect(last).toHaveClass("settings-setting--danger");
    expect(within(last).getByRole("group", { name: "Restore this device's copy" })).toBeInTheDocument();
  });
});
