import { describe, expect, it } from "vitest";
import { STEPS_TEMPLATE, expandSteps, parseSteps, usesSteps } from "./stepsBlocks.js";

describe("parseSteps", () => {
  it("splits at ## lines and keeps the intro", () => {
    const doc = parseSteps("About this.\n\n## One\nfirst\n\n## Two\nsecond\n- a\n- b");
    expect(doc.intro).toBe("About this.");
    expect(doc.steps).toEqual([{ title: "One", body: "first" }, { title: "Two", body: "second\n- a\n- b" }]);
  });

  it("does not split at a ## inside a code fence of a step", () => {
    const doc = parseSteps("## A\n```md\n## not a step\n```\n\n## B\nx");
    expect(doc.steps.map((s) => s.title)).toEqual(["A", "B"]);
    expect(doc.steps[0]!.body).toBe("```md\n## not a step\n```");
  });

  it("does not take ### or #hashtag lines as steps", () => {
    expect(parseSteps("## A\n### sub\n#tag").steps).toHaveLength(1);
  });

  it("keeps an empty step and an untitled one", () => {
    expect(parseSteps("## A\n\n## \nbody\n##").steps).toEqual([
      { title: "A", body: "" }, { title: "", body: "body" }, { title: "", body: "" },
    ]);
  });

  it("reads one step, and a text with no step as an intro only", () => {
    expect(parseSteps("## Only\nx").steps).toHaveLength(1);
    expect(parseSteps("just words")).toEqual({ intro: "just words", steps: [] });
    expect(parseSteps("")).toEqual({ intro: "", steps: [] });
  });

  it("drops closing hashes of a heading", () => {
    expect(parseSteps("## Title ##\nx").steps[0]!.title).toBe("Title");
  });
});

describe("STEPS_TEMPLATE", () => {
  it("the template parses as two steps, each with code", () => {
    const inner = STEPS_TEMPLATE.split("\n").slice(1, -2).join("\n");
    const doc = parseSteps(inner);
    expect(doc.steps).toHaveLength(2);
    expect(doc.steps[1]!.body).toContain("```js");
  });
});

describe("usesSteps / expandSteps", () => {
  const note = "# T\n\n````steps\nintro\n\n## One\n```js\nlet a;\n```\n\n## Two\nwords\n````\n\nafter";

  it("finds a steps block, and not a mention of one", () => {
    expect(usesSteps(note)).toBe(true);
    expect(usesSteps("```js\n// steps\n```")).toBe(false);
    expect(usesSteps("write ```steps in text")).toBe(false);
    expect(usesSteps("````md\n```steps\n```\n````")).toBe(false);
  });

  it("writes each step as a heading and its body", () => {
    expect(expandSteps(note)).toBe("# T\n\nintro\n\n### One\n\n```js\nlet a;\n```\n\n### Two\n\nwords\n\nafter");
  });

  it("numbers an untitled step and leaves other text alone", () => {
    expect(expandSteps("```steps\n##\nx\n```")).toBe("### 1\n\nx");
    expect(expandSteps("no block\n```js\nx\n```")).toBe("no block\n```js\nx\n```");
  });

  it("expands an unclosed block to the end", () => {
    expect(expandSteps("````steps\n## A\nx")).toBe("### A\n\nx");
  });
});
