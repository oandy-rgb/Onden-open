// Random edit sequences against blockHistory (lib/history/blockHistory.ts).
// A note is a list of paragraphs, each given a number of its own so every
// wording is distinct; a save edits one, inserts, deletes or moves one. After
// the saves, the history of a paragraph of the final text is read.
//
// Invariants:
//   latest    the last entry is the paragraph's text now
//   adjacent  no two neighbours have the same text
//   known     every entry's text is a paragraph of the final text or of a save
//   newest    only the last entry is current
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npm run test:props -- blockHistory

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { blockHistory, type BlockSourceVersion } from "../../lib/history";
import { splitParagraphs } from "@onden/markdown";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

type Edit =
  | { kind: "edit"; at: number; word: string }
  | { kind: "insert"; at: number; word: string }
  | { kind: "delete"; at: number }
  | { kind: "move"; from: number; to: number };

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
const word = fc.constantFrom(...WORDS);
const edit: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({ kind: fc.constant("edit" as const), at: fc.nat(9), word }),
  fc.record({ kind: fc.constant("insert" as const), at: fc.nat(9), word }),
  fc.record({ kind: fc.constant("delete" as const), at: fc.nat(9) }),
  fc.record({ kind: fc.constant("move" as const), from: fc.nat(9), to: fc.nat(9) }),
);

function apply(paragraphs: string[], e: Edit, serial: number): string[] {
  const next = [...paragraphs];
  const i = next.length ? e.kind === "move" ? e.from % next.length : (e as { at: number }).at % next.length : 0;
  switch (e.kind) {
    case "edit": if (next.length) next[i] = `${next[i]} ${e.word}`; break;
    case "insert": next.splice(i, 0, `fresh ${e.word} number ${serial} written here`); break;
    case "delete": if (next.length > 1) next.splice(i, 1); break;
    case "move": if (next.length > 1) { const [p] = next.splice(i, 1); next.splice(e.to % (next.length + 1), 0, p); } break;
  }
  return next;
}

describe("blockHistory properties", () => {
  it(`ends at the paragraph's text now (seed ${PROPS_SEED}, ${PROPS_RUNS} runs)`, () => {
    fc.assert(
      fc.property(
        fc.array(edit, { minLength: 1, maxLength: 14 }),
        fc.boolean(),
        fc.nat(20),
        (edits, crlf, pick) => {
          let paragraphs = ["the first paragraph of this note", "a second one follows here", "and a third closes it"];
          const saves: string[] = [];
          edits.forEach((e, k) => { paragraphs = apply(paragraphs, e, k); saves.push(paragraphs.join("\n\n")); });
          const eol = crlf ? "\r\n" : "\n";
          const rows: BlockSourceVersion[] = saves
            .map((markdown, k) => ({ id: `v${k}`, markdown: markdown.replace(/\n/g, eol), changed_at: "2026-10-01T00:00:00Z", actor_name: null, actor_type: null }))
            .reverse();
          const now = saves[saves.length - 1];
          const list = splitParagraphs(now);
          const target = list[pick % list.length];
          const history = blockHistory(rows, { markdown: now.replace(/\n/g, eol), offset: now.slice(0, target.start).replace(/\n/g, eol).length });

          expect(history.at(-1)!.text, "latest").toBe(target.body);
          expect(history.at(-1)!.current).toBe(true);
          history.forEach((entry, i) => {
            if (i > 0) expect(entry.text, "adjacent").not.toBe(history[i - 1].text);
            if (i < history.length - 1) expect(entry.current, "newest").toBe(false);
          });
          const known = new Set([...saves, now].flatMap((s) => splitParagraphs(s).map((p) => p.body)));
          for (const entry of history) expect(known.has(entry.text), "known").toBe(true);
        },
      ),
      { seed: PROPS_SEED, numRuns: PROPS_RUNS },
    );
  });
});
