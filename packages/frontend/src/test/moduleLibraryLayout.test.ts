import { describe, expect, it } from "vitest";
import { act } from "@testing-library/react";
import { setLocalePref } from "../lib/i18n";
import { MODULES, inModuleLibrary, moduleStatusFor } from "../modules";
import { LIBRARY_GROUPS, libraryLayout, waitingFor, waitingText } from "../lib/libraryLayout";
import { t } from "../lib/i18n";
import type { FrontendModule } from "../modules";

// Settings › Features is drawn from what each module declares (library.group,
// blurb, requires, requiresAny). These keep a new module from landing without a
// place, and the list from repeating an icon.

const listed = MODULES.filter(inModuleLibrary);

describe("the feature list's layout comes from the registry", () => {
  it("every listed feature declares a group the list knows, and a one-line sentence", () => {
    const groups = new Set(LIBRARY_GROUPS.map((g) => g.id));
    for (const mod of listed) {
      expect(mod.library.group, `${mod.id} has no library.group`).toBeDefined();
      expect(groups.has(mod.library.group!.id), `${mod.id}: group ${mod.library.group!.id}`).toBe(true);
      expect(mod.library.blurb?.trim(), `${mod.id} has no library.blurb`).toBeTruthy();
    }
    // Nothing is dropped from the drawing.
    expect(libraryLayout().flatMap((g) => g.rows).map((r) => r.mod.id).sort()).toEqual(listed.map((m) => m.id).sort());
  });

  it("groups come in the agreed order, each feature in its own place", () => {
    const layout = libraryLayout();
    expect(layout.map((g) => g.id)).toEqual(["search", "time", "reading", "ai", "publish"]);
    expect(Object.fromEntries(layout.map((g) => [g.id, g.rows.map((r) => r.mod.id)]))).toMatchObject({
      search: ["semantic"],
      time: ["daily", "tasks", "external_calendars"],
      ai: ["ai", "skills"],
      publish: ["website"],
    });
  });

  it("within a group the order is the modules' own `order`, whatever the registry order", () => {
    const fake = (id: string, order: number, extra: object = {}) =>
      ({ id, library: { title: id, Icon: () => null, group: { id: "reading", order }, blurb: id, ...extra } }) as unknown as FrontendModule;
    const rows = libraryLayout([fake("c", 3), fake("a", 1), fake("b", 2, { requires: ["a"] })])[0].rows;
    expect(rows.map((r) => [r.mod.id, r.sub])).toEqual([["a", false], ["b", true], ["c", false]]);
  });

  it("while developing, a listed feature with no group is an error, not a silent gap", () => {
    const lost = { id: "lost", library: { title: "lost", Icon: () => null } } as unknown as FrontendModule;
    expect(() => libraryLayout([lost])).toThrow(/lost/);
  });

  it("a feature that needs another sits in the same group, after it, and is marked as hanging under it", () => {
    for (const group of libraryLayout()) {
      group.rows.forEach(({ mod, sub }, index) => {
        const hosts = [...(mod.library.requires ?? []), ...(mod.library.requiresAny ?? [])];
        if (hosts.length === 0) return expect(sub, mod.id).toBe(false);
        expect(sub, mod.id).toBe(true);
        for (const host of hosts) expect(group.rows.findIndex((r) => r.mod.id === host), `${mod.id} → ${host}`).toBeGreaterThanOrEqual(0);
        for (const host of hosts) expect(group.rows.findIndex((r) => r.mod.id === host), `${host} before ${mod.id}`).toBeLessThan(index);
      });
    }
  });

  it("no two features the list shows share an icon", () => {
    const seen = new Map<unknown, string>();
    for (const mod of listed) {
      expect(seen.get(mod.library.Icon), `${mod.id} repeats the icon of ${seen.get(mod.library.Icon)}`).toBeUndefined();
      seen.set(mod.library.Icon, mod.id);
    }
  });

  it("AI is a feature of its own group and semantic search is not under it", () => {
    const semantic = libraryLayout().find((g) => g.rows.some((r) => r.mod.id === "semantic"))!;
    expect(semantic.id).toBe("search");
    expect(MODULES.find((m) => m.id === "semantic")!.library.requires ?? []).toEqual([]);
    expect(MODULES.find((m) => m.id === "ai")!.library.settingsTab).toBe("ai");
  });
});

describe("what a feature is waiting for", () => {
  const skills = MODULES.find((m) => m.id === "skills")!;
  const calendars = MODULES.find((m) => m.id === "external_calendars")!;

  it("skills need AI; they were not lost, they wait", () => {
    expect(waitingFor(skills, moduleStatusFor(["skills"], []))).toEqual({ names: ["AI"], any: false });
    expect(waitingFor(skills, moduleStatusFor(["ai", "skills"], []))).toBeNull();
  });

  it("external calendars need the journal or tasks: either is enough", () => {
    expect(waitingFor(calendars, moduleStatusFor(["tasks"], []))).toBeNull();
    expect(waitingFor(calendars, moduleStatusFor(["daily"], []))).toBeNull();
    const none = waitingFor(calendars, moduleStatusFor([], []))!;
    expect(none).toEqual({ names: ["Daily notes", "Tasks"], any: true });
    expect(waitingText(none, t)).toBe("Turn on Daily notes or Tasks first");
    expect(waitingText({ names: ["AI"], any: false }, t)).toBe("Turn on AI first");
  });

  it("in Chinese a Latin name gets a space after the wording, a Chinese one does not", () => {
    act(() => setLocalePref("zh-TW"));
    try {
      expect(waitingText({ names: ["AI"], any: false }, t)).toBe("要先打開 AI");
      expect(waitingText({ names: ["Daily notes", "Tasks"], any: true }, t)).toBe("要先打開日記或任務");
    } finally { act(() => setLocalePref("system")); }
  });
});
