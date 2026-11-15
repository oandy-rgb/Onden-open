import { describe, expect, it } from "vitest";
import { BOX_IDS, BOX_SPECS, picksOf, withBox } from "./boxes.js";
import { defaultDesign, isDefaultHome, migrateV2, usesLegacyHome, validateDesign } from "./designV3.js";
import { defaultDesignV2, defaultFrames } from "./defaults.js";
import type { BoxPick, SiteBoxes } from "./design.js";
import { legacyDesignOf, withLegacyDesign } from "./legacy.js";
import { HOME_PRESETS, HOME_PRESET_IDS, applyHomePreset, defaultBoxes } from "./presets.js";
import { BUILTIN_WIDGETS, NO_FACTS, WIDGETS, createWidgetRegistry, widgetReady, type WidgetDef } from "./widgets.js";

const pick = (widget: string, variant = ""): BoxPick => ({ widget, variant });

describe("boxes and widgets", () => {
  it("every box has a spec and every widget's classes name a box class that exists", () => {
    const classes = new Set(BOX_IDS.map((id) => BOX_SPECS[id].accepts));
    for (const widget of BUILTIN_WIDGETS) {
      expect(widget.variants.length).toBeGreaterThan(0);
      for (const c of widget.classes) expect(classes.has(c)).toBe(true);
    }
  });
  it("list box limits: home 8, note end 4, tag end 3, foot 4; the rest are single", () => {
    expect(Object.fromEntries(BOX_IDS.map((id) => [id, BOX_SPECS[id].max]))).toEqual({
      header: 1, "home.hero": 1, "home.list": 8, "note.meta": 1, "note.left": 1, "note.right": 1, "note.end": 4,
      "tag.desc": 1, "tag.list": 1, "tag.end": 3, foot: 4,
    });
  });
  it("every box of the default design holds only widgets that box takes", () => {
    const boxes = defaultBoxes();
    for (const id of BOX_IDS) for (const p of picksOf(boxes, id)) {
      expect(WIDGETS.get(p.widget)!.classes).toContain(BOX_SPECS[id].accepts);
      expect(WIDGETS.get(p.widget)!.variants.map((v) => v.id)).toContain(p.variant);
    }
  });
  it("withBox cuts a list at its limit and a single box keeps one", () => {
    const many = Array.from({ length: 12 }, () => pick("recent", "list"));
    expect(withBox(defaultBoxes(), "home.list", many)["home.list"]).toHaveLength(8);
    expect(withBox(defaultBoxes(), "header", [pick("nav", "bar"), pick("nav", "center")]).header).toEqual(pick("nav", "bar"));
  });
  it("a widget is ready only when the site has what it needs", () => {
    const toc = WIDGETS.get("toc")!;
    expect(widgetReady(toc, { ...NO_FACTS, headings: 2 })).toBe(false);
    expect(widgetReady(toc, { ...NO_FACTS, headings: 3 })).toBe(true);
    expect(widgetReady(WIDGETS.get("intro")!, NO_FACTS)).toBe(false);
    expect(widgetReady(WIDGETS.get("rss")!, NO_FACTS)).toBe(true);
    expect(widgetReady(WIDGETS.get("scheme")!, { ...NO_FACTS, scheme: "dark" })).toBe(false);
  });
  it("a module adds widgets; a built-in id cannot be replaced", () => {
    const blogroll: WidgetDef = { id: "blogroll", label: "部落卷", blurb: "", classes: ["section"], variants: [{ id: "list", label: "清單" }], module: "reader" };
    const fake: WidgetDef = { ...blogroll, id: "intro", label: "假的" };
    const registry = createWidgetRegistry([blogroll, fake]);
    expect(registry.get("blogroll")?.module).toBe("reader");
    expect(registry.get("intro")?.label).toBe("自我介紹");
    expect(registry.accepted("section").map((w) => w.id)).toContain("blogroll");
    expect(registry.accepted("foot").map((w) => w.id)).not.toContain("blogroll");
  });
});

describe("validateDesign (v3)", () => {
  it("keeps the default design as it is", () => {
    const d = defaultDesign();
    expect(validateDesign(d)).toEqual({ design: d, problems: [] });
  });
  it("a box takes only its class: a foot widget in the hero is dropped back to the default", () => {
    const d = { ...defaultDesign(), boxes: { ...defaultDesign().boxes, "home.hero": pick("rss", "link") } };
    const out = validateDesign(d);
    expect(out.design.boxes["home.hero"]).toEqual(defaultDesign().boxes["home.hero"]);
    expect(out.problems.join()).toContain("home.hero");
  });
  it("drops widgets a list box does not take and cuts it at its limit", () => {
    const list = [...Array.from({ length: 9 }, () => pick("recent", "list")), pick("rss", "link")];
    const out = validateDesign({ ...defaultDesign(), boxes: { ...defaultDesign().boxes, "home.list": list } });
    expect(out.design.boxes["home.list"]).toHaveLength(8);
    expect(out.design.boxes["home.list"].every((p) => p.widget === "recent")).toBe(true);
    const end = Array.from({ length: 6 }, () => pick("backlinks", "quote"));
    expect(validateDesign({ ...defaultDesign(), boxes: { ...defaultDesign().boxes, "note.end": end } }).design.boxes["note.end"]).toHaveLength(4);
  });
  it("an unknown variant becomes the widget's first one; an unknown widget is dropped from a list", () => {
    const boxes = { ...defaultDesign().boxes, "home.list": [pick("all", "nope"), pick("nonsense", "x")] };
    expect(validateDesign({ ...defaultDesign(), boxes }).design.boxes["home.list"]).toEqual([pick("all", "byYear")]);
  });
  it("an empty box stays empty (null) and a missing box takes the default", () => {
    const { header: _h, ...rest } = defaultDesign().boxes;
    const out = validateDesign({ ...defaultDesign(), boxes: { ...rest, "note.left": null } }).design;
    expect(out.boxes["note.left"]).toBeNull();
    expect(out.boxes.header).toEqual(defaultDesign().boxes.header);
  });
  it("is a total function: junk becomes the default design", () => {
    for (const junk of [null, 7, "x", [], { v: 4 }, { v: 3, boxes: 5, preset: 9 }]) {
      const out = validateDesign(junk).design;
      expect(out.v).toBe(3);
      for (const id of BOX_IDS) expect(out.boxes).toHaveProperty(id);
    }
  });
  it("a legacy home needs content; preset null without one falls back to 簡單", () => {
    expect(validateDesign({ ...defaultDesign(), preset: null }).design.preset).toBe("simple");
    const home = { root: { props: {} }, content: [{ type: "stack", props: { id: "s", items: [] } }] };
    const out = validateDesign({ ...defaultDesign(), preset: null, legacy_home: home }).design;
    expect(out.preset).toBeNull();
    expect(usesLegacyHome(out)).toBe(true);
    expect(usesLegacyHome(validateDesign({ ...defaultDesign(), legacy_home: home }).design)).toBe(false);
  });
});

describe("home page styles", () => {
  it("there are four, and each fits the home boxes", () => {
    expect(HOME_PRESET_IDS).toEqual(["simple", "garden", "newsletter", "index"]);
    for (const id of HOME_PRESET_IDS) {
      const boxes = applyHomePreset(defaultBoxes(), id);
      expect(boxes["home.list"].length).toBeLessThanOrEqual(8);
      expect(validateDesign({ ...defaultDesign(), preset: id, boxes }).problems).toEqual([]);
    }
  });
  it("the default is 簡單 = 筆記花園: intro; recent → topics → all by year", () => {
    const b = defaultBoxes();
    expect(b["home.hero"]?.widget).toBe("intro");
    expect(b["home.list"].map((p) => `${p.widget}/${p.variant}`)).toEqual(["recent/list", "topics/list", "all/byYear"]);
    expect(b["note.meta"]).toEqual(pick("meta", "date-reading"));
    expect(b["note.left"]?.widget).toBe("toc");
    expect(b["note.right"]?.widget).toBe("sidenotes");
    expect(b["note.end"].map((p) => p.widget)).toEqual(["backlinks", "prevnext"]);
    expect(b["tag.end"].map((p) => p.widget)).toEqual(["tagfeed"]);
    expect(b.foot.map((p) => p.widget)).toEqual(["copyright", "rss", "scheme"]);
  });
  it("garden, newsletter and index have the contents the owner chose", () => {
    const list = (id: (typeof HOME_PRESET_IDS)[number]) => HOME_PRESETS[id].list.map((p) => `${p.widget}/${p.variant}`);
    expect(HOME_PRESETS.garden.hero?.widget).toBe("intro");
    expect(list("garden")).toEqual(["topics/list", "all/maturity"]);
    expect(HOME_PRESETS.newsletter.hero?.widget).toBe("subscribe");
    expect(list("newsletter")).toEqual(["latest/card", "featured/list", "all/recent10"]);
    expect(list("index")).toEqual(["topics/list", "all/recent10"]);
  });
  it("applying a style changes only the two home boxes", () => {
    const custom: SiteBoxes = { ...defaultBoxes(), "note.left": null, foot: [] };
    const out = applyHomePreset(custom, "garden");
    expect(out["note.left"]).toBeNull();
    expect(out.foot).toEqual([]);
    expect(out["home.list"]).toHaveLength(2);
  });
});

describe("v2 → v3", () => {
  const customHome = { root: { props: {} }, content: [{ type: "stack", props: { id: "mine", bg: "none", heading: "auto", cls: "", css: "", items: [] } }] };

  it("a fresh design (default home, default frames) becomes the new default and keeps its style and date tags", () => {
    const v2 = { ...defaultDesignV2({ homeNoteId: "h", topTagId: "t" }), rev: "r1", style: { preset: "paper" as const, accent: "#b23a2a", scheme: "dark" as const } };
    v2.frames.date_tags = ["日誌"];
    const v3 = migrateV2(v2);
    expect(v3).toEqual({ ...defaultDesign(), rev: "r1", style: v2.style, date_tags: ["日誌"] });
    expect(usesLegacyHome(v3)).toBe(false);
  });
  it("a default home with no note or tag is still the default home", () => {
    expect(isDefaultHome(defaultDesignV2().home)).toBe(true);
    expect(isDefaultHome(defaultDesignV2({ homeNoteId: "a" }).home)).toBe(true);
    expect(isDefaultHome(customHome)).toBe(false);
  });
  it("a default home whose note or tag was cleared (empty id) is still the default home", () => {
    const cleared = defaultDesignV2({ homeNoteId: "a", topTagId: "t" }).home;
    for (const c of cleared.content) (c.props.items as Array<{ props: Record<string, unknown> }>)[0]!.props[c.props.id === "default-cover" ? "noteId" : "tagId"] = "";
    expect(isDefaultHome(cleared)).toBe(true);
    const v3 = migrateV2({ ...defaultDesignV2(), home: cleared });
    expect(usesLegacyHome(v3)).toBe(false);
  });
  it("a hidden date stays hidden whatever else the info line shows", () => {
    const meta = (date: boolean, readingTime: boolean, tags: boolean) => {
      const v2 = defaultDesignV2({ homeNoteId: "h" });
      v2.frames = { ...defaultFrames(), article: { ...defaultFrames().article, date, readingTime, tags, toc: false } };
      return migrateV2(v2).boxes["note.meta"];
    };
    expect(meta(false, true, true)).toEqual(pick("meta", "reading-tags"));
    expect(meta(false, false, true)).toEqual(pick("meta", "tags"));
    expect(meta(false, true, false)).toEqual(pick("meta", "reading"));
    expect(meta(false, false, false)).toBeNull();
    expect(meta(true, true, true)).toEqual(pick("meta", "all"));
    expect(meta(true, false, true)).toEqual(pick("meta", "date-tags"));
    expect(meta(true, true, false)).toEqual(pick("meta", "date-reading"));
  });
  it("frame switches become box contents", () => {
    const v2 = defaultDesignV2({ homeNoteId: "h" });
    v2.frames = {
      ...defaultFrames(),
      article: { ...defaultFrames().article, toc: false, tree: true, backlinks: false, prevnext: true, date: true, tags: false, readingTime: false, footer: false, cover: false },
      tag: { ...defaultFrames().tag, description: false },
    };
    const b = migrateV2(v2).boxes;
    expect(b["note.left"]).toEqual(pick("tree", "tree"));
    expect(b["note.right"]).toBeNull();
    expect(b["note.end"]).toEqual([pick("prevnext", "links")]);
    expect(b["note.meta"]).toEqual(pick("meta", "date-reading"));
    expect(b["tag.desc"]).toBeNull();
    expect(b["tag.list"]).toEqual(pick("tagnotes", "view"));
    expect(migrateV2(v2).reading.cover).toBe(false);
    // The tag page's footer switch is still on, so the foot stays.
    expect(b.foot.map((p) => p.widget)).toEqual(["copyright", "rss"]);
  });
  it("tree and toc together: tree on the left, toc on the right", () => {
    const v2 = defaultDesignV2({ homeNoteId: "h" });
    v2.frames = { ...defaultFrames(), article: { ...defaultFrames().article, tree: true, toc: true } };
    const b = migrateV2(v2).boxes;
    expect([b["note.left"]?.widget, b["note.right"]?.widget]).toEqual(["tree", "toc"]);
  });
  it("the header and the foot go only when both pages had them off", () => {
    const v2 = defaultDesignV2({ homeNoteId: "h" });
    v2.frames = { ...defaultFrames(), article: { ...defaultFrames().article, nav: false, footer: false }, tag: { ...defaultFrames().tag, nav: false, footer: false } };
    const b = migrateV2(v2).boxes;
    expect(b.header).toBeNull();
    expect(b.foot).toEqual([]);
  });
  it("a home page the owner changed stays as legacy_home and is drawn until a home page style is chosen", () => {
    const v2 = { ...defaultDesignV2(), home: customHome };
    const v3 = migrateV2(v2);
    expect(v3.legacy_home).toEqual(customHome);
    expect(v3.preset).toBeNull();
    expect(usesLegacyHome(v3)).toBe(true);
    // Choosing a style is only setting `preset`; the old page stays stored.
    expect(usesLegacyHome({ ...v3, preset: "garden" })).toBe(false);
  });
  it("validateDesign takes a stored v2 chrome through the same move", () => {
    const stored = { ...defaultDesignV2(), home: customHome, rev: "x" };
    const out = validateDesign(stored).design;
    expect(out.v).toBe(3);
    expect(out.rev).toBe("x");
    expect(out.legacy_home?.content[0]?.props.id).toBe("mine");
  });
  it("junk in a v2 chrome is cleaned before it moves", () => {
    const out = validateDesign({ v: 2, home: { content: [{ type: "bogus", props: { id: "z" } }] }, style: { preset: "nope", accent: "red" } }).design;
    expect(out.style.preset).toBe("quiet");
    expect(out.legacy_home).toBeNull();
  });
});

describe("the studio bridge", () => {
  it("opens on legacy_home, or the v2 default home when there is none", () => {
    expect(legacyDesignOf(defaultDesign(), { homeNoteId: "h" }).home.content[0]!.type).toBe("cover");
    const home = { root: { props: {} }, content: [{ type: "stack", props: { id: "mine", items: [] } }] };
    expect(legacyDesignOf({ ...defaultDesign(), legacy_home: home }).home).toEqual(home);
  });
  it("saving a changed home page makes it the one that is drawn; saving only style does not", () => {
    const design = defaultDesign();
    const studio = legacyDesignOf(design, { homeNoteId: "h" });
    const styled = withLegacyDesign(design, { ...studio, style: { ...studio.style, accent: "#b23a2a" } });
    expect(styled.style.accent).toBe("#b23a2a");
    expect(styled.preset).toBe("simple");
    const home = { root: { props: {} }, content: [{ type: "stack", props: { id: "mine", items: [] } }] };
    const edited = withLegacyDesign(design, { ...studio, home });
    expect(edited.preset).toBeNull();
    expect(usesLegacyHome(edited)).toBe(true);
  });
});
