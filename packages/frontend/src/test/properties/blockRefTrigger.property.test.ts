// Random text before the caret against the `((` trigger (lib/editorCompletion
// detectPopupTrigger, popupBlockedAt).
//
// Invariants:
//   opens     `((words` (or `!((words`) after ordinary text opens the paragraph
//             popup with those words; the marker is where the `!` / `((` starts
//   closes    a `)` after the words ends it
//   code      a closed inline code span holds the caret in code (popupBlockedAt)
//   fence     a fence opened on an earlier line and not closed holds the caret
//             in code; a closed one does not
//   exclusive no other popup claims `((words`
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/blockRefTrigger

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { detectPopupTrigger, popupBlockedAt } from "../../lib/editorCompletion";
import { stateOf } from "../helpers/editorState";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const config = { seed: PROPS_SEED, numRuns: PROPS_RUNS };
// No character that starts another popup or changes what a `((` means.
const plain = (chars: string) => fc.array(fc.constantFrom(...chars), { maxLength: 12 }).map((cs) => cs.join(""));
const before = plain("abc xyz，。的字 0189-_.:;?");
const words = plain("abc xyz搜尋段落 0189-_");

describe("(( trigger", () => {
  it("opens with the typed words, and `!` makes the marker start there", () => {
    fc.assert(fc.property(before, fc.boolean(), words, (lead, embed, typed) => {
      const text = `${lead}${embed ? "!" : ""}((${typed}`;
      expect(detectPopupTrigger(text)).toEqual({ type: "blockref", query: typed, markerIndex: lead.length });
    }), config);
  });

  it("ends at a `)` or a newline's worth of other text", () => {
    fc.assert(fc.property(before, words, words, (lead, typed, after) => {
      expect(detectPopupTrigger(`${lead}((${typed})${after}`)?.type).not.toBe("blockref");
    }), config);
  });

  it("opens nothing inside inline code", () => {
    fc.assert(fc.property(before, words, (lead, typed) => {
      const inside = `${lead}\`code ((${typed}\``;
      expect(popupBlockedAt(stateOf(inside), inside.length - 1)).toBe(true);
      const outside = `\`a\` ${lead}((${typed}`;
      expect(popupBlockedAt(stateOf(outside), outside.length)).toBe(false);
      expect(detectPopupTrigger(`\`a\` ${lead}((${typed}`)?.type).toBe("blockref");
    }), config);
  });

  it("a fence still open holds the caret in code, a closed one does not", () => {
    const body = plain("abc 0189 ((");
    fc.assert(fc.property(fc.constantFrom("```", "~~~~", "````"), body, body, (fence, inside, outside) => {
      const marker = fence[0]!.repeat(fence.length);
      const open = `intro\n${fence}js\n${inside}`;
      expect(popupBlockedAt(stateOf(open), open.length)).toBe(true);
      // Not indented: four leading spaces after a closed fence are an indented code block.
      const closed = `intro\n${fence}\n${inside}\n${marker}\nt${outside.trimStart()}`;
      expect(popupBlockedAt(stateOf(closed), closed.length)).toBe(false);
    }), config);
  });
});
