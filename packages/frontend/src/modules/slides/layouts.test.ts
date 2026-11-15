import { describe, expect, it } from "vitest";
import { analyzeSlide } from "./analyze";
import { LAYOUTS, alternativeLayout, hasTable, growLevel, itemsOf, layoutSpec, sidesOf, splitStat, splitStep } from "./layouts";
import { LAYOUT_IDS, partsOf } from "./pages";

const bodyOf = (md: string) => partsOf(md, 1).parts;

describe("the layout registry", () => {
  it("has one entry for each of the twelve layouts, with a name and a sentence", () => {
    expect(LAYOUTS.map((l) => l.id)).toEqual([...LAYOUT_IDS]);
    for (const spec of LAYOUTS) { expect(spec.label).toBeTruthy(); expect(spec.blurb.endsWith(".")).toBe(true); expect(layoutSpec(spec.id)).toBe(spec); }
  });
});

describe("the pieces a layout lays out", () => {
  it("takes a list's items (a nested line stays with its item), else the lines of the text", () => {
    expect(itemsOf(analyzeSlide("- a\n  - nested\n- b"))).toEqual(["a\n  - nested", "b"]);
    expect(itemsOf(analyzeSlide("> one\n> two"))).toEqual(["one", "two"]);
  });
  it("splits a number from its words, and a time from its step", () => {
    expect(splitStat("90% of users stay")).toEqual({ figure: "90%", caption: "of users stay" });
    expect(splitStat("Fast builds")).toEqual({ figure: "Fast", caption: "builds" });
    expect(splitStep("2025 grow")).toEqual({ when: "2025", what: "grow" });
    expect(splitStep("ship it")).toEqual({ when: "", what: "ship it" });
  });
  it("cuts two sides at the second sub-heading, else the items in half", () => {
    const [l, r] = sidesOf(analyzeSlide("### A\n- a\n\n### B\n- b"));
    expect(l.map((b) => b.markdown)).toEqual(["### A", "- a"]);
    expect(r.map((b) => b.markdown)).toEqual(["### B", "- b"]);
    const [x, y] = sidesOf(analyzeSlide("- 1\n- 2\n- 3"));
    expect([x[0].markdown, y[0].markdown]).toEqual(["- 1\n- 2", "- 3"]);
  });
});

describe("放不下 step two: another layout for the same content", () => {
  it("offers bullets for the structured layouts and text for a long picture page or a quote", () => {
    const p = bodyOf("## T\n\n- a\n- b\n- c");
    for (const id of ["compare", "three", "stat", "timeline"] as const) expect(alternativeLayout(id, p)).toBe("bullets");
    expect(alternativeLayout("quote", p)).toBe("text");
    const longText = bodyOf(`## T\n\n![x](a.png)\n\n- ${"很長的一條".repeat(60)}`);
    expect(alternativeLayout("media", longText)).toBe("text");
    expect(alternativeLayout("media", bodyOf("## T\n\n![x](a.png)\n\n- short"))).toBeNull();
  });
  it("offers nothing where no other layout would help, and never cuts words", () => {
    const p = bodyOf("## T\n\n- a\n- b");
    for (const id of ["cover", "section", "text", "codeMath", "fullImage"] as const) expect(alternativeLayout(id, p)).toBeNull();
    expect(alternativeLayout("bullets", bodyOf(`## T\n\n- ${"一條很長的條列文字".repeat(8)}`))).toBe("text");
  });
});

describe("a page with a table", () => {
  const withTable = bodyOf("## T\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- x\n- y");
  it("is found by its table, and a table never makes a page grow", () => {
    expect(hasTable(withTable)).toBe(true);
    expect(hasTable(bodyOf("## T\n\n- a"))).toBe(false);
    expect(growLevel("bullets", withTable)).toBe(0);
  });
  it("offers no other layout where the table already has the full width, but still bullets from a narrow layout", () => {
    for (const id of ["bullets", "text"] as const) expect(alternativeLayout(id, withTable)).toBeNull();
    expect(alternativeLayout("compare", withTable)).toBe("bullets");
  });
  it("a picture beside the table leaves it half a page: Paragraphs is offered, which gives it the whole width", () => {
    const withPicture = bodyOf("## T\n\n![x](a.png)\n\n| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(alternativeLayout("media", withPicture)).toBe("text");
  });
  it("a page with only a table lands in Paragraphs, which no longer narrows it (SlideView)", () => {
    expect(partsOf("## T\n\n| a | b |\n| --- | --- |\n| 1 | 2 |", 1).parts.body.map((b) => b.kind)).toEqual(["table"]);
  });
});

describe("growing a slide with little on it", () => {
  const parts = (md: string) => partsOf(md, 1).parts;
  it("lifts three short lines two levels in the layouts that lay out words", () => {
    const three = parts("# T\n\n- 第一點\n- 第二點\n- 第三點");
    expect(growLevel("bullets", three)).toBe(2);
    expect(growLevel("three", three)).toBe(2);
    expect(growLevel("compare", three)).toBe(2);
    expect(growLevel("text", parts("# T\n\n一句話。"))).toBe(2);
  });
  it("lifts one level for a middling list and leaves a full one at the body size", () => {
    const line = "這是一行大約二十個字左右的條列內容說明";
    expect(growLevel("bullets", parts(`# T\n\n${[1, 2, 3, 4, 5].map((i) => `- ${line}${i}`).join("\n")}`))).toBe(1);
    expect(growLevel("bullets", parts(`# T\n\n${Array.from({ length: 9 }, (_, i) => `- ${line}${i}`).join("\n")}`))).toBe(0);
  });
  it("never grows a layout whose size is its own, or a page with a picture, code or a table", () => {
    const few = parts("# T\n\n- a\n- b");
    for (const id of ["cover", "section", "media", "quote", "stat", "timeline", "codeMath", "fullImage"] as const) expect(growLevel(id, few)).toBe(0);
    expect(growLevel("bullets", parts("# T\n\n- a\n\n```js\nx\n```"))).toBe(0);
    expect(growLevel("bullets", parts("# T"))).toBe(0);
  });
});

describe("a number or a step reads as words, not Markdown", () => {
  it("splitStat drops marks, link syntax, the task box and the task box", () => {
    expect(splitStat("**90%** of [[Users|people]] stay")).toEqual({ figure: "90%", caption: "of people stay" });
    expect(splitStat(itemsOf(analyzeSlide("- [ ] 3x faster"))[0])).toEqual({ figure: "3x", caption: "faster" });
  });

  it("splitStep does too", () => {
    expect(splitStep("**2025** [[Launch]]")).toEqual({ when: "2025", what: "Launch" });
  });
});
