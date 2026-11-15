import { describe, expect, it } from "vitest";
import { defaultDesignV2 } from "./defaults.js";
import type { PuckComponentData } from "./design.js";
import { COMPONENTS_MAX, allowedAt } from "./registry.js";
import { validateDesignV2 } from "./validate.js";
import { walkHome } from "./walk.js";

const c = (type: string, props: Record<string, unknown> = {}): PuckComponentData => ({ type, props: { id: `${type}-x${Math.random().toString(36).slice(2, 7)}`, ...props } });
const design = (content: unknown[], extra: Record<string, unknown> = {}) => ({ v: 2, home: { root: { props: {} }, content }, ...extra });
const top = (input: unknown) => validateDesignV2(input).design.home.content;
const types = (list: PuckComponentData[]) => list.map((x) => x.type);

describe("validateDesignV2: whole design", () => {
  it.each([[null], [undefined], ["x"], [{}], [{ v: 1, home: {} }], [{ v: 3 }], [[]]])("%j is not a v2 design: the default design comes back", (input) => {
    const result = validateDesignV2(input, { homeNoteId: "n", topTagId: "t" });
    expect(result.design).toEqual(defaultDesignV2({ homeNoteId: "n", topTagId: "t" }));
    expect(result.problems).toHaveLength(1);
  });

  it("never throws on hostile input", () => {
    const cyc: Record<string, unknown> = { v: 2 };
    cyc.home = { content: [{ type: "stack", props: { id: "a", items: [null, 3, "x", { type: 5 }, { type: "stack" }] } }, null] };
    expect(() => validateDesignV2(cyc)).not.toThrow();
    expect(() => validateDesignV2({ v: 2, home: { content: "no" }, style: 7, frames: [], css: 5 })).not.toThrow();
  });

  it("keeps a valid design as it is", () => {
    const input = design([c("stack", { id: "s1", bg: "tint", heading: "none", cls: "a b", css: "& p { color: red }", items: [c("note", { id: "n1", noteId: "x", blockId: "q1", display: "card" })] })], { rev: "r7" });
    const { design: out, problems } = validateDesignV2(input);
    expect(problems).toEqual([]);
    expect(out.rev).toBe("r7");
    expect(out.studio_draft).toBe(true);
    expect(out.home.content[0]!.props).toMatchObject({ id: "s1", bg: "tint", heading: "none", cls: "a b", css: "& p { color: red }" });
    expect(validateDesignV2(out).design).toEqual(out);
  });
});

describe("validateDesignV2: components", () => {
  it("drops unknown component types, unknown props and reports them", () => {
    const { design: out, problems } = validateDesignV2(design([c("carousel"), c("stack", { items: [c("video"), c("note", { noteId: "n", onclick: "x()" })] })]));
    expect(types(out.home.content)).toEqual(["stack"]);
    const note = (out.home.content[0]!.props.items as PuckComponentData[])[0]!;
    expect(note.type).toBe("note");
    expect(note.props).not.toHaveProperty("onclick");
    expect(problems.join("\n")).toMatch(/carousel/);
    expect(problems.join("\n")).toMatch(/video/);
    expect(problems.join("\n")).toMatch(/onclick/);
  });

  it("clamps enums, numbers and strings", () => {
    const out = top(design([
      c("switcher", { count: 9, bg: "red", cls: "ok<script> x_1!", css: "a".repeat(4001) }),
      c("switcher", { count: 0 }),
      c("switcher", { count: "3" }),
      c("stack", { items: [c("tag_view", { limit: 99, viewKind: "kanban", sort: "random" }), c("tag_view", { limit: -4 }), c("timeline", { limit: 2.6 })] }),
    ]));
    expect(out[0]!.props).toMatchObject({ count: 4, bg: "none", cls: "okscript x_1", css: "" });
    expect(out[1]!.props.count).toBe(2);
    expect(out[2]!.props.count).toBe(2);
    const [a, b, t] = out[3]!.props.items as PuckComponentData[];
    expect(a!.props).toMatchObject({ limit: 12, viewKind: "list", sort: "new" });
    expect(b!.props.limit).toBe(1);
    expect(t!.props.limit).toBe(3);
  });

  it("cuts class names to 60 characters of [A-Za-z0-9_ -]", () => {
    const [s] = top(design([c("stack", { cls: "é ".repeat(10) + "x".repeat(100) })]));
    expect(s!.props.cls).toMatch(/^[A-Za-z0-9_ -]{1,60}$/);
    expect(s!.props.cls).toHaveLength(60);
  });

  it("block ids: a caret is accepted and removed, junk is dropped", () => {
    const [s] = top(design([c("stack", { items: [c("note", { blockId: "^abc-1" }), c("note", { blockId: "has space" })] })]));
    const [a, b] = s!.props.items as PuckComponentData[];
    expect(a!.props.blockId).toBe("abc-1");
    expect(b!.props.blockId).toBe("");
  });

  it("repairs missing, bad and repeated ids", () => {
    const out = top(design([{ type: "stack", props: { id: "dup", items: [] } }, { type: "stack", props: { id: "dup", items: [] } }, { type: "stack", props: { id: 'a"b', items: [] } }, { type: "stack" }]));
    const ids = out.map((x) => x.props.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids[0]).toBe("dup");
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("switcher: only the first `count` slots are used", () => {
    const [s] = top(design([c("switcher", { count: 2, a: [c("note")], b: [c("note")], c: [c("note")], d: [c("note")] })]));
    expect((s!.props.a as unknown[]).length).toBe(1);
    expect((s!.props.b as unknown[]).length).toBe(1);
    expect(s!.props.c).toEqual([]);
    expect(s!.props.d).toEqual([]);
  });

  it("a part's slots are always arrays", () => {
    const [s] = top(design([c("sidebar", { aside: "no" })]));
    expect(s!.props.aside).toEqual([]);
    expect(s!.props.main).toEqual([]);
  });
});

describe("validateDesignV2: nesting rules", () => {
  it("top level: content stays where it is, with no stack around it", () => {
    const { design: out, problems } = validateDesignV2(design([c("note", { id: "n1", noteId: "x" }), c("tag_view"), c("timeline"), c("stack")]));
    expect(types(out.home.content)).toEqual(["note", "tag_view", "timeline", "stack"]);
    expect(out.home.content[0]!.props.id).toBe("n1");
    expect(problems.filter((p) => /stack/.test(p))).toEqual([]);
    expect(new Set(out.home.content.map((x) => x.props.id)).size).toBe(4);
    expect(validateDesignV2(out).design).toEqual(out);
  });

  it("top level accepts every part and every pattern", () => {
    const names = ["stack", "sidebar", "switcher", "cards", "cover", "center", "pattern_intro_now", "pattern_work_cards", "pattern_three_entries", "pattern_timeline"];
    expect(types(top(design(names.map((n) => c(n)))))).toEqual(names);
  });

  it("inner parts are only stack, cards and switcher", () => {
    const [s] = top(design([c("stack", { items: [c("stack"), c("cards"), c("switcher"), c("sidebar"), c("cover"), c("center"), c("pattern_timeline")] })]));
    expect(types(s!.props.items as PuckComponentData[])).toEqual(["stack", "cards", "switcher"]);
  });

  it("inner parts hold content only (at most 3 levels counting content)", () => {
    const deep = c("stack", { items: [c("stack", { items: [c("stack", { items: [c("note")] }), c("cards", { items: [c("note"), c("stack")] }), c("note")] })] });
    const [s] = top(design([deep]));
    const inner = (s!.props.items as PuckComponentData[])[0]!;
    expect(types(inner.props.items as PuckComponentData[])).toEqual(["note"]);
    let maxDepth = 0;
    walkHome(validateDesignV2(design([deep])).design.home, (_, i) => (maxDepth = Math.max(maxDepth, i.depth)));
    expect(maxDepth).toBe(3);
  });

  it("a pattern holds content only, and content holds nothing", () => {
    const [p] = top(design([c("pattern_intro_now", { aside: [c("note"), c("stack")], main: [c("tag_view", { items: [c("note")] })] })]));
    expect(types(p!.props.aside as PuckComponentData[])).toEqual(["note"]);
    const tv = (p!.props.main as PuckComponentData[])[0]!;
    expect(tv.props).not.toHaveProperty("items");
  });

  it("caps the number of components", () => {
    const many = Array.from({ length: COMPONENTS_MAX + 50 }, () => c("stack"));
    const { design: out, problems } = validateDesignV2(design(many));
    expect(out.home.content).toHaveLength(COMPONENTS_MAX);
    expect(problems.some((p) => /more than/.test(p))).toBe(true);
    let n = 0;
    walkHome(out.home, () => n++);
    expect(n).toBeLessThanOrEqual(COMPONENTS_MAX);
  });
});

describe("validateDesignV2: style, css, frames", () => {
  it("fills a missing style with 安靜, the first accent and the visitor's scheme; keeps a valid one", () => {
    const quiet = { preset: "quiet", accent: "#3f7d6e", scheme: "system" };
    expect(validateDesignV2(design([])).design.style).toEqual(quiet);
    const style = { preset: "folio", accent: "#2A5BD7", scheme: "dark" };
    expect(validateDesignV2(design([], { style })).design.style).toEqual({ preset: "folio", accent: "#2a5bd7", scheme: "dark" });
  });

  it("converts the old style: preset name and accent stay, the rest is dropped", () => {
    const old = { preset: "paper", base: 19, ratio: 1.414, density: "loose", head: "mono", body: "sans", accent: "#b23a2a", radius: 12 };
    expect(validateDesignV2(design([], { style: old })).design.style).toEqual({ preset: "paper", accent: "#b23a2a", scheme: "system" });
    // Edited by hand in the old panel (preset null) or an unknown name: 安靜, accent kept.
    expect(validateDesignV2(design([], { style: { ...old, preset: null } })).design.style).toEqual({ preset: "quiet", accent: "#b23a2a", scheme: "system" });
    expect(validateDesignV2(design([], { style: { ...old, preset: "nope" } })).design.style.preset).toBe("quiet");
    const converted = validateDesignV2(design([], { style: old })).design.style;
    for (const dropped of ["base", "ratio", "density", "head", "body", "radius"]) expect(converted).not.toHaveProperty(dropped);
  });

  it("falls back on a bad scheme or colour (and reports the colour)", () => {
    const { design: out, problems } = validateDesignV2(design([], { style: { preset: "hand", scheme: "sepia", accent: "red" } }));
    expect(out.style).toEqual({ preset: "hand", accent: "#3f7d6e", scheme: "system" });
    expect(problems.join()).toMatch(/style\.accent/);
  });

  it("keeps site CSS but reports unbalanced braces, drops it over the cap", () => {
    expect(validateDesignV2(design([], { css: "a { b: c }" })).problems).toEqual([]);
    const bad = validateDesignV2(design([], { css: "a { b: c" }));
    expect(bad.design.css).toBe("a { b: c");
    expect(bad.problems.join()).toMatch(/braces/);
    expect(validateDesignV2(design([], { css: "x".repeat(50_001) })).design.css).toBe("");
  });

  it("frames: known keys only, booleans only, date tags default to 文章", () => {
    const { frames } = validateDesignV2(design([], { frames: { article: { toc: false, nav: "yes", evil: true }, tag: { footer: false }, date_tags: [" 日誌 ", "", 5, "日誌"] } })).design;
    expect(frames.article.toc).toBe(false);
    expect(frames.article.nav).toBe(true);
    expect(frames.article).not.toHaveProperty("evil");
    expect(frames.tag.footer).toBe(false);
    expect(frames.date_tags).toEqual(["日誌"]);
    expect(validateDesignV2(design([])).design.frames.date_tags).toEqual(["文章"]);
  });

  it("frames: link previews and reading time are on unless the owner turned them off (also for a design saved before they existed)", () => {
    expect(validateDesignV2(design([], { frames: { article: { toc: false } } })).design.frames.article).toMatchObject({ preview: true, readingTime: true });
    expect(validateDesignV2(design([], { frames: { article: { preview: false, readingTime: false } } })).design.frames.article).toMatchObject({ preview: false, readingTime: false });
  });
});

describe("allowedAt (the one nesting rule)", () => {
  it("top level takes parts and patterns, never content", () => {
    expect(allowedAt("top", "stack")).toBe(true);
    expect(allowedAt("top", "note")).toBe(true);
  });
  it("a top-level part's slot takes content and inner parts, not the other parts", () => {
    expect(allowedAt("outer", "note")).toBe(true);
    expect(allowedAt("outer", "stack")).toBe(true);
    expect(allowedAt("outer", "sidebar")).toBe(false);
  });
  it("an inner part's slot takes content only", () => {
    expect(allowedAt("inner", "note")).toBe(true);
    expect(allowedAt("inner", "stack")).toBe(false);
  });
});
