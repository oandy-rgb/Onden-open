// Property tests of mergeBody (services/eventLog/bodyMergeMoves.ts): paragraphs moved, inserted, edited and
// deleted by two writers. DB-free; run count and seed from helpers/propsConfig.ts.
//
// Excluded on purpose: an edit at a paragraph's LAST characters. The line merge splices such an edit into a paragraph the
// other writer added right after it (see "known line-merge defect" in bodyMergeMoves.test.ts, pinned with it.fails), which
// would fail property 1 for a reason that is not this module's. So an edit's marker goes after the first "，", never at the end.
//
// Bodies are paragraphs separated by blank lines, every paragraph one unique line, every inserted paragraph a
// fresh unique line, every edit a unique marker appended to a paragraph, so "this was written by that side" is exact.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { mergeBody } from "../../services/eventLog/bodyMergeMoves.js";
import { check } from "../helpers/propsConfig.js";

type Op = { op: "insert" | "delete" | "move" | "edit"; a: number; d: number };
const op = fc.record({ op: fc.constantFrom<Op["op"]>("insert", "delete", "move", "edit"), a: fc.nat(1000), d: fc.nat(1000) });
const ops = fc.array(op, { minLength: 1, maxLength: 4 });
const baseParas = fc.integer({ min: 4, max: 12 }).map((n) => Array.from({ length: n }, (_, i) => `段落${i}的內容，這一整行都是第${i}段才有的字。`));

const render = (paras: string[]) => paras.join("\n\n") + "\n";
const linesOf = (text: string) => text.split("\n").filter((l) => l.trim() !== "");

type Side = { paras: string[]; inserted: string[]; edits: string[]; touched: Set<string> };
/** One writer's edits over the base paragraphs. `touched` holds the base paragraphs this side deleted, moved or edited. */
function apply(base: string[], list: Op[], tag: string): Side {
  const paras = [...base];
  const side: Side = { paras, inserted: [], edits: [], touched: new Set() };
  let n = 0;
  for (const o of list) {
    if (o.op === "insert") { const text = `${tag}新增${n++}，這是${tag}方自己寫的整行。`; paras.splice(o.a % (paras.length + 1), 0, text); side.inserted.push(text); continue; }
    if (paras.length < 3) continue;
    const at = o.a % paras.length;
    if (o.op === "delete") side.touched.add(paras.splice(at, 1)[0]!);
    else if (o.op === "move") { const [p] = paras.splice(at, 1); side.touched.add(p!); paras.splice(o.d % (paras.length + 1), 0, p!); }
    else if (!/（.方改\d+）/.test(paras[at]!)) { const marker = `（${tag}方改${n++}）`; side.touched.add(base.find((b) => paras[at]!.startsWith(b.slice(0, -1))) ?? paras[at]!); paras[at] = paras[at]!.replace("，", `${marker}，`); side.edits.push(marker); }
  }
  // A paragraph or marker the same writer later deleted was never part of what they sent.
  side.inserted = side.inserted.filter((t) => paras.includes(t));
  side.edits = side.edits.filter((m) => paras.some((x) => x.includes(m)));
  return side;
}

describe("mergeBody properties", () => {
  it("1. a clean merge holds no line twice and drops no line either writer newly wrote", () => {
    check(fc.property(baseParas, ops, ops, (base, mine, theirs) => {
      const a = apply(base, mine, "我"), b = apply(base, theirs, "他");
      const r = mergeBody(render(base), render(a.paras), render(b.paras));
      if (!r.clean) return;
      const lines = linesOf(r.merged);
      expect(new Set(lines).size, `a line is held twice in:\n${r.merged}`).toBe(lines.length);
      for (const l of [...a.inserted, ...b.inserted]) expect(r.merged.includes(l), `the new line ${l} is gone from:\n${r.merged}`).toBe(true);
      // An edit marker survives unless the other writer deleted that paragraph.
      const deletedBy = (s: Side, other: Side) => [...s.touched].filter((p) => !other.paras.some((x) => x.startsWith(p.slice(0, -1))));
      for (const [s, other] of [[a, b], [b, a]] as const) {
        const gone = deletedBy(other, s);
        for (const m of s.edits) {
          const para = s.paras.find((x) => x.includes(m))!;
          if (gone.some((g) => para.startsWith(g.slice(0, -1)))) continue;
          expect(r.merged.includes(m), `the edit ${m} is gone from:\n${r.merged}`).toBe(true);
        }
      }
    }));
  });

  it("2. swapping the two writers does not change whether the merge is a conflict", () => {
    check(fc.property(baseParas, ops, ops, (base, mine, theirs) => {
      const a = render(apply(base, mine, "我").paras), b = render(apply(base, theirs, "他").paras);
      const x = mergeBody(render(base), a, b), y = mergeBody(render(base), b, a);
      expect(x.clean, `incoming=A gave ${x.clean}, incoming=B gave ${y.clean}`).toBe(y.clean);
    }));
  });

  it("3. a conflict keeps the incoming writer's text and offers the current writer's text back", () => {
    check(fc.property(baseParas, ops, ops, (base, mine, theirs) => {
      const a = apply(base, mine, "我"), b = apply(base, theirs, "他");
      const r = mergeBody(render(base), render(a.paras), render(b.paras));
      if (r.clean) return;
      for (const l of a.inserted) expect(r.merged.includes(l), `incoming's new line ${l} is gone`).toBe(true);
      const offered = r.conflicts.map((c) => c.current).join("\n");
      for (const l of b.inserted) expect(r.merged.includes(l) || offered.includes(l), `current's new line ${l} is nowhere`).toBe(true);
    }));
  });
});
