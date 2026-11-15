import { describe, expect, it } from "vitest";
import { defaultDesign, defaultDesignV2, validateDesign, walkHome, type PuckComponentData, type PuckData, type SiteDesignV2 } from "@onden/site";
import {
  designForSave, designFromChrome, findComponent, homeComponentIds, insertAfter, isDesignChrome, nestingViolation,
  removeComponent, updateProps,
} from "./designModel";

const part = (type: string, id: string, extra: Record<string, unknown> = {}): PuckComponentData => ({ type, props: { id, bg: "none", heading: "auto", cls: "", css: "", ...extra } });
const note = (id: string, noteId = "n1"): PuckComponentData => ({ type: "note", props: { id, noteId, blockId: "", display: "full" } });
const home = (...content: PuckComponentData[]): PuckData => ({ root: { props: {} }, content });

describe("designFromChrome", () => {
  it("an older design with a stack around its content opens as stored (not taken apart)", () => {
    const stack = part("stack", "s1", { items: [note("n1")] });
    const chrome = { ...defaultDesignV2({}), home: { root: { props: {} }, content: [stack] } };
    const { design } = designFromChrome(chrome, {});
    expect(design.home.content).toEqual([stack]);
    expect(designForSave(chrome, design).legacy_home).toEqual(design.home);
  });
  it("a chrome that is not v2 (the old studio's blocks, or none) starts from the default design", () => {
    const inputs = { homeNoteId: "home", topTagId: "tag" };
    for (const chrome of [null, undefined, {}, { blocks: [{ id: "a", type: "hero" }], studio_draft: true, rev: "r" }, { v: 1, blocks: [] }]) {
      const { design, saved } = designFromChrome(chrome, inputs);
      expect(saved).toBe(false);
      expect(design).toEqual(defaultDesignV2(inputs));
    }
  });
  it("a v2 chrome is kept (cleaned by validateDesign), with its revision", () => {
    const chrome = { ...defaultDesignV2({ homeNoteId: "home" }), rev: "rev-7" };
    const { design, saved } = designFromChrome(chrome, { homeNoteId: "home" });
    expect(saved).toBe(true);
    expect(isDesignChrome(chrome)).toBe(true);
    expect(design.rev).toBe("rev-7");
    expect(design.home.content[0]!.type).toBe("cover");
  });
});

describe("designFromChrome (v3)", () => {
  it("a v3 design opens on its free-form home page, or the default one when it has none", () => {
    const withHome = { ...defaultDesign(), preset: null, legacy_home: home(part("stack", "mine", { items: [] })), rev: "r3" };
    expect(designFromChrome(withHome, {}).design.home.content.map((c) => c.props.id)).toEqual(["mine"]);
    expect(designFromChrome(withHome, {}).design.rev).toBe("r3");
    expect(designFromChrome(defaultDesign(), { homeNoteId: "h" }).design.home.content[0]!.type).toBe("cover");
  });
  it("saving the studio's design keeps the boxes the owner chose and sets the free-form home page only when it changed", () => {
    const stored = { ...defaultDesign(), boxes: { ...defaultDesign().boxes, "note.left": null }, preset: "garden" as const };
    const opened = designFromChrome(stored, { homeNoteId: "h" }).design;
    const unchanged = designForSave(stored, { ...opened, css: "p { color: red }" });
    expect(unchanged.boxes["note.left"]).toBeNull();
    expect(unchanged.preset).toBe("garden");
    expect(unchanged.css).toBe("p { color: red }");
    const edited = designForSave(stored, { ...opened, home: home(part("stack", "mine", { items: [note("n")] })) });
    expect(edited.preset).toBeNull();
    expect(edited.boxes["note.left"]).toBeNull();
    expect(edited.legacy_home?.content[0]?.props.id).toBe("mine");
  });
});

describe("designForSave", () => {
  it("never returns a design validateDesign would still change", () => {
    const bad = {
      ...defaultDesignV2({}),
      home: home(part("sidebar", "s1", { aside: [part("stack", "i1", { items: [part("stack", "i2", { items: [] })] })], main: [] }), note("loose")),
      style: { ...defaultDesignV2({}).style, scheme: "sepia" as never, accent: "red" },
    } as SiteDesignV2;
    const saved = designForSave(null, bad);
    expect(validateDesign(saved).problems).toEqual([]);
    expect(saved.style).toEqual({ preset: "quiet", accent: "#3f7d6e", scheme: "system" });
    // content on the top level stays, the too-deep part is dropped
    expect(saved.legacy_home?.content.map((c) => c.type)).toEqual(["sidebar", "note"]);
  });
});

describe("nestingViolation", () => {
  it("accepts the shapes the registry allows", () => {
    expect(nestingViolation(home(part("stack", "a", { items: [note("n"), part("cards", "c", { items: [note("m")] })] })))).toBeNull();
    expect(nestingViolation(home(part("sidebar", "s", { aside: [note("n")], main: [part("switcher", "w", { count: 2, a: [note("x")], b: [] , c: [], d: [] })] })))).toBeNull();
  });
  it("rejects an inner part inside an inner part, and a top-only part inside a part", () => {
    const inner = home(part("stack", "a", { items: [part("stack", "b", { items: [part("cards", "c", { items: [] })] })] }));
    expect(nestingViolation(inner)).toMatchObject({ componentId: "c", reason: "nesting" });
    const topOnly = home(part("stack", "a", { items: [part("sidebar", "b", { aside: [], main: [] })] }));
    expect(nestingViolation(topOnly)).toMatchObject({ componentId: "b", type: "sidebar" });
  });
  it("rejects a pattern in a slot and a part inside a pattern", () => {
    expect(nestingViolation(home(part("stack", "a", { items: [part("pattern_work_cards", "p", { items: [] })] })))).toMatchObject({ componentId: "p" });
    expect(nestingViolation(home(part("pattern_work_cards", "p", { items: [part("stack", "s", { items: [] })] })))).toMatchObject({ componentId: "s" });
  });
  it("content on the top level is not a violation, and stays unwrapped", () => {
    expect(nestingViolation(home(note("n"), part("stack", "a")))).toBeNull();
  });
});

describe("editing moves", () => {
  const base = home(part("stack", "a", { items: [note("n1")] }), part("cover", "c", { items: [] }));
  it("insertAfter puts a note after the selected one, with new ids", () => {
    const { home: next, inserted } = insertAfter(base, "n1", note("whatever", "n2"));
    const items = findComponent(next, "a")!.props.items as PuckComponentData[];
    expect(items.map((i) => i.props.noteId)).toEqual(["n1", "n2"]);
    expect(inserted.props.id).not.toBe("whatever");
    expect(homeComponentIds(next).size).toBe(4);
  });
  it("a part that cannot sit beside the selection goes after the closest ancestor it fits beside", () => {
    const { home: next } = insertAfter(base, "n1", part("sidebar", "x", { aside: [], main: [] }));
    expect(next.content.map((c) => c.type)).toEqual(["stack", "sidebar", "cover"]);
  });
  it("without a selection it goes to the end, and top-level content is not wrapped", () => {
    const { home: next } = insertAfter(base, null, note("x", "n9"));
    expect(next.content.map((c) => c.type)).toEqual(["stack", "cover", "note"]);
    expect(nestingViolation(next)).toBeNull();
  });
  it("a template inserted twice never repeats an id", () => {
    const template = part("pattern_three_entries", "t", { count: 3, a: [note("t-a")], b: [note("t-b")], c: [note("t-c")] });
    const once = insertAfter(base, null, template).home;
    const twice = insertAfter(once, null, template).home;
    const ids: string[] = [];
    walkHome(twice, (c) => { ids.push(c.props.id); });
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("updateProps and removeComponent leave the original alone", () => {
    const changed = updateProps(base, "n1", { noteId: "other" });
    expect(findComponent(changed, "n1")!.props.noteId).toBe("other");
    expect(findComponent(base, "n1")!.props.noteId).toBe("n1");
    expect(findComponent(removeComponent(base, "n1"), "n1")).toBeNull();
    expect(findComponent(base, "n1")).not.toBeNull();
  });
});
