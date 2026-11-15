import { describe, it, expect, beforeEach } from "vitest";
import { APPEARANCE_SETTINGS, applyPersistedSettings } from "../settings/appearance";
import { writeValue } from "../settings/useOption";
import type { SettingDef } from "../lib/settingsTypes";
import { settingMatches } from "../settings/SettingRenderer";
import { ZH_TW } from "../lib/i18n.zh-TW";

const def = (id: string) => APPEARANCE_SETTINGS.find((d) => d.id === id) as Extract<SettingDef, { type: "enum" | "boolean" }>;
const root = () => document.documentElement;

describe("note page appearance settings", () => {
  beforeEach(() => { localStorage.clear(); root().removeAttribute("style"); });

  it.each([
    ["narrow", "35.29em", "32px"],
    ["standard", "41.18em", "32px"],
    ["wide", "47.06em", "32px"],
    ["full", "100vw", "48px"],
  ])("note width %s sets the column variables", (choice, measure, gutter) => {
    def("note.measure").apply!(choice as never);
    expect(root().style.getPropertyValue("--onden-note-measure")).toBe(measure);
    expect(root().style.getPropertyValue("--onden-note-gutter")).toBe(gutter);
  });

  it("text size writes the ratio the note font is multiplied by; titles follow it (they have no size of their own)", () => {
    def("note.text_size").apply!("xl" as never);
    expect(root().style.getPropertyValue("--onden-note-text-scale")).toBe("1.3");
    def("note.text_size").apply!("xs" as never);
    expect(root().style.getPropertyValue("--onden-note-text-scale")).toBe("0.8");
    expect(def("note.text_size").default).toBe("m");
    expect((def("note.text_size") as Extract<SettingDef, { type: "enum" }>).options.map((o) => o.value)).toEqual(["xs", "s", "m", "l", "xl"]);
    expect(APPEARANCE_SETTINGS.map((d) => d.id)).not.toContain("note.title_size");
  });

  it("the follow-the-window switch is on by default and pins the size when off", () => {
    expect(def("note.fluid_text").default).toBe(true);
    def("note.fluid_text").apply!(false as never);
    expect(root().style.getPropertyValue("--onden-note-fluid")).toBe("0");
    def("note.fluid_text").apply!(true as never);
    expect(root().style.getPropertyValue("--onden-note-fluid")).toBe("1");
  });

  it("defaults are standard width and standard text", () => {
    expect([def("note.measure").default, def("note.text_size").default]).toEqual(["standard", "m"]);
  });

  it("boot replay applies the defaults and the saved choices", () => {
    applyPersistedSettings();
    expect(root().style.getPropertyValue("--onden-note-text-scale")).toBe("1");
    expect(root().style.getPropertyValue("--onden-note-fluid")).toBe("1");
    expect(root().style.getPropertyValue("--onden-note-measure")).toBe("41.18em");

    writeValue(def("note.measure") as never, "wide" as never);
    root().removeAttribute("style");
    applyPersistedSettings();
    expect(root().style.getPropertyValue("--onden-note-measure")).toBe("47.06em");
  });
});

describe("settings search finds the note page settings", () => {
  const tr = (s: string) => ZH_TW[s] ?? s;
  const find = (q: string) => APPEARANCE_SETTINGS.filter((d) => settingMatches(d, q, "筆記", tr)).map((d) => d.id);
  it("by 寬度, 標題 (the old title size now lives in the text size), the old 內文大小 and 視窗", () => {
    expect(find("寬度")).toContain("note.measure");
    expect(find("標題")).toContain("note.text_size");
    expect(find("內文大小")).toContain("note.text_size");
    expect(find("視窗")).toContain("note.fluid_text");
  });
});
