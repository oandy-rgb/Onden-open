// The shapes a person's preferences may take (services/actorPrefs.ts parsePref),
// without a database: the route tests in actorPrefs.integration.test.ts need one.
import { describe, expect, it } from "vitest";
import { isPrefKey, parsePref } from "../services/actorPrefs.js";

describe("changesSeen", () => {
  it("is a known key holding the id of the newest change seen (it starts with its day)", () => {
    expect(isPrefKey("changesSeen")).toBe(true);
    expect(parsePref("changesSeen", "2026-10-29-add-view")).toEqual({ ok: true, value: "2026-10-29-add-view" });
    expect(parsePref("changesSeen", null)).toEqual({ ok: true, value: null });
  });

  it("refuses anything else", () => {
    for (const bad of ["", "add-view", "2026-10-29 add view", "2026-10-29-" + "x".repeat(100), 20261029, ["2026-10-29-a"]]) {
      expect(parsePref("changesSeen", bad), JSON.stringify(bad).slice(0, 40)).toEqual({ ok: false });
    }
  });
});

describe("hintsSeen", () => {
  it("is a known key holding a bounded list of hint ids", () => {
    expect(isPrefKey("hintsSeen")).toBe(true);
    expect(parsePref("hintsSeen", ["welcome", "hashtag-to-scope"])).toEqual({ ok: true, value: ["welcome", "hashtag-to-scope"] });
    expect(parsePref("hintsSeen", [])).toEqual({ ok: true, value: [] });
    expect(parsePref("hintsSeen", null)).toEqual({ ok: true, value: null });
  });

  it("refuses anything else", () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `h${i}`);
    for (const bad of ["welcome", { welcome: true }, [""], ["x".repeat(65)], [1], [null], tooMany]) {
      expect(parsePref("hintsSeen", bad), JSON.stringify(bad).slice(0, 40)).toEqual({ ok: false });
    }
  });

  it("leaves the other keys' shapes alone", () => {
    expect(parsePref("nav", ["welcome"])).toEqual({ ok: false });
    expect(parsePref("sidebarTags", ["welcome"])).toEqual({ ok: false });
  });

  it("accepts up to ten recent paragraphs (note id, ^id, time) and nothing looser", () => {
    const one = { note: "3f0b7a52-3c1e-4d5a-9a3e-2b8f4c7d1e60", ref: "k3f9", at: 1793000000000 };
    expect(isPrefKey("recentBlocks")).toBe(true);
    expect(parsePref("recentBlocks", [one])).toEqual({ ok: true, value: [one] });
    expect(parsePref("recentBlocks", Array.from({ length: 10 }, () => one)).ok).toBe(true);
    expect(parsePref("recentBlocks", Array.from({ length: 11 }, () => one))).toEqual({ ok: false });
    for (const bad of [{ ...one, at: 0 }, { ...one, at: 1.5 }, { ...one, ref: "" }, { ...one, note: "x".repeat(65) }, { ...one, extra: 1 }, { note: one.note, ref: "a" }, "text"]) {
      expect(parsePref("recentBlocks", [bad]), JSON.stringify(bad)).toEqual({ ok: false });
    }
  });

  it("accepts a note id (or null) for the day-note parent and nothing else", () => {
    expect(isPrefKey("dayNoteParent")).toBe(true);
    expect(parsePref("dayNoteParent", "3f0b7a52-3c1e-4d5a-9a3e-2b8f4c7d1e60")).toEqual({ ok: true, value: "3f0b7a52-3c1e-4d5a-9a3e-2b8f4c7d1e60" });
    expect(parsePref("dayNoteParent", null)).toEqual({ ok: true, value: null });
    for (const bad of ["", "x".repeat(65), 7, ["a"], { id: "a" }, true]) {
      expect(parsePref("dayNoteParent", bad), JSON.stringify(bad)).toEqual({ ok: false });
    }
  });

  it("accepts where captures go as a short word or a note id, and nothing else", () => {
    expect(isPrefKey("captureDestination")).toBe(true);
    for (const ok of ["inbox", "today", "3f0b7a52-3c1e-4d5a-9a3e-2b8f4c7d1e60"]) {
      expect(parsePref("captureDestination", ok), ok).toEqual({ ok: true, value: ok });
    }
    expect(parsePref("captureDestination", null)).toEqual({ ok: true, value: null });
    for (const bad of ["", "x".repeat(65), 7, ["inbox"], { kind: "inbox" }, true]) {
      expect(parsePref("captureDestination", bad), JSON.stringify(bad)).toEqual({ ok: false });
    }
  });
});

describe("the RSS and journal preferences", () => {
  const many = (n: number, value: unknown) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, value]));

  it("accepts each key's shape, and null for all of them", () => {
    const good: Record<string, unknown> = {
      rssShowCounts: true,
      rssFeedCounts: { f1: "on", f2: "off" },
      rssReadingPosition: { all: { id: "i1", open: true } },
      rssLastVisit: "2026-10-26T08:00:00.000Z",
      focusMinutes: 25,
      focusCycle: { rest: 5, longEvery: 4 },
    };
    for (const [key, value] of Object.entries(good)) {
      expect(isPrefKey(key), key).toBe(true);
      expect(parsePref(key as never, value), key).toEqual({ ok: true, value });
      expect(parsePref(key as never, null), key).toEqual({ ok: true, value: null });
    }
    expect(parsePref("rssShowCounts", false)).toEqual({ ok: true, value: false });
    // The edges of the cycle: one minute and every round, an hour and never a long break.
    for (const edge of [{ rest: 1, longEvery: 12 }, { rest: 60, longEvery: 0 }]) expect(parsePref("focusCycle", edge)).toEqual({ ok: true, value: edge });
  });

  it("refuses a wrong shape", () => {
    const bad: Record<string, unknown[]> = {
      rssShowCounts: ["true", 1, {}],
      rssFeedCounts: [["f1"], { f1: "yes" }, { "": "on" }, { ["x".repeat(65)]: "on" }, "on"],
      rssReadingPosition: [{ all: { id: "i1" } }, { all: { id: "", open: true } }, { all: { id: "i1", open: true, extra: 1 } }, { all: "i1" }, []],
      rssLastVisit: ["", "yesterday", 7, "x".repeat(41)],
      focusMinutes: [-1, 241, 12.5, "25", true, {}],
      focusCycle: [{ rest: 0, longEvery: 4 }, { rest: 61, longEvery: 4 }, { rest: 5.5, longEvery: 4 }, { rest: 5, longEvery: -1 }, { rest: 5, longEvery: 13 },
        { rest: 5 }, { longEvery: 4 }, { rest: "5", longEvery: 4 }, { rest: 5, longEvery: 4, extra: 1 }, [5, 4], 5, true],
    };
    for (const [key, values] of Object.entries(bad)) {
      for (const value of values) expect(parsePref(key as never, value), `${key} ${JSON.stringify(value)}`).toEqual({ ok: false });
    }
  });

  it("bounds how many feeds and views it holds", () => {
    expect(parsePref("rssFeedCounts", many(500, "on")).ok).toBe(true);
    expect(parsePref("rssFeedCounts", many(501, "on"))).toEqual({ ok: false });
    expect(parsePref("rssReadingPosition", many(50, { id: "i", open: false })).ok).toBe(true);
    expect(parsePref("rssReadingPosition", many(51, { id: "i", open: false }))).toEqual({ ok: false });
  });
});


describe("the time-zone preferences", () => {
  it("timeZoneAsk is a boolean and timeZoneAnswered a bounded zone name, both clearable", () => {
    for (const key of ["timeZoneAsk", "timeZoneAnswered"] as const) {
      expect(isPrefKey(key), key).toBe(true);
      expect(parsePref(key, null)).toEqual({ ok: true, value: null });
    }
    expect(parsePref("timeZoneAsk", false)).toEqual({ ok: true, value: false });
    expect(parsePref("timeZoneAnswered", "Asia/Tokyo")).toEqual({ ok: true, value: "Asia/Tokyo" });
    for (const bad of ["yes", 1, ["a"]]) expect(parsePref("timeZoneAsk", bad), JSON.stringify(bad)).toEqual({ ok: false });
    for (const bad of ["", "x".repeat(65), 8, true, { zone: "UTC" }]) expect(parsePref("timeZoneAnswered", bad), JSON.stringify(bad)).toEqual({ ok: false });
  });
});

describe("the ink preferences (palette, last shape, hold-still)", () => {
  const palette = { quick: ["#15130d", "#7a2e33", "#315f8f", "#c2871d", "#c43c3c"], recent: ["#fff176"], custom: ["#12ab34"] };

  it("accepts a palette of five quick colours with bounded lists, and null for all three keys", () => {
    for (const key of ["inkPalette", "inkShape", "inkAutoShape"]) {
      expect(isPrefKey(key), key).toBe(true);
      expect(parsePref(key as "inkPalette", null)).toEqual({ ok: true, value: null });
    }
    expect(parsePref("inkPalette", palette)).toEqual({ ok: true, value: palette });
    expect(parsePref("inkPalette", { ...palette, recent: Array(8).fill("#000000"), custom: Array(12).fill("#ffffff") }).ok).toBe(true);
  });

  it("refuses a palette that is not exactly that", () => {
    const bad: unknown[] = [
      { ...palette, quick: palette.quick.slice(0, 4) },
      { ...palette, quick: [...palette.quick, "#000000"] },
      { ...palette, quick: ["red", ...palette.quick.slice(1)] },
      { ...palette, quick: ["#C43C3C", ...palette.quick.slice(1)] }, // the app stores lower case
      { ...palette, quick: ["#fff", ...palette.quick.slice(1)] },
      { ...palette, recent: Array(9).fill("#000000") },
      { ...palette, custom: Array(13).fill("#000000") },
      { ...palette, extra: 1 },
      { quick: palette.quick },
      palette.quick,
      "palette",
    ];
    for (const value of bad) expect(parsePref("inkPalette", value), JSON.stringify(value).slice(0, 60)).toEqual({ ok: false });
  });

  it("the last shape is one of the kinds the ink format offers", () => {
    for (const kind of ["line", "arrow", "rectangle", "roundedRectangle", "ellipse", "triangle", "diamond", "star"]) {
      expect(parsePref("inkShape", kind), kind).toEqual({ ok: true, value: kind });
    }
    for (const bad of ["circle", "spiral", "", 3, true, ["star"]]) expect(parsePref("inkShape", bad), String(bad)).toEqual({ ok: false });
  });

  it("hold-still is a yes or no", () => {
    expect(parsePref("inkAutoShape", false)).toEqual({ ok: true, value: false });
    for (const bad of ["true", 1, {}]) expect(parsePref("inkAutoShape", bad)).toEqual({ ok: false });
  });
});

describe("the ink pen presets and shape fill", () => {
  const preset = { id: "p1", name: "批註", tool: "highlighter", color: "#fff176", sizeId: "broad" };

  it("a shape fill is none or solid", () => {
    expect(parsePref("inkShapeFill", "solid")).toEqual({ ok: true, value: "solid" });
    expect(parsePref("inkShapeFill", null)).toEqual({ ok: true, value: null });
    for (const bad of ["fill", "", true, 1]) expect(parsePref("inkShapeFill", bad), String(bad)).toEqual({ ok: false });
  });

  it("accepts up to six presets of a pen or highlighter with a colour and a thickness", () => {
    expect(parsePref("inkPresets", [])).toEqual({ ok: true, value: [] });
    expect(parsePref("inkPresets", [preset])).toEqual({ ok: true, value: [preset] });
    const six = Array.from({ length: 6 }, (_, i) => ({ ...preset, id: `p${i}` }));
    expect(parsePref("inkPresets", six).ok).toBe(true);
    expect(parsePref("inkPresets", [{ ...preset, name: "" }]).ok).toBe(true); // unnamed: shown by tool and thickness
  });

  it("refuses a seventh preset and any entry that is not exactly that shape", () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ ...preset, id: `p${i}` }));
    const bad: unknown[] = [
      seven,
      [{ ...preset, tool: "eraser" }],
      [{ ...preset, tool: "shape" }],
      [{ ...preset, color: "yellow" }],
      [{ ...preset, color: "#FFF176" }],
      [{ ...preset, sizeId: "huge" }],
      [{ ...preset, id: "" }],
      [{ ...preset, name: "x".repeat(301) }],
      [{ ...preset, extra: 1 }],
      [{ id: "p1", tool: "pen" }],
      preset,
      "presets",
    ];
    for (const value of bad) expect(parsePref("inkPresets", value), JSON.stringify(value).slice(0, 60)).toEqual({ ok: false });
  });
});

describe("the side-by-side pane", () => {
  it("accepts what the right side shows (or nothing) and how wide the left stays", () => {
    expect(parsePref("splitPane", { right: "note:abc:canvas", ratio: 0.5 })).toEqual({ ok: true, value: { right: "note:abc:canvas", ratio: 0.5 } });
    expect(parsePref("splitPane", { right: null, ratio: 0.25 })).toEqual({ ok: true, value: { right: null, ratio: 0.25 } });
  });
  it("refuses a ratio outside a quarter to three quarters, an empty destination and extra fields", () => {
    for (const bad of [{ right: null, ratio: 0.1 }, { right: null, ratio: 0.9 }, { right: "", ratio: 0.5 }, { right: null }, { right: null, ratio: 0.5, extra: 1 }, "page:tasks"]) {
      expect(parsePref("splitPane", bad), JSON.stringify(bad)).toEqual({ ok: false });
    }
  });
});

describe("the side-by-side pane kept per kind of screen", () => {
  it("accepts the bare key (the starting value) and one key per kind, all with the same shape", () => {
    for (const key of ["splitPane", "splitPane.phone", "splitPane.desktop"]) {
      expect(isPrefKey(key), key).toBe(true);
      expect(parsePref(key as "splitPane", { right: "page:tasks", ratio: 0.5 })).toEqual({ ok: true, value: { right: "page:tasks", ratio: 0.5 } });
      expect(parsePref(key as "splitPane", { right: null, ratio: 0.9 })).toEqual({ ok: false });
    }
  });
});

describe("the toolbar layout kept per kind of screen", () => {
  it("accepts the bare key (the starting value) and one key per kind, all with the same shape", () => {
    const layout = { bar: ["bold", "italic"], selection: null };
    for (const key of ["toolbarLayout", "toolbarLayout.phone", "toolbarLayout.desktop"]) {
      expect(isPrefKey(key), key).toBe(true);
      expect(parsePref(key as "toolbarLayout", layout)).toEqual({ ok: true, value: layout });
      expect(parsePref(key as "toolbarLayout", { bar: "bold", selection: null })).toEqual({ ok: false });
    }
  });
});

describe("the font choices", () => {
  it("accepts default, system and a named custom face per role, and null", () => {
    expect(isPrefKey("fonts")).toBe(true);
    expect(parsePref("fonts", null)).toEqual({ ok: true, value: null });
    const value = { ui: { mode: "system" }, body: { mode: "custom", name: "My Face" } };
    expect(parsePref("fonts", value)).toEqual({ ok: true, value });
  });

  it("refuses an unknown mode, a long name and extra fields", () => {
    for (const bad of [
      { ui: { mode: "upload" }, body: { mode: "default" } },
      { ui: { mode: "custom", name: "x".repeat(81) }, body: { mode: "default" } },
      { ui: { mode: "default" } },
      { ui: { mode: "default", file: "a.ttf" }, body: { mode: "default" } },
    ]) expect(parsePref("fonts", bad)).toEqual({ ok: false });
  });
});

describe("reviewGroupBy", () => {
  it("is 'tag' or 'note'; null clears it", () => {
    expect(isPrefKey("reviewGroupBy")).toBe(true);
    for (const good of ["tag", "note", null]) expect(parsePref("reviewGroupBy", good), String(good)).toEqual({ ok: true, value: good });
    for (const bad of ["deck", "", 1, { by: "tag" }]) expect(parsePref("reviewGroupBy", bad), JSON.stringify(bad)).toEqual({ ok: false });
  });
});

describe("reviewsPerDay", () => {
  it("is one whole number of reviews a day, or cleared", () => {
    expect(isPrefKey("reviewsPerDay")).toBe(true);
    expect(parsePref("reviewsPerDay", 20)).toEqual({ ok: true, value: 20 });
    expect(parsePref("reviewsPerDay", null)).toEqual({ ok: true, value: null });
    for (const bad of [0, -1, 5001, 2.5, "20", { limit: 20 }]) expect(parsePref("reviewsPerDay", bad), JSON.stringify(bad)).toEqual({ ok: false });
  });
});

describe("reviewScope", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  it("is the review page's scope text (a note, a tag or untagged); null clears it", () => {
    expect(isPrefKey("reviewScope")).toBe(true);
    for (const good of ["all", "untagged", `root.${id}`, `tag.${id}`, null]) expect(parsePref("reviewScope", good), String(good)).toEqual({ ok: true, value: good });
    for (const bad of ["status", "root.x", `root.${id}.x`, 1, {}]) expect(parsePref("reviewScope", bad), JSON.stringify(bad)).toEqual({ ok: false });
  });
});
