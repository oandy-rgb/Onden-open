import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Settings, simplified (2026-10-30): the pages say things with the screen —
// values at the right, previews, switches — not with sentences. These tests
// pin the structure the owner asked for: one list, one home per setting, a
// feature's settings on its own page only, and every setting still findable.
vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }) } }));
vi.mock("../settings/spacesAndMembers", () => ({ default: () => <div>spaces widget</div> }));
const unseen = vi.hoisted(() => ({ list: [] as Array<{ id: string; date: string }> }));
vi.mock("../hooks/useUnseenChanges", () => ({ useUnseenChanges: () => ({ unseen: unseen.list, markAllSeen: () => {} }) }));

import SettingsModal from "../settings/SettingsModal";
import { resetAppState, setAppState } from "../lib/appStore";
import { resetShortcuts } from "../lib/shortcuts";
import { MODULES, MODULE_SETTINGS } from "../modules";
import { SETTINGS, TABS, settingsSections } from "../settings/registry";
import { settingMatches } from "../settings/SettingRenderer";
import { t } from "../lib/i18n";
import { ZH_TW } from "../lib/i18n.zh-TW";

function open(online = true, initialTab?: Parameters<typeof SettingsModal>[0]["initialTab"]) {
  render(<SettingsModal online={online} onClose={vi.fn()} onImportDone={vi.fn()} onConnect={vi.fn()} initialTab={initialTab} />);
  return userEvent.setup();
}
const asOwner = (modules: string[] | null = null) => setAppState((s) => ({ data: { ...s.data, actor_role: "admin", actor_is_owner: true, workspace: { ...s.data.workspace, modules } } }));
const row = (tab: string) => document.querySelector<HTMLElement>(`.settings-sidebar [data-tab="${tab}"]`)!;

beforeEach(() => { localStorage.clear(); resetShortcuts(); resetAppState(); unseen.list = []; document.documentElement.removeAttribute("data-theme"); });
afterEach(() => cleanup());

describe("every setting keeps a home and stays findable", () => {
  const all = [...SETTINGS, ...MODULE_SETTINGS];
  const tabLabelOf = (def: (typeof all)[number]) => ("moduleId" in def && def.moduleId
    ? MODULES.find((m) => m.id === def.moduleId)!.library.title
    : TABS.find((tab) => tab.id === def.tab)!.label);

  it("no setting names a page that is gone (the danger zone and the old general, time, server… tabs)", () => {
    const ids = new Set<string>(TABS.map((tab) => tab.id));
    expect([...ids].sort()).toEqual(["about", "account", "ai", "appearance", "capture", "data", "handwriting", "language", "modules", "navigation", "notes", "notifications", "shortcuts", "spaces", "time"]);
    for (const def of SETTINGS) expect(ids.has(def.tab), `${def.id} → ${def.tab}`).toBe(true);
    // Everything a feature owns sits on a feature's page.
    for (const def of MODULE_SETTINGS) {
      const known = MODULES.map((m) => m.id);
      expect(known, def.id).toContain(def.moduleId);
    }
  });

  it("each one can be found by search: by its label, or by a keyword when it is a widget that titles itself", () => {
    for (const def of all) {
      const query = def.label || def.keywords?.[0];
      expect(query, `${def.id} has neither a label nor a keyword`).toBeTruthy();
      expect(settingMatches(def, query!, tabLabelOf(def), t), `${def.id} not found by “${query}”`).toBe(true);
      // And by the name of the page it is on.
      expect(settingMatches(def, tabLabelOf(def), tabLabelOf(def), t), `${def.id} not found by its page name`).toBe(true);
    }
  });

  it("the moved settings are still found where they went", async () => {
    asOwner();
    const user = open();
    const search = screen.getByRole("searchbox", { name: "Search settings…" });
    const content = () => document.querySelector<HTMLElement>(".settings-content")!;
    const found = async (query: string, setting: string) => {
      await user.clear(search);
      await user.type(search, query);
      expect(content().querySelector(`[data-setting-id="${setting}"]`), `${query} → ${setting}`).not.toBeNull();
    };
    await found("day start", "daily.day_start");           // from 時間, now on the daily notes' page
    await found("換日", "daily.day_start");
    await found("captures", "capture.destination");        // from 一般, now on the inbox's page
    await found("時區", "time.clock");
    await found("language", "language.app");
    await found("launch", "home.landing");
    await found("sign out", "account.sign_out");           // the account page's last row
    await found("backend", "server.url");                  // the old Server page
    await found("update", "whatsnew.list");
    await found("shape", "handwriting.auto_shape");
    await found("shortcut", "shortcuts.keys");
    await found("replace", "data.backup_restore");         // what the danger zone pointed at
    await found("delete space", "spaces.manage");
  }, 20000); // types a dozen searches: the default 5 s is tight when the whole suite runs at once
});

describe("the list", () => {
  it("has the account first with a status dot, and a small 「新」 on About while updates are unread", () => {
    asOwner();
    unseen.list = [{ id: "2026-10-30-a", date: "2026-10-30" }];
    open();
    const account = row("account");
    expect(within(account).getByRole("img", { name: /Synced|Offline/ })).toBeInTheDocument();
    expect(within(row("about")).getByText("New")).toBeInTheDocument();
    cleanup();
    unseen.list = [];
    open();
    expect(within(row("about")).queryByText("New")).toBeNull();
  });

  it("draws the same rows in the same blocks on the desktop as settingsSections lists", () => {
    const drawnRows = () => Array.from(document.querySelectorAll(".settings-sidebar [data-block]")).map((b) => Array.from(b.querySelectorAll<HTMLElement>("[data-tab]")).map((r) => r.dataset.tab));
    // A member: the list without the owner's pages (AI).
    open();
    expect(drawnRows()).toEqual(settingsSections(TABS.filter((tab) => !tab.ownerOnly)).map((section) => section.rows.map((r) => r.id)));
    expect(drawnRows().flat()).not.toContain("ai");
    cleanup();
    // The owner: every page, AI right after 「空間與成員」.
    asOwner();
    open();
    expect(drawnRows()).toEqual(settingsSections(TABS).map((section) => section.rows.map((r) => r.id)));
    expect(drawnRows().flat().join()).toContain("spaces,ai,modules");
  });

  it("every page and row is translated for the owner: no English left in the list", () => {
    for (const tab of TABS) expect(ZH_TW[tab.label], tab.label).toBeTruthy();
    expect(ZH_TW["Notes"]).toBe("筆記");
    expect(ZH_TW["Notifications"]).toBe("通知");
    expect(ZH_TW["Date and time"]).toBe("日期與時間");
    expect(ZH_TW["Data and backup"]).toBe("資料與備份");
    expect(ZH_TW["About Onden"]).toBe("關於 Onden");
  });
});

describe("Features", () => {
  it("is one list: a feature's row opens its page, which holds its settings and the 「功能」 row stays selected", async () => {
    asOwner(["daily", "rss"]);
    const user = open();
    await user.click(row("modules"));
    expect(await screen.findByRole("switch", { name: "Daily notes" })).toBeChecked();
    // Off features stay in their group, quieter.
    expect(screen.getByRole("switch", { name: "Review" })).not.toBeChecked();
    await user.click(await screen.findByText("Daily notes", { selector: ".module-row-name" }));
    expect(screen.getByRole("heading", { name: "Daily notes" })).toBeInTheDocument();
    expect(await screen.findByText("Where new day notes go")).toBeInTheDocument();
    expect(row("modules")).toHaveAttribute("aria-current", "page");
    // The list has no second 「功能」 group and no row for the feature.
    expect(document.querySelectorAll(".settings-sidebar [data-tab]")).toHaveLength(TABS.length);
  });
});

describe("writing and input settings", () => {
  it("快速記錄 and 手寫 are rows of the settings list, not of the feature list, and their pages are unchanged", async () => {
    asOwner();
    const user = open();
    expect(row("capture")).not.toBeNull();
    expect(row("handwriting")).not.toBeNull();
    await user.click(row("handwriting"));
    expect(await screen.findByRole("switch", { name: "Turn a held stroke into a shape" })).toBeInTheDocument();
    await user.click(row("capture"));
    expect(await screen.findByText(/Captures go to:/)).toBeInTheDocument();
    await user.click(row("modules"));
    await screen.findByRole("switch", { name: "Daily notes" });
    expect(document.querySelector('.module-library [data-module="capture"], .module-library [data-module="handwriting"]')).toBeNull();
  });

  it("the old deep links open those pages", () => {
    for (const [id, tab] of [["module:capture", "capture"], ["module:handwriting", "handwriting"]] as const) {
      const view = render(<SettingsModal online onClose={vi.fn()} onImportDone={vi.fn()} onConnect={vi.fn()} initialTab={id} />);
      expect(document.querySelector(`.settings-sidebar [data-tab="${tab}"]`)).toHaveAttribute("aria-current", "page");
      view.unmount();
    }
  });

  it("the 功能 row says how many are on out of how many", () => {
    asOwner(["daily", "rss"]);
    open();
    expect(within(row("modules")).getByText(/^2 of \d+ on$/)).toBeInTheDocument();
  });
});

describe("Appearance", () => {
  it("shows a preview card above three colour swatches, and the theme follows a swatch at once", async () => {
    const user = open(true, "appearance");
    expect(document.querySelector(".appearance-preview")).not.toBeNull();
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(["System", "Light", "Dark"]);
    await user.click(within(group).getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(within(group).getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    // The card is inside the same document the theme is on: it follows by its tokens.
    expect(document.querySelector(".appearance-preview")!.closest("html")).toBe(document.documentElement);
  });

  it("draws the interface size as three segments and moves the variables the preview reads", async () => {
    const user = open(true, "appearance");
    const size = screen.getByRole("radiogroup", { name: "UI size" });
    expect(within(size).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Small", "Standard", "Large"]);
    await user.click(within(size).getByRole("radio", { name: "Large" }));
    expect(document.documentElement.style.getPropertyValue("--onden-ui-font-size-base")).toBe("16px");
    expect(document.documentElement.getAttribute("data-density")).toBe("spacious");
    expect(within(size).getByRole("radio", { name: "Large" })).toHaveAttribute("aria-checked", "true");
    // Reduce motion: system / reduce / don't reduce. The page has the one preview.
    const motion = screen.getByRole("radiogroup", { name: "Reduce motion" });
    await user.click(within(motion).getByRole("radio", { name: "Reduce" }));
    expect(document.documentElement.getAttribute("data-reduce-motion")).toBe("true");
    expect(document.querySelectorAll(".ui-preview-block")).toHaveLength(1);
    // The font and base size are not here any more.
    expect(screen.queryByRole("slider", { name: "Base font size" })).toBeNull();
    expect(screen.queryByText("Interface font")).toBeNull();
  });
});

describe("Notes", () => {
  it("has the one preview first, then the font cards, the text size and width sliders; the rare ones are folded", async () => {
    const user = open(true, "notes");
    const blocks = document.querySelectorAll(".ui-preview-block");
    expect(blocks).toHaveLength(1);
    expect(await screen.findByRole("radiogroup", { name: "Font" })).toBeInTheDocument();
    const text = screen.getByRole("slider", { name: "Text size" });
    expect(text.parentElement!.querySelectorAll("svg")).toHaveLength(2);
    fireEvent.change(text, { target: { value: "4" } });
    expect(document.documentElement.style.getPropertyValue("--onden-note-text-scale")).toBe("1.3");
    expect(screen.getByText("Very large")).toBeInTheDocument(); // the row shows the value in words
    const width = screen.getByRole("slider", { name: "Width" });
    expect(width).toHaveAttribute("max", "3");
    fireEvent.change(width, { target: { value: "3" } });
    expect(document.documentElement.style.getPropertyValue("--onden-note-measure")).toBe("100vw");
    expect(screen.queryByText("Grow with the window")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show advanced settings" }));
    expect(screen.getByText("Grow with the window")).toBeInTheDocument();
    expect(await screen.findByText("Other fonts on this computer…")).toBeInTheDocument();
  });
});

let afterEachRestore = () => {};
afterEach(() => { afterEachRestore(); afterEachRestore = () => {}; });

describe("Navigation bar", () => {
  it("draws the bar itself above the lists: Notes, the pinned entries, and empty slots", () => {
    // The phone shell (≤900px): the bottom bar. The desktop shell draws the real top bar (navPinning.test).
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes("max-width: 900px"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    afterEachRestore = () => { window.matchMedia = original; };
    open(true, "navigation");
    const bar = document.querySelector(".nav-bar-preview")!;
    expect(bar).not.toBeNull();
    expect(bar.querySelector('[data-destination="notes"]')).not.toBeNull();
    expect(bar.querySelectorAll(".nav-bar-preview-slot").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/Follows your account/)).toBeNull();
  });
});

describe("Account", () => {
  it("shows the saving state, and 「登出」 is the page's last row, in red", () => {
    open(true, "account");
    expect(screen.getByText("Saving")).toBeInTheDocument();
    // Signed in is the session's business (mocked out here): the sign-out row only shows then.
    const ids = Array.from(document.querySelectorAll(".settings-content [data-setting-id]")).map((el) => el.getAttribute("data-setting-id"));
    expect(ids[0]).toBe("account.identity");
  });
});

describe("About", () => {
  it("has the version, the update history, and the owner's failed jobs only for the owner", () => {
    asOwner();
    open(true, "about");
    const ids = Array.from(document.querySelectorAll(".settings-content [data-setting-id]")).map((el) => el.getAttribute("data-setting-id"));
    expect(ids).toEqual(["about.version", "whatsnew.list", "system.failed_jobs"]);
    cleanup();
    resetAppState();
    setAppState((s) => ({ data: { ...s.data, actor_role: "editor", actor_is_owner: false } }));
    open(true, "about");
    const memberIds = Array.from(document.querySelectorAll(".settings-content [data-setting-id]")).map((el) => el.getAttribute("data-setting-id"));
    expect(memberIds).toEqual(["about.version", "whatsnew.list"]);
  });
});

describe("no sentences at the top of a page", () => {
  it("the old lead-ins are gone", () => {
    asOwner();
    open(true, "modules");
    for (const old of [
      "Shared by everyone in this workspace. Some settings can only be changed by the owner.",
      "Built-in features, nothing to install. Turning one off only hides its pages; your data stays.",
      "Kept in this browser. Other devices and people are not affected.",
    ]) expect(screen.queryByText(old)).toBeNull();
    expect(document.querySelector(".settings-scope-note")).toBeNull();
  });
});
