import { describe, expect, it } from "vitest";
import { detectPopupTrigger, popupBlockedAt } from "../lib/editorCompletion";
import { stateOf } from "./helpers/editorState";

// One judgment — popupBlockedAt — decides where the six input lists (`{`, `((`,
// `[[`, `@`, `/`) may open; the editor passes it to detectPopupTrigger.
// Code (fenced, indented, inline) and formulas ($…$, $$…$$) never open one.

/** The popup the caret at the end of `doc` would open, the way MarkdownEditor asks. */
function popupAtEnd(doc: string) {
  const state = stateOf(doc);
  const line = state.doc.lineAt(doc.length);
  return detectPopupTrigger(state.doc.sliceString(line.from, doc.length), popupBlockedAt(state, doc.length))?.type ?? null;
}

const TRIGGERS: Array<[string, string]> = [
  ["blocktag", "text {wor"],
  ["blockref", "see ((par"],
  ["wikilink", "see [[no"],
  ["mention", "ask @cl"],
  ["slash", "/hea"],
];

describe("input lists open in plain text", () => {
  it.each(TRIGGERS)("%s", (type, text) => expect(popupAtEnd(text)).toBe(type));
  it("after a closed code span or formula on the same line", () => {
    expect(popupAtEnd("`a` and {wor")).toBe("blocktag");
    expect(popupAtEnd("$a$ and [[no")).toBe("wikilink");
  });
});

describe("input lists stay closed in code and formulas", () => {
  const places: Array<[string, (typed: string) => string]> = [
    ["fenced code", (x) => `intro\n\`\`\`js\n${x}`],
    ["tilde fence", (x) => `intro\n~~~\n${x}`],
    ["indented code", (x) => `intro\n\n    ${x}`],
    ["inline code", (x) => `\`${x}\``],
    ["inline math", (x) => `$${x}$`],
    ["double-dollar inline math", (x) => `$$${x}$$`],
    ["block math", (x) => `intro\n$$\n${x}`],
  ];
  for (const [place, wrap] of places) {
    for (const [type, text] of TRIGGERS) {
      // `/` only opens at the line start and `@` after a blank; the wrapping keeps
      // the typed text last on its line, which is where the caret is.
      it(`${type} in ${place}`, () => {
        const doc = wrap(text);
        const state = stateOf(doc);
        // Caret just after the typed text (before a closing `$`/backtick in the inline cases).
        const caret = doc.lastIndexOf(text) + text.length;
        const line = state.doc.lineAt(caret);
        const before = state.doc.sliceString(line.from, caret);
        const bare = before.slice(before.lastIndexOf(text));
        expect(detectPopupTrigger(bare)?.type, "the text alone opens it").toBe(type);
        expect(detectPopupTrigger(before, popupBlockedAt(state, caret))).toBeNull();
      });
    }
  }
});

describe("code spans being typed", () => {
  it("a lone backtick holds the line in code; pairs of the same length close it", () => {
    expect(popupAtEnd("`a {wor")).toBeNull();
    expect(popupAtEnd("``a`b`` and {wor")).toBe("blocktag"); // the single backtick is content of the double span
    expect(popupAtEnd("``a`b {wor")).toBeNull(); // the double span is still open
    expect(popupAtEnd("a \\` then [[no")).toBe("wikilink"); // an escaped backtick is text
    expect(popupAtEnd("`a` then @ab")).toBe("mention");
  });
});

describe("steps blocks", () => {
  it("are fenced but hold Markdown: lists open there, as in plain text", () => {
    expect(popupAtEnd("```steps\n## 第一步\nsee [[no")).toBe("wikilink");
    expect(popupAtEnd("```steps\n## 第一步\n/hea")).toBe("slash");
    expect(popupAtEnd("```js\nsee [[no")).toBeNull();
  });
});
