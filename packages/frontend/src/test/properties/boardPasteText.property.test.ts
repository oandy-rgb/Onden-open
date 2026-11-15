// Random pasted text through the board's text → card rule (lib/boardClipboard cardFromText).
//
//   1 no pasted character is lost: every non-blank character of the text is in the title or the body
//   2 the title is one short line (at most PASTED_TITLE_MAX UTF-16 units, the ellipsis included)
//   3 text that is only blank gives no card
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/boardPasteText.property.test.ts

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { cardFromText } from "../../lib/boardClipboard";

// The longest title a pasted paragraph gets (lib/boardClipboard), in UTF-16 units.
const PASTED_TITLE_MAX = 80;
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

const run = { seed: PROPS_SEED, numRuns: PROPS_RUNS };
const word = fc.stringMatching(/^[A-Za-z0-9一-鿿]{1,12}$/);
// Lines of words; some are very long (a copied paragraph has no line break), some are blank.
const line = fc.oneof(
  fc.array(word, { minLength: 0, maxLength: 4 }).map((w) => w.join(" ")),
  fc.array(word, { minLength: 30, maxLength: 120 }).map((w) => w.join(" ")),
);
const text = fc.array(line, { minLength: 1, maxLength: 6 }).map((lines) => lines.join("\n"));

describe("pasting text on a board", () => {
  it("keeps every pasted word and gives a short title", () => {
    fc.assert(fc.property(text, (pasted) => {
      const card = cardFromText(pasted);
      if (!card) { expect(pasted.trim()).toBe(""); return; }
      expect(card.title.length).toBeLessThanOrEqual(PASTED_TITLE_MAX);
      expect(card.title).not.toContain("\n");
      const kept = `${card.title}\n${card.markdown}`;
      for (const piece of pasted.split(/\s+/).filter(Boolean)) {
        // A leading heading mark or bullet is dropped from the title on purpose.
        expect(kept).toContain(piece);
      }
    }), run);
  });

  it("scan 08 #9: a 700-character paragraph pasted whole is a short title over the whole paragraph", () => {
    const paragraph = "Lorem ipsum dolor sit amet ".repeat(26).trim();
    const card = cardFromText(paragraph);
    expect(card?.markdown).toBe(paragraph);
    expect(card!.title.length).toBeLessThanOrEqual(PASTED_TITLE_MAX);
  });
});
