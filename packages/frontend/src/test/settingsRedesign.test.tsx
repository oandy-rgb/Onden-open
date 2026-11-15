// 設定改版 (docs/agents/decisions-ui.md): the old appearance choices read as the new ones, the old
// page ids still lead somewhere, the note's 「文字樣式」 sheet shares the settings' preferences.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../lib/auth-client", () => ({ authClient: { useSession: () => ({ data: null }) } }));

import { APPEARANCE_SETTINGS, applyPersistedSettings } from "../settings/appearance";
import { readValue } from "../settings/useOption";
import { noteTextSizeFromLegacy, motionFromLegacy, uiSizeFromLegacy } from "../settings/legacyPrefs";
import { resolveSettingsTab } from "../lib/settingsTab";
import { readNoteFont } from "../lib/fontStacks";
import { SETTINGS, TABS } from "../settings/registry";
import { settingMatches } from "../settings/SettingRenderer";
import { ZH_TW } from "../lib/i18n.zh-TW";
import SettingsModal from "../settings/SettingsModal";
import NoteTextStyleSheet from "../settings/NoteTextStyleSheet";
import { ChoiceCards, Segmented } from "../components/ui";
import type { EnumSettingDef } from "../lib/settingsTypes";

const def = (id: string) => APPEARANCE_SETTINGS.find((d) => d.id === id) as EnumSettingDef;
const root = () => document.documentElement;

beforeEach(() => { localStorage.clear(); root().removeAttribute("style"); root().removeAttribute("data-density"); root().removeAttribute("data-reduce-motion"); });
afterEach(() => cleanup());

describe("old choices read as the new ones", () => {
  it("基準字級 + 介面密度 → 介面大小: the size wins, else the density", () => {
    expect(uiSizeFromLegacy(null, null)).toBe("normal");
    expect(uiSizeFromLegacy(12, "spacious")).toBe("small");
    expect(uiSizeFromLegacy(18, "compact")).toBe("large");
    expect(uiSizeFromLegacy(14, "compact")).toBe("small");
    expect(uiSizeFromLegacy(14, "spacious")).toBe("large");
    expect(uiSizeFromLegacy(14, "normal")).toBe("normal");
  });

  it("the setting reads the old keys when it has none of its own, never rewrites them, and its own key wins", () => {
    localStorage.setItem("theme.font_size", "18");
    localStorage.setItem("theme.density", "compact");
    expect(readValue(def("theme.ui_size"))).toBe("large");
    applyPersistedSettings();
    expect(root().style.getPropertyValue("--onden-ui-font-size-base")).toBe("16px");
    expect(root().getAttribute("data-density")).toBe("spacious");
    expect(localStorage.getItem("theme.ui_size")).toBeNull();
    expect(localStorage.getItem("theme.font_size")).toBe("18");
    localStorage.setItem("theme.ui_size", "small");
    expect(readValue(def("theme.ui_size"))).toBe("small");
  });

  it("內文大小 (percent) → 文字大小 (the nearest of five steps); 標題大小 is gone", () => {
    expect([80, 90, 100, 110, 125, 150].map(noteTextSizeFromLegacy)).toEqual(["xs", "s", "m", "l", "xl", "xl"]);
    localStorage.setItem("note.text_scale", "125");
    expect(readValue(def("note.text_size"))).toBe("xl");
    applyPersistedSettings();
    expect(root().style.getPropertyValue("--onden-note-text-scale")).toBe("1.3");
    expect(APPEARANCE_SETTINGS.some((d) => d.id === "note.title_size")).toBe(false);
  });

  it("編輯器字體 → 字體 (until a card is chosen), 減少動態 on/off → three modes", () => {
    localStorage.setItem("theme.editor_font", "sans");
    expect(readNoteFont()).toBe("sans");
    localStorage.setItem("note.font", "kai");
    expect(readNoteFont()).toBe("kai");
    expect([motionFromLegacy("true"), motionFromLegacy("false"), motionFromLegacy(null)]).toEqual(["reduce", "system", "system"]);
    localStorage.setItem("theme.reduce_motion", "true");
    applyPersistedSettings();
    expect(root().getAttribute("data-reduce-motion")).toBe("true");
  });

  it("減少動態 follows the system unless pinned", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    try {
      applyPersistedSettings();
      expect(root().getAttribute("data-reduce-motion")).toBe("true");
      localStorage.setItem("theme.motion", "full");
      applyPersistedSettings();
      expect(root().getAttribute("data-reduce-motion")).toBeNull();
    } finally { window.matchMedia = original; }
  });
});

describe("old page ids", () => {
  it("lead to where their settings went; a feature page and an unknown id are kept or dropped", () => {
    expect(resolveSettingsTab("writing")).toBe("notes");
    expect(resolveSettingsTab("launch")).toBe("navigation");
    expect(resolveSettingsTab("appearance")).toBe("appearance");
    // 快速記錄 and 手寫 cannot be turned off: they left the feature list for the settings list, and old links follow.
    expect(resolveSettingsTab("module:handwriting")).toBe("handwriting");
    expect(resolveSettingsTab("module:capture")).toBe("capture");
    expect(resolveSettingsTab("module:ai")).toBe("module:ai"); // AI keeps its feature page: Settings › AI is the owner's only
    expect(resolveSettingsTab("module:review")).toBe("module:review");
    expect(resolveSettingsTab("nope")).toBeNull();
  });

  it("the settings screen opens an old id on its new page", () => {
    render(<SettingsModal online onClose={vi.fn()} onImportDone={vi.fn()} onConnect={vi.fn()} initialTab={"launch" as never} />);
    expect(document.querySelector('[data-tab="navigation"]')).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("radiogroup", { name: "On launch, open" })).toBeInTheDocument();
  });

  it("every page has a row in the list, and the keyboard page is for the desktop", () => {
    expect(TABS.map((tab) => tab.id)).toHaveLength(15);
    expect(TABS.filter((tab) => tab.desktopOnly).map((tab) => tab.id)).toEqual(["shortcuts"]);
  });
});

describe("the moved settings are still found", () => {
  const tr = (s: string) => ZH_TW[s] ?? s;
  const find = (query: string) => SETTINGS.filter((d) => settingMatches(d, query, "x", tr)).map((d) => d.id);
  it("by the words people used before", () => {
    expect(find("基準字級")).toContain("theme.ui_size");
    expect(find("介面密度")).toContain("theme.ui_size");
    expect(find("字型")).toContain("note.font");
    expect(find("本機字型")).toContain("note.local_font");
    expect(find("提醒")).toContain("notifications.push");
    expect(find("打開時")).toContain("home.landing");
    expect(find("換日")).toContain("daily.day_start");
  });
});

describe("the display components", () => {
  it("ChoiceCards and Segmented are radio groups that report the choice", () => {
    const pick = vi.fn();
    render(<>
      <ChoiceCards label="Cards" value="a" onChange={pick} options={[{ value: "a", label: "A", sample: "永" }, { value: "b", label: "B", sample: "Ag" }]} />
      <Segmented label="Seg" value="a" onChange={pick} options={[{ value: "a", label: "One" }, { value: "b", label: "Two" }]} />
    </>);
    expect(screen.getByRole("radio", { name: "A" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "B" }));
    fireEvent.click(screen.getByRole("radio", { name: "Two" }));
    expect(pick.mock.calls).toEqual([["b"], ["b"]]);
  });
});

describe("the note's 文字樣式 sheet", () => {
  it("changes the same preferences as Settings › Notes, and 更多設定 goes to that page", async () => {
    const onClose = vi.fn();
    const asked = vi.fn();
    window.addEventListener("onden:open-settings", asked);
    render(<NoteTextStyleSheet trigger={null} onClose={onClose} />);
    await userEvent.click(screen.getByRole("radio", { name: "Mono" }));
    await waitFor(() => expect(localStorage.getItem("note.font")).toBe("mono"));
    await userEvent.click(screen.getByRole("button", { name: "Larger text" }));
    expect(localStorage.getItem("note.text_size")).toBe("l");
    expect(root().style.getPropertyValue("--onden-note-text-scale")).toBe("1.15");
    await userEvent.click(screen.getByRole("switch", { name: "Wide page" }));
    expect(root().style.getPropertyValue("--onden-note-measure")).toBe("47.06em");
    await userEvent.click(screen.getByRole("button", { name: "More settings" }));
    expect(onClose).toHaveBeenCalled();
    expect((asked.mock.calls[0]![0] as CustomEvent).detail).toBe("notes");
    window.removeEventListener("onden:open-settings", asked);
  });
});

describe("keyboard in the display components", () => {
  it("arrow keys move through the group, wrap, and choose; only the chosen one is a tab stop; composing is ignored", () => {
    const pick = vi.fn();
    render(<Segmented label="Seg" value="a" onChange={pick} options={[{ value: "a", label: "One" }, { value: "b", label: "Two" }, { value: "c", label: "Three" }]} />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(radios[0]!, { key: "ArrowLeft" });
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight", isComposing: true });
    expect(pick.mock.calls).toEqual([["c"], ["b"]]);
  });
});
