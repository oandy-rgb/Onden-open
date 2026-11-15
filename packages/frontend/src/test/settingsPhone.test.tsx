import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { installFakeCloseWatcher, liveWatchers, requestClose } from "./fakeCloseWatcher";

// Settings on the phone: a full-screen category list (level 1), then one
// category with a back button (level 2). The desktop shell is covered by
// settingsNavigation.test.tsx.
vi.mock("../settings/spacesAndMembers", () => ({ default: () => <div>spaces widget</div> }));
vi.mock("../settings/ModulesSetting", () => ({ default: () => <div>modules widget</div> }));

import SettingsModal from "../settings/SettingsModal";
import { resetAppState, setAppState } from "../lib/appStore";
import { resetShortcuts } from "../lib/shortcuts";
import { MOBILE_QUERY } from "../hooks/useIsMobile";
import type { SettingsTab } from "../lib/settingsTab";

const realMatchMedia = window.matchMedia;

function setPhone(phone: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: phone && query === MOBILE_QUERY,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function open(initialTab?: SettingsTab) {
  render(<SettingsModal online onClose={vi.fn()} onImportDone={vi.fn()} onConnect={vi.fn()} initialTab={initialTab} />);
  return userEvent.setup();
}

// The rows of the list, by tab id, in the blocks it draws.
const blocks = () => Array.from(document.querySelectorAll<HTMLElement>(".settings-phone-scroll [data-block]"))
  .map((block) => Array.from(block.querySelectorAll<HTMLElement>("[data-tab]")).map((row) => row.dataset.tab));
const rowOf = (tab: string) => document.querySelector<HTMLElement>(`.settings-phone-scroll [data-tab="${tab}"]`)!;
const asOwner = (modules: string[] = []) => setAppState((s) => ({ data: { ...s.data, actor_role: "admin", actor_is_owner: true, workspace: { ...s.data.workspace, modules } } }));
const backButton = () => screen.getByRole("button", { name: "Back to Settings" });

beforeEach(() => { localStorage.clear(); resetShortcuts(); resetAppState(); setPhone(true); });
afterEach(() => { window.matchMedia = realMatchMedia; });

describe("settings on the phone", () => {
  it("lists the pages in five unnamed blocks as rows, with values and no keyboard shortcuts", () => {
    asOwner();
    open();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(document.querySelector(".settings-sidebar, .settings-nav-item")).toBeNull();
    expect(blocks()).toEqual([["account"], ["appearance", "notes", "capture", "handwriting", "navigation", "notifications"], ["spaces", "ai", "modules"], ["language", "time"], ["data", "about"]]);
    // No group headers to open or close, and no danger zone.
    expect(document.querySelector("[aria-expanded]")).toBeNull();
    expect(screen.queryByRole("button", { name: /danger zone/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /keyboard shortcuts/i })).toBeNull();
    // The right-hand value of a row.
    expect(within(rowOf("language")).getByText("System")).toBeInTheDocument();
    expect(within(rowOf("notes")).getByText("Serif · Standard")).toBeInTheDocument();
    // Only what is kept on this device carries the phone mark.
    const marked = Array.from(document.querySelectorAll<HTMLElement>("[data-tab]")).filter((r) => within(r).queryByRole("img", { name: "Only on this device" })).map((r) => r.dataset.tab);
    expect(marked).toEqual(["appearance", "notes", "notifications", "language"]);
    // Nothing of a page shows until one is opened.
    expect(screen.queryByRole("combobox", { name: "Language" })).toBeNull();
  });

  it("the notes page has the toolbar and no keyboard shortcuts on the phone", async () => {
    setAppState((s) => ({ data: { ...s.data, actor_role: "editor", actor_is_owner: false } }));
    const user = open();
    expect(blocks().flat()).toContain("about");
    await user.click(rowOf("notes"));
    expect(screen.getByRole("heading", { name: "Toolbar" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("a member's list has no AI page, and a link to it opens the first page instead; the owner has it", () => {
    setAppState((s) => ({ data: { ...s.data, actor_role: "editor", actor_is_owner: false } }));
    open("ai");
    expect(document.querySelector('.settings-phone-scroll [data-tab="ai"]')).toBeNull();
    cleanup();
    resetAppState();
    asOwner();
    open();
    expect(rowOf("ai")).not.toBeNull();
  });

  it("a member does not find the owner's failed jobs, by search or on the About page", async () => {
    setAppState((s) => ({ data: { ...s.data, actor_role: "editor", actor_is_owner: false } }));
    const user = open();
    await user.type(screen.getByRole("searchbox", { name: "Search settings…" }), "failed");
    expect(screen.queryByText("Failed background jobs")).toBeNull();
  });

  it("search lists matching settings and opens a page scrolled to the one tapped", async () => {
    const scroll = vi.fn();
    const proto = Element.prototype as unknown as { scrollIntoView?: () => void };
    const before = proto.scrollIntoView;
    proto.scrollIntoView = scroll;
    try {
      const user = open();
      await user.type(screen.getByRole("searchbox", { name: "Search settings…" }), "text size");
      const results = screen.getByRole("list", { name: "Search results" });
      // A list of rows, not the settings' own controls.
      expect(within(results).queryByRole("slider")).toBeNull();
      await user.click(within(results).getAllByRole("button", { name: /Text size/ })[0]);
      expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
      const field = screen.getByRole("slider", { name: "Text size" });
      expect(scroll).toHaveBeenCalled();
      const target = scroll.mock.contexts[0] as HTMLElement;
      expect(target.closest("[data-setting-id]")).toHaveAttribute("data-setting-id", "note.text_size");
      expect(target.contains(field)).toBe(true);
    } finally {
      proto.scrollIntoView = before;
    }
  });

  it("opens a page full-screen and comes back with its back button", async () => {
    const user = open();
    await user.click(rowOf("language"));
    expect(screen.getByRole("heading", { name: "Language" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Language" })).toBeInTheDocument();
    expect(document.querySelector(".settings-phone-scroll")).toBeNull();
    await user.click(backButton());
    expect(blocks().length).toBe(5);
    expect(screen.queryByRole("combobox", { name: "Language" })).toBeNull();
  });

  // The phone's Back: Settings is a dialog, so Back is the browser's close request to the newest surface (not history).
  beforeEach(() => { installFakeCloseWatcher(); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const backGesture = async () => { requestClose(); };

  it("the back gesture (popstate) returns from a page to the list", async () => {
    const user = open();
    const historyBefore = window.history.length;
    await user.click(rowOf("appearance"));
    expect(window.history.length).toBe(historyBefore);
    await backGesture();
    await waitFor(() => expect(blocks().length).toBe(5));
    expect(liveWatchers()).toHaveLength(0); // the next Back is the dialog's own
  });

  it("外觀's 「筆記字體」 row opens the notes page, and back (button, then gesture) returns to 外觀 first", async () => {
    const user = open();
    await user.click(rowOf("appearance"));
    const fontRow = await screen.findByRole("button", { name: /Note font/ });
    expect(within(fontRow).getByText("Serif")).toBeInTheDocument();
    await user.click(fontRow);
    expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to Appearance" }));
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    await user.click(backButton());
    expect(blocks().length).toBe(5);

    await user.click(rowOf("appearance"));
    await user.click(await screen.findByRole("button", { name: /Note font/ }));
    await backGesture();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument());
    // 外觀 is still open: the next Back leaves it for the list.
    await backGesture();
    await waitFor(() => expect(blocks().length).toBe(5));
  });

  it("search on the phone does not offer keyboard shortcuts", async () => {
    const user = open();
    await user.type(screen.getByRole("searchbox", { name: "Search settings…" }), "快捷鍵");
    expect(screen.getByText(/no settings match/i)).toBeInTheDocument();
  });

  it("a deep link opens its page directly, and back goes to the list", async () => {
    const user = open("modules");
    expect(screen.getByRole("heading", { name: "Features" })).toBeInTheDocument();
    expect(screen.getByText("modules widget")).toBeInTheDocument();
    await user.click(backButton());
    expect(blocks().length).toBe(5);
  });

  it("a feature's page is reached by deep link, with its switch and every setting it has", () => {
    asOwner(["rss"]);
    open("module:rss");
    expect(screen.getByRole("heading", { level: 2, name: "Reading" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "RSS subscriptions (OPML)" })).toBeInTheDocument();
    expect(backButton()).toBeInTheDocument();
  });

  it("the desktop keeps the sidebar", () => {
    setPhone(false);
    open();
    expect(document.querySelector(".settings-sidebar")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Back to Settings" })).toBeNull();
  });
});

// Desktop and phone list the same rows (settingsSections); only the layout
// differs. The phone's list has no 快捷鍵 page: it is for the keyboard (TabSpec.desktopOnly).
describe("desktop and phone list the same pages", () => {
  const listing = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(`${selector} [data-block]`))
    .map((block) => Array.from(block.querySelectorAll<HTMLElement>("[data-tab]")).map((row) => row.dataset.tab));

  it.each([
    ["the owner, no modules", true, []],
    ["the owner, RSS imported", true, ["rss"]],
    ["a member, RSS imported", false, ["rss"]],
  ] as const)("for %s", (_, owner, modules) => {
    setAppState((s) => ({ data: { ...s.data, actor_role: owner ? "admin" : "editor", actor_is_owner: owner, workspace: { ...s.data.workspace, modules: [...modules] } } }));
    setPhone(false);
    open();
    const desktop = listing(".settings-sidebar");
    cleanup();
    setPhone(true);
    open();
    expect(listing(".settings-phone-scroll")).toEqual(desktop.map((block) => block.filter((tab) => tab !== "shortcuts")));
    // Features are not rows of the list, imported or not.
    expect(desktop.flat()).not.toContain("module:rss");
  });
});
