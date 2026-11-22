// Property tests of the note-body three-way merge (services/eventLog/bodyMerge)
// and of the undo path that reuses it (services/eventRestore/restore.ts
// revertedBody: makeInversePatch → rebuildPreEventBody → threeWayMergeBody).
//
// DB-free. Run count and seed come from PROPS_RUNS / PROPS_SEED (helpers/
// propsConfig.ts); a failure prints the seed and the shrunk counterexample.
//
// Vocabulary: threeWayMergeBody(base, ours, theirs). "ours" is the incoming
// side (the writer being saved), "theirs" is the current server body. At a
// conflict the merged body keeps ours and the conflict carries theirs.
//
// Two kinds of bodies are generated:
//  - realistic: lines drawn from a small pool, so duplicate lines are common
//    (blank lines, "---", code fences, repeated list items);
//  - unique: every base line carries its index and every inserted line is a
//    fresh tagged line, so "this line was added / deleted by that side" is
//    exact. Line-diff alignment of duplicate lines is ambiguous by nature,
//    so properties about which side changed what use unique bodies.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { threeWayMergeBody, splitLines, type BodyConflict } from "../../services/eventLog/bodyMerge.js";
import { makeInversePatch, rebuildFromUnchangedBody, rebuildPreEventBody } from "../../services/eventLog/index.js";
import { check } from "../helpers/propsConfig.js";

// ── Model ────────────────────────────────────────────────────────────────────

type Eol = "\n" | "\r\n";
type Doc = { lines: string[]; eol: Eol; final: boolean };
type Edit = { op: "insert" | "delete" | "replace" | "move"; a: number; b: number; d: number; text: string[] };

const render = ({ lines, eol, final }: Doc): string =>
  lines.join(eol) + (final && lines.length > 0 ? eol : "");

/** The lines of a rendered body, without their line ending. */
function linesOf(text: string, eol: Eol): string[] {
  if (text === "") return [];
  const parts = text.split(eol);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

const endsWithEol = (text: string) => text.endsWith("\n");

// ── Generators ───────────────────────────────────────────────────────────────

const fixedLines = [
  "", "", "---", "```", "```ts", "- [ ] todo", "- 項目", "- item", "## 備註", "# 筆記",
  "今天的會議紀錄", "TODO: follow up", "const x = 1;", "> quote",
];
const realisticLine = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...fixedLines) },
  { weight: 1, arbitrary: fc.stringMatching(/^[a-zA-Z0-9 ]{1,16}$/) },
  { weight: 1, arbitrary: fc.stringMatching(/^[一-龥，。]{1,10}$/) },
  { weight: 1, arbitrary: fc.stringMatching(/^(- |1\. |## |> )[a-z一-龥]{1,8}$/) },
);

const eol = fc.constantFrom<Eol>("\n", "\r\n");
const edit = (allowMove: boolean, line = realisticLine): fc.Arbitrary<Edit> => fc.record({
  op: fc.constantFrom(...(allowMove ? ["insert", "delete", "replace", "move"] : ["insert", "delete", "replace"]) as Edit["op"][]),
  a: fc.nat(1000), b: fc.nat(1000), d: fc.nat(1000),
  text: fc.array(line, { minLength: 1, maxLength: 3 }),
});
const edits = (allowMove: boolean, max = 3, line = realisticLine) => fc.array(edit(allowMove, line), { maxLength: max });

/** Apply edits to `lines` (positions wrap modulo the current length, so any
 *  generated edit is valid). `fresh` rewrites inserted text into unique lines. */
function applyEdits(lines: string[], list: Edit[], fresh?: (text: string) => string, relocated?: Set<string>): string[] {
  const out = [...lines];
  const removed = new Set<string>(), added = new Set<string>();
  for (const e of list) {
    const text = fresh ? e.text.map(fresh) : e.text;
    if (e.op === "insert") { out.splice(e.a % (out.length + 1), 0, ...text); text.forEach((l) => added.add(l)); continue; }
    if (out.length === 0) continue;
    const at = e.a % out.length;
    const count = 1 + (e.b % Math.min(3, out.length - at));
    if (e.op === "delete") out.splice(at, count).forEach((l) => removed.add(l));
    else if (e.op === "replace") { out.splice(at, count, ...text).forEach((l) => removed.add(l)); text.forEach((l) => added.add(l)); }
    else { const chunk = out.splice(at, count); chunk.forEach((l) => { removed.add(l); added.add(l); }); out.splice(e.d % (out.length + 1), 0, ...chunk); }
  }
  // A line this side both removed and added somewhere has been moved (or
  // deleted and typed again): its count can stay equal while its place changes.
  if (relocated) for (const l of removed) if (added.has(l)) relocated.add(l);
  return out;
}

/** Fresh unique lines for one side: "<tag>-<n>: text". */
function freshLines(tag: string): (text: string) => string {
  let n = 0;
  return (text) => `${tag}-${n++}: ${text || "blank"}`;
}

/** Index-tagged base lines, so no two are equal. */
const uniqueBase = (raw: string[]): string[] => raw.map((l, i) => (l === "" ? `<!--${i}-->` : `${l} ^${i}`));

// The other properties still give CRLF bodies a final newline: with none, the
// properties 6 and 8a have not been checked with them.
const docEnding = fc.record({ eol, final: fc.boolean() })
  .map(({ eol, final }) => ({ eol, final: eol === "\r\n" ? true : final }));
const realisticBase = fc.tuple(fc.array(realisticLine, { maxLength: 14 }), docEnding)
  .map(([lines, ending]): Doc => ({ lines, ...ending }));
const uniqueDoc = (min: number, max: number) => fc.tuple(fc.array(realisticLine, { minLength: min, maxLength: max }), docEnding)
  .map(([lines, ending]): Doc => ({ lines: uniqueBase(lines), ...ending }));

/** Edit a realistic doc: same line ending, trailing newline kept. */
const edited = (doc: Doc, list: Edit[]): string => render({ ...doc, lines: applyEdits(doc.lines, list) });

const countOf = (lines: string[]) => {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
};

const conflictLines = (c: BodyConflict, which: "incoming" | "current", e: Eol) => linesOf(c[which], e);

// ── Properties ───────────────────────────────────────────────────────────────

describe("threeWayMergeBody properties", () => {
  it("1. identity: an unchanged side leaves the other side's body, with no conflict", () => {
    check(fc.property(realisticBase, edits(true), (doc, list) => {
      const base = render(doc);
      const x = edited(doc, list);
      expect(threeWayMergeBody(base, base, x)).toEqual({ merged: x, clean: true, conflicts: [] });
      expect(threeWayMergeBody(base, x, base)).toEqual({ merged: x, clean: true, conflicts: [] });
    }));
  });

  it("2. idempotence: both sides making the same edit gives that edit, with no conflict", () => {
    check(fc.property(realisticBase, edits(true), (doc, list) => {
      const base = render(doc);
      const x = edited(doc, list);
      expect(threeWayMergeBody(base, x, x)).toEqual({ merged: x, clean: true, conflicts: [] });
    }));
  });

  it("2b. idempotence also holds when the same edit lands next to another side's different edit", () => {
    // Both sides apply `shared` to the top of the body; theirs also edits the
    // bottom. The shared change must land once.
    check(fc.property(uniqueDoc(8, 16), edits(false, 2), edits(false, 2), (doc, shared, own) => {
      const k = Math.floor(doc.lines.length / 2);
      const top = doc.lines.slice(0, k - 1);
      const gap = doc.lines[k - 1]!;
      const bottom = doc.lines.slice(k);
      const sharedTop = applyEdits(top, shared, freshLines("shared"));
      const ours = render({ ...doc, lines: [...sharedTop, gap, ...bottom] });
      const theirs = render({ ...doc, lines: [...sharedTop, gap, ...applyEdits(bottom, own, freshLines("theirs"))] });
      const r = threeWayMergeBody(render(doc), ours, theirs);
      expect(r.clean).toBe(true);
      const merged = linesOf(r.merged, doc.eol);
      for (const l of sharedTop.filter((l) => l.startsWith("shared-"))) expect(countOf(merged).get(l)).toBe(1);
    }));
  });

  it("3. no silent loss: added lines are kept or offered back; a line one side deleted and the other left alone is gone", () => {
    check(fc.property(uniqueDoc(1, 14), edits(true), edits(true), (doc, mine, theirs) => {
      const base = render(doc);
      const ours = applyEdits(doc.lines, mine, freshLines("ours"));
      const their = applyEdits(doc.lines, theirs, freshLines("theirs"));
      const r = threeWayMergeBody(base, render({ ...doc, lines: ours }), render({ ...doc, lines: their }));
      const merged = new Set(linesOf(r.merged, doc.eol));
      const kept = new Set(merged);
      for (const c of r.conflicts) for (const l of conflictLines(c, "current", doc.eol)) kept.add(l);
      const incomingOfConflicts = new Set(r.conflicts.flatMap((c) => conflictLines(c, "incoming", doc.eol)));

      // Added by ours: the incoming side always lands.
      for (const l of ours.filter((l) => l.startsWith("ours-"))) expect(merged.has(l), `ours' line ${l} was lost`).toBe(true);
      // Added by theirs: in the merged body, or in a conflict's `current`.
      for (const l of their.filter((l) => l.startsWith("theirs-"))) expect(kept.has(l), `theirs' line ${l} was lost`).toBe(true);

      // Deleted by one side, untouched by the other. A move is a delete plus
      // an insert, so a side that moved lines is not "untouched".
      const oursSet = new Set(ours);
      const theirSet = new Set(their);
      if (!theirs.some((e) => e.op === "move")) {
        for (const l of doc.lines) if (!oursSet.has(l) && theirSet.has(l)) expect(merged.has(l), `line ${l} deleted by ours came back`).toBe(false);
      }
      if (!mine.some((e) => e.op === "move")) {
        for (const l of doc.lines) {
          // Theirs' delete may lose to ours inside a conflict region (ours wins there).
          if (oursSet.has(l) && !theirSet.has(l)) expect(!merged.has(l) || incomingOfConflicts.has(l), `line ${l} deleted by theirs came back`).toBe(true);
        }
      }
    }));
  });

  it("4. no duplication: a line present k times in base, ours and theirs is not present more than k times in the result", () => {
    // One edit per side, no moves, and a line one side deleted and typed
    // again elsewhere is left out: the merge does not detect moves (4b), and
    // when several edits give the line diff equally short readings, it can
    // read an insertion as a move of a line (4c). Both are duplicates by
    // construction of the line diff, so they are examples below, not part of
    // this property.
    // A blank line may be one more than any side holds: the merge puts one between
    // two paragraphs both sides added at one point (bodyMerge.ts mergeInsertions).
    check(fc.property(realisticBase, edits(false, 1), edits(false, 1), (doc, mine, theirs) => {
      const base = render(doc);
      const relocated = new Set<string>();
      const ours = applyEdits(doc.lines, mine, undefined, relocated);
      const their = applyEdits(doc.lines, theirs, undefined, relocated);
      const r = threeWayMergeBody(base, render({ ...doc, lines: ours }), render({ ...doc, lines: their }));
      const merged = countOf(linesOf(r.merged, doc.eol));
      const b = countOf(doc.lines), o = countOf(ours), t = countOf(their);
      for (const [line, k] of b) {
        if (o.get(line) === k && t.get(line) === k && !relocated.has(line)) expect(merged.get(line) ?? 0, `line ${JSON.stringify(line)}`).toBeLessThanOrEqual(k + (line.trim() === "" ? 1 : 0));
      }
    }));
  });

  // Design limit OF THIS INNER FUNCTION, not of the product: the line merge does not detect moves. When one
  // side moves a block and the other side edits inside the lines it vacated,
  // that region is a conflict, ours' text stays there, and the moved copy
  // lands too, so the moved line appears twice. Users do not see this: writes,
  // restore and sync call mergeBody (bodyMergeMoves.ts), which since merge rule 3
  // never returns a body holding a line twice (the paragraphs are merged as units,
  // or the whole text is the conflict). The product case is a plain test in
  // bodyMergeMoves.test.ts ("lines moved by one writer while the other edited
  // their old place are not held twice") and the random property 4 in
  // bodyMergeProvenance.property.test.ts.
  it.fails("4b. KNOWN (threeWayMergeBody only): a line moved by theirs while ours edited its old spot appears twice", () => {
    const base = "one\nmoved\ntwo\nthree\nfour\nfive\n";
    const ours = "one\nmoved\nours added\ntwo\nthree\nfour\nfive\n"; // inserts between the two lines theirs vacates
    const theirs = "one\nthree\nfour\nfive\nmoved\ntwo\n";            // moves "moved" and "two" to the end
    const merged = threeWayMergeBody(base, ours, theirs).merged.split("\n");
    expect(merged.filter((l) => l === "moved").length).toBeLessThanOrEqual(1);
  });

  // Reached without anyone moving anything: theirs adds two lines above "a"
  // (one of them blank) and appends two below. The blank lines make two
  // alignments equally short, and a plain diff picked the one that reads "a"
  // as moved down. Ours only added a line under "a", which conflicted with that
  // reading, and the moved "a" landed as well. The diff now anchors on the
  // lines both sides hold once (bodyMerge.ts anchoredRuns).
  it("4c. two additions by theirs around a line, one of them blank, do not double that line", () => {
    const base = "a\n\n\n";
    const ours = "a\n## added by ours\n\n\n";
    const theirs = "> added above\n\na\n```\nadded below\n";
    const merged = threeWayMergeBody(base, ours, theirs).merged.split("\n");
    expect(merged.filter((l) => l === "a").length).toBeLessThanOrEqual(1);
  });

  // Found by PROPS_SEED=379680789. An emptied body ("") was closed with "\n"
  // like any other side, which made it one blank line; theirs' text after the
  // base's only line then landed next to that phantom line and the result held
  // a blank line more than any side had.
  it("4d. a side that empties the body does not leave a blank line behind", () => {
    const base = "1. a\n";
    const ours = "";
    const theirs = "1. a\n\n今天的會議紀錄"; // appends a blank line and a line
    const r = threeWayMergeBody(base, ours, theirs);
    expect(r).toEqual({ merged: "\n今天的會議紀錄", clean: true, conflicts: [] });
    expect(threeWayMergeBody(base, theirs, ours)).toEqual({ merged: "\n今天的會議紀錄", clean: true, conflicts: [] });
  });

  it("5. disjoint edits commute: separated edit ranges merge without conflict, in either order", () => {
    check(fc.property(uniqueDoc(7, 20), fc.nat(1000), edits(true), edits(true), (doc, cut, mine, theirs) => {
      // ours edits lines [0, k-1), theirs edits [k, n): line k-1 is untouched between.
      const k = 3 + (cut % (doc.lines.length - 5));
      const gap = doc.lines[k - 1]!;
      const oursLines = [...applyEdits(doc.lines.slice(0, k - 1), mine, freshLines("ours")), gap, ...doc.lines.slice(k)];
      const theirLines = [...doc.lines.slice(0, k - 1), gap, ...applyEdits(doc.lines.slice(k), theirs, freshLines("theirs"))];
      const base = render(doc), a = render({ ...doc, lines: oursLines }), b = render({ ...doc, lines: theirLines });
      const ab = threeWayMergeBody(base, a, b);
      const ba = threeWayMergeBody(base, b, a);
      expect(ab.conflicts, "merge(base, ours, theirs)").toEqual([]);
      expect(ba.conflicts, "merge(base, theirs, ours)").toEqual([]);
      expect(ab.merged).toBe(ba.merged);
      expect(linesOf(ab.merged, doc.eol)).toEqual([
        ...applyEdits(doc.lines.slice(0, k - 1), mine, freshLines("ours")), gap,
        ...applyEdits(doc.lines.slice(k), theirs, freshLines("theirs")),
      ]);
    }));
  });

  it("5b. a clean merge does not depend on which side is which (realistic bodies, duplicates included)", () => {
    check(fc.property(realisticBase, edits(true), edits(true), (doc, mine, theirs) => {
      const base = render(doc), a = edited(doc, mine), b = edited(doc, theirs);
      const ab = threeWayMergeBody(base, a, b);
      if (!ab.clean) return;
      const ba = threeWayMergeBody(base, b, a);
      expect(ba.clean, "reverse order stays clean").toBe(true);
      expect(ba.merged).toBe(ab.merged);
    }));
  });

  it("6. conflicts are real, cover changes from both sides, and merged + conflict text rebuilds the other order's result", () => {
    check(fc.property(uniqueDoc(1, 14), edits(false), edits(false), (doc, mine, theirs) => {
      const base = render(doc);
      const ours = applyEdits(doc.lines, mine, freshLines("ours"));
      const their = applyEdits(doc.lines, theirs, freshLines("theirs"));
      const a = render({ ...doc, lines: ours }), b = render({ ...doc, lines: their });
      const ab = threeWayMergeBody(base, a, b);
      const changedBy = (side: string[]) => {
        const s = new Set(side), bs = new Set(doc.lines);
        return new Set([...doc.lines.filter((l) => !s.has(l)), ...side.filter((l) => !bs.has(l))]);
      };
      const oursChanged = changedBy(ours), theirChanged = changedBy(their);
      for (const c of ab.conflicts) {
        expect(c.incoming).not.toBe(c.current);
        const oursSide = [...linesOf(c.base, doc.eol), ...conflictLines(c, "incoming", doc.eol)];
        const theirSide = [...linesOf(c.base, doc.eol), ...conflictLines(c, "current", doc.eol)];
        expect(oursSide.some((l) => oursChanged.has(l)), "ours changed nothing in this conflict").toBe(true);
        expect(theirSide.some((l) => theirChanged.has(l)), "theirs changed nothing in this conflict").toBe(true);
      }
      // Swap each conflict's incoming text for its current text: that is
      // what the opposite order keeps. Compared as line multisets, since a
      // conflict's position is not part of this claim.
      const ba = threeWayMergeBody(base, b, a);
      expect(ba.conflicts.length).toBe(ab.conflicts.length);
      const rebuilt = countOf(linesOf(ab.merged, doc.eol));
      const take = (l: string, by: number) => rebuilt.set(l, (rebuilt.get(l) ?? 0) + by);
      for (const c of ab.conflicts) {
        for (const l of conflictLines(c, "incoming", doc.eol)) take(l, -1);
        for (const l of conflictLines(c, "current", doc.eol)) take(l, 1);
      }
      for (const [l, n] of rebuilt) if (n === 0) rebuilt.delete(l);
      expect(rebuilt).toEqual(countOf(linesOf(ba.merged, doc.eol)));
    }));
  });

  // Metamorphic: a CRLF body merges exactly like the same body with LF, and the
  // result is that LF result with every line ending turned into CRLF.
  const toCrlf = (text: string) => text.replace(/\n/g, "\r\n");
  function crlfMatchesLf(lines: string[], final: boolean, mine: Edit[], theirs: Edit[]) {
    const lf: Doc = { lines, eol: "\n", final }, crlf: Doc = { lines, eol: "\r\n", final };
    const viaLf = threeWayMergeBody(render(lf), edited(lf, mine), edited(lf, theirs));
    const viaCrlf = threeWayMergeBody(render(crlf), edited(crlf, mine), edited(crlf, theirs));
    expect(viaCrlf.merged).toBe(toCrlf(viaLf.merged));
    expect(viaCrlf.conflicts.map((c) => [c.incoming, c.current])).toEqual(viaLf.conflicts.map((c) => [toCrlf(c.incoming), toCrlf(c.current)]));
  }

  it("7a. the line ending is kept: a CRLF body merges like its LF twin, with CRLF in the result", () => {
    check(fc.property(fc.array(realisticLine, { minLength: 1, maxLength: 14 }), edits(true), edits(true), (lines, mine, theirs) => {
      fc.pre(applyEdits(lines, mine).length > 0 && applyEdits(lines, theirs).length > 0);
      crlfMatchesLf(lines, true, mine, theirs);
    }));
  });

  // The merge used to close every side with "\n", not with the body's own
  // line ending. With CRLF and no final newline, the last line "B" became
  // "B\n" in base but "B\r\n" once a line was appended after it, so an append
  // looked like an edit of the last line and met the other side's change to
  // that line as a conflict (an LF body merged cleanly). A clean result could
  // also end in a bare "\n" inside a CRLF body.
  it("7c. a CRLF body without a final newline merges like its LF twin", () => {
    const lines = ["first", "last"];
    // ours appends a line after "last"; theirs deletes "last".
    const mine: Edit[] = [{ op: "insert", a: 2, b: 0, d: 0, text: ["appended"] }];
    const theirs: Edit[] = [{ op: "delete", a: 1, b: 0, d: 0, text: ["x"] }];
    crlfMatchesLf(lines, false, mine, theirs);
  });

  // A side that empties the body is an empty text, not a blank line: the merge
  // does not close it with "\n", so `trim` never cuts the "\n" of a "\r\n"
  // and no lone "\r" is left in the saved note.
  it("7d. a CRLF body emptied by one side keeps its lines' CRLF endings in the merge", () => {
    const base = "a\r\nb\r\n";
    const r = threeWayMergeBody(base, "", "a\r\nb\r\nc\r\n"); // ours deletes everything, theirs appends "c"
    expect(r.merged).not.toMatch(/\r$/);
    expect(r.merged.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("7b. the final newline follows the side that changed it (ours first), else the base", () => {
    check(fc.property(
      uniqueDoc(3, 12), fc.nat(1000), fc.boolean(), fc.boolean(), fc.boolean(), edits(false, 2), edits(false, 2),
      (doc, cut, oursFinal, theirFinal, baseFinal, mine, theirs) => {
        const base: Doc = { ...doc, eol: "\n", final: baseFinal };
        // Disjoint edits (ours before line k-1, theirs from line k on), so only the ending is in question.
        const k = 2 + (cut % (doc.lines.length - 2));
        const oursLines = [...applyEdits(doc.lines.slice(0, k - 1), mine, freshLines("ours")), ...doc.lines.slice(k - 1)];
        const theirLines = [...doc.lines.slice(0, k), ...applyEdits(doc.lines.slice(k), theirs, freshLines("theirs"))];
        const r = threeWayMergeBody(render(base), render({ ...base, lines: oursLines, final: oursFinal }), render({ ...base, lines: theirLines, final: theirFinal }));
        const expected = oursFinal !== baseFinal ? oursFinal : theirFinal;
        expect(r.conflicts.map((c) => [c.base, c.incoming, c.current]), "no conflict expected").toEqual([]);
        expect(endsWithEol(r.merged), "merged ends with a line ending").toBe(expected);
      },
    ));
  });

  it("8. restore round trip: undoing an edit with the stored inverse patch gives the base back", () => {
    check(fc.property(realisticBase, edits(true), (doc, list) => {
      const base = render(doc);
      const post = edited(doc, list);
      const inverse = makeInversePatch(base, post);
      const pre = rebuildPreEventBody(post, inverse);
      expect(pre).toBe(base);
      expect(rebuildFromUnchangedBody(post, inverse)).toBe(base);
      // restore.ts revertedBody: nothing else changed → current body is post.
      expect(threeWayMergeBody(post, pre!, post)).toEqual({ merged: base, clean: true, conflicts: [] });
    }));
  });

  it("8b. restore keeps a later edit to other lines and takes back only the undone one", () => {
    check(fc.property(uniqueDoc(7, 20), fc.nat(1000), edits(true), edits(true), (doc, cut, undone, later) => {
      const k = 3 + (cut % (doc.lines.length - 5));
      const gap = doc.lines[k - 1]!;
      const top = doc.lines.slice(0, k - 1), bottom = doc.lines.slice(k);
      const base = render(doc);
      const post = render({ ...doc, lines: [...applyEdits(top, undone, freshLines("undone")), gap, ...bottom] });
      const current = render({ ...doc, lines: [...applyEdits(top, undone, freshLines("undone")), gap, ...applyEdits(bottom, later, freshLines("later"))] });
      const pre = rebuildPreEventBody(post, makeInversePatch(base, post))!;
      const r = threeWayMergeBody(post, pre, current);
      expect(r.conflicts).toEqual([]);
      expect(linesOf(r.merged, doc.eol)).toEqual([...top, gap, ...applyEdits(bottom, later, freshLines("later"))]);
    }));
  });

  it("splitLines keeps every character: joining the lines gives the text back", () => {
    check(fc.property(realisticBase, edits(true), (doc, list) => {
      const text = edited(doc, list);
      expect(splitLines(text).join("")).toBe(text);
    }));
  });
});

// ── Two insertions at one point with a shared head and/or tail ────────────────
// Segments are tagged lines (h0, x0, y0, t0 ...), so each is unique in the
// body and "appears once / appears at all" is exact.

describe("same-point insertions that share a head or tail", () => {
  const seg = (tag: string, max: number) => fc.nat(max).map((n) => Array.from({ length: n }, (_, i) => `- ${tag}${i}\n`));
  const base = "# base\n";
  const count = (text: string, part: string) => text.split(part).length - 1;

  it("9. one insertion extends the other: the longer one results, clean, in either order", () => {
    check(fc.property(seg("h", 3), seg("x", 3), seg("t", 3), fc.boolean(), (head, mid, tail, extendAtEnd) => {
      const short = extendAtEnd ? head.join("") : tail.join("");
      const long = extendAtEnd ? head.join("") + mid.join("") : mid.join("") + tail.join("");
      const ab = threeWayMergeBody(base, base + long, base + short);
      const ba = threeWayMergeBody(base, base + short, base + long);
      expect(ab).toMatchObject({ merged: base + long, clean: true });
      expect(ba).toMatchObject({ merged: base + long, clean: true });
    }));
  });

  it("10. P+X+S and P+Y+S: P and S once, X and Y both kept, same body in either order", () => {
    check(fc.property(seg("p", 3), seg("x", 3), seg("y", 3), seg("s", 3), (p, x, y, s) => {
      const [P, X, Y, S] = [p, x, y, s].map((lines) => lines.join(""));
      // Shift the tags so X and Y never share lines with each other.
      const Yt = Y.replaceAll("- y", "- z");
      const ab = threeWayMergeBody(base, base + P + X + S, base + P + Yt + S);
      const ba = threeWayMergeBody(base, base + P + Yt + S, base + P + X + S);
      expect(ab.clean).toBe(true);
      expect(ab.merged).toBe(ba.merged);
      expect(ab.merged.startsWith(base + P)).toBe(true);
      expect(ab.merged.endsWith(S)).toBe(true);
      for (const line of [...p, ...s]) expect(count(ab.merged, line), `shared ${line}`).toBe(1);
      for (const line of [...x, ...Yt.match(/[^\n]*\n/g) ?? []]) expect(count(ab.merged, line), `kept ${line}`).toBe(1);
    }));
  });
  // (c) "no clean merge holds content neither side wrote twice" is not stated
  // here: a repeated line can legitimately be written twice by one side, so a
  // precise property needs the unique-line model above, which 10 already covers.
});
