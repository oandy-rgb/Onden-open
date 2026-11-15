import { describe, expect, it } from "vitest";
import { defaultDesignV2 } from "./defaults.js";
import { expandPattern, patternDefaultSlots } from "./patterns.js";
import { PATTERNS, PATTERN_TYPES, kindOf, partTypeOf, slotsOf, usedSlots } from "./registry.js";
import { validateDesignV2 } from "./validate.js";
import { walkHome } from "./walk.js";

describe("walkHome", () => {
  it("visits every component with depth, parent and slot, parents first", () => {
    const home = {
      root: { props: {} },
      content: [
        { type: "sidebar", props: { id: "sb", aside: [{ type: "note", props: { id: "n1" } }], main: [{ type: "stack", props: { id: "st", items: [{ type: "timeline", props: { id: "tl" } }] } }] } },
        { type: "cards", props: { id: "cd", items: [] } },
      ],
    };
    const seen: string[] = [];
    walkHome(home, (c, i) => seen.push(`${c.props.id}:${i.depth}:${i.parent?.props.id ?? "-"}:${i.slot ?? "-"}`));
    expect(seen).toEqual(["sb:1:-:-", "n1:2:sb:aside", "st:2:sb:main", "tl:3:st:items", "cd:1:-:-"]);
  });
  it("ignores props that are not slots of the type", () => {
    const seen: string[] = [];
    walkHome({ root: { props: {} }, content: [{ type: "note", props: { id: "n", items: [{ type: "note", props: { id: "x" } }] } }] }, (c) => seen.push(String(c.props.id)));
    expect(seen).toEqual(["n"]);
  });
});

describe("defaultDesignV2", () => {
  it("is a cover with the home note's first paragraph, then a list of the top tag", () => {
    const d = defaultDesignV2({ homeNoteId: "home", topTagId: "tag" });
    expect(d.home.content.map((c) => c.type)).toEqual(["cover", "stack"]);
    const cover = (d.home.content[0]!.props.items as Array<{ type: string; props: Record<string, unknown> }>)[0]!;
    expect(cover).toMatchObject({ type: "note", props: { noteId: "home", display: "first" } });
    const list = (d.home.content[1]!.props.items as Array<{ type: string; props: Record<string, unknown> }>)[0]!;
    expect(list).toMatchObject({ type: "tag_view", props: { tagId: "tag", viewKind: "list" } });
    expect(d.style.preset).toBe("quiet");
  });
  it("leaves a block out when its note or tag is missing", () => {
    expect(defaultDesignV2({ homeNoteId: "h" }).home.content.map((c) => c.type)).toEqual(["cover"]);
    expect(defaultDesignV2({ topTagId: "t" }).home.content.map((c) => c.type)).toEqual(["stack"]);
    expect(defaultDesignV2().home.content).toEqual([]);
  });
  it("passes its own validation unchanged", () => {
    const d = defaultDesignV2({ homeNoteId: "h", topTagId: "t" });
    const result = validateDesignV2(d);
    expect(result.problems).toEqual([]);
    expect(result.design).toEqual(d);
  });
});

describe("registry and patterns", () => {
  it("classifies types and their slots", () => {
    expect(kindOf("stack")).toBe("part");
    expect(kindOf("note")).toBe("content");
    expect(kindOf("pattern_timeline")).toBe("pattern");
    expect(kindOf("x")).toBeNull();
    expect(slotsOf("sidebar")).toEqual(["aside", "main"]);
    expect(slotsOf("switcher")).toEqual(["a", "b", "c", "d"]);
    expect(slotsOf("note")).toEqual([]);
    expect(usedSlots("switcher", { count: 3 })).toEqual(["a", "b", "c"]);
    expect(partTypeOf("pattern_three_entries")).toBe("switcher");
  });
  it("every pattern pre-fills only slots its root part has, with content", () => {
    for (const type of PATTERN_TYPES) {
      const def = PATTERNS[type];
      for (const slot of Object.keys(def.slots)) expect(slotsOf(type)).toContain(slot);
      for (const list of Object.values(def.slots)) for (const item of list) expect(kindOf(item.type)).toBe("content");
    }
  });
  it("a pattern's default design validates unchanged and expands to its part", () => {
    for (const type of PATTERN_TYPES) {
      const component = { type, props: { id: "p", bg: "none", heading: "auto", cls: "", css: "", ...PATTERNS[type].props, ...patternDefaultSlots(type, "p") } };
      const { design, problems } = validateDesignV2({ v: 2, home: { root: { props: {} }, content: [component] } });
      expect(problems).toEqual([]);
      expect(design.home.content[0]!.type).toBe(type);
      const expanded = expandPattern(design.home.content[0]!);
      expect(expanded.type).toBe(PATTERNS[type].expandsTo);
      expect(expanded.props.id).toBe("p");
      expect(validateDesignV2({ v: 2, home: { root: { props: {} }, content: [expanded] } }).problems).toEqual([]);
    }
  });
});
