// Two writers editing one note body, for the body merge's provenance properties
// (properties/bodyMergeProvenance.property.test.ts) and the conflict-rate measurement
// (docs/research/eg-walker-bench/bench/src/paraId/runRules.ts).
//
// A body is paragraphs of lines; every base line is unique (it carries its index), and
// every piece of text a writer adds carries that writer's tag and a counter ("甲3",
// "乙1"), so "this text was written by that writer" is exact. Lines end in "。" or a
// list marker starts them, as real notes do: the shared "。" is what let rules 1–2
// splice one writer's addition into the other writer's new paragraph.

import fc from "fast-check";

export type Paragraphs = string[][];
export type WriterEdit =
  | { op: "type"; p: number; l: number; at: number; text: string } // add characters inside a line
  | { op: "addPara"; at: number; lines: number } // a new paragraph
  | { op: "addLine"; p: number; at: number } // a new line inside a paragraph
  | { op: "deleteLine"; p: number; l: number }
  | { op: "deletePara"; p: number }
  | { op: "rewriteLine"; p: number; l: number } // replace a line's text
  | { op: "movePara"; p: number; to: number }
  | { op: "splitLine"; p: number; l: number; at: number };

const SENTENCES = ["今天開會討論進度。", "下週要交報告。", "記得買牛奶。", "這段要再想想。", "- 寄包裹", "- 繳電費", "Read the paper.", "TODO: follow up"];
const TYPED = ["很", "（補充）", "，然後", "。", "!", " ok"];

export const renderParagraphs = (doc: Paragraphs): string => doc.map((p) => p.join("\n")).join("\n\n") + "\n";

export const baseDoc: fc.Arbitrary<Paragraphs> = fc
  .array(fc.array(fc.nat(SENTENCES.length - 1), { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 5 })
  .map((paras) => {
    let n = 0;
    return paras.map((p) => p.map((k) => { const s = SENTENCES[k]!; n++; return s.endsWith("。") ? `${s.slice(0, -1)}${n}。` : `${s} ${n}`; }));
  });

const writerEdit: fc.Arbitrary<WriterEdit> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ op: fc.constant("type" as const), p: fc.nat(99), l: fc.nat(99), at: fc.nat(99), text: fc.constantFrom(...TYPED) }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("addPara" as const), at: fc.nat(99), lines: fc.integer({ min: 1, max: 2 }) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("addLine" as const), p: fc.nat(99), at: fc.nat(99) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("deleteLine" as const), p: fc.nat(99), l: fc.nat(99) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("deletePara" as const), p: fc.nat(99) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("rewriteLine" as const), p: fc.nat(99), l: fc.nat(99) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("movePara" as const), p: fc.nat(99), to: fc.nat(99) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("splitLine" as const), p: fc.nat(99), l: fc.nat(99), at: fc.nat(99) }) },
);
export const writerEdits = fc.array(writerEdit, { minLength: 1, maxLength: 3 });

/** One writer's text: `edits` applied to `doc`, every added piece tagged with `tag` and a counter. */
export function write(doc: Paragraphs, edits: WriterEdit[], tag: string): Paragraphs {
  const out = doc.map((p) => [...p]);
  let n = 0;
  const fresh = (end: string) => `${tag}${n++}${end}`;
  for (const e of edits) {
    if (e.op === "addPara") {
      out.splice(e.at % (out.length + 1), 0, Array.from({ length: e.lines }, () => fresh("寫的新段落。")));
      continue;
    }
    if (out.length === 0) continue;
    const p = e.p % out.length;
    const para = out[p]!;
    const l = "l" in e ? e.l % para.length : 0;
    if (e.op === "type") {
      const line = para[l]!;
      const at = e.at % (line.length + 1);
      para[l] = line.slice(0, at) + `${tag}${n++}${e.text}` + line.slice(at);
    } else if (e.op === "addLine") para.splice(e.at % (para.length + 1), 0, fresh("加的一行。"));
    else if (e.op === "rewriteLine") para[l] = fresh("改寫的一行。");
    else if (e.op === "deleteLine") { para.splice(l, 1); if (para.length === 0) out.splice(p, 1); }
    else if (e.op === "deletePara") out.splice(p, 1);
    else if (e.op === "movePara") { const [moved] = out.splice(p, 1); out.splice(e.to % (out.length + 1), 0, moved!); }
    else { // splitLine: a line break typed inside a line
      const line = para[l]!;
      const at = 1 + (e.at % Math.max(1, line.length - 1));
      if (at < line.length) para.splice(l, 1, line.slice(0, at), line.slice(at));
    }
  }
  return out;
}

/** The tagged pieces a text holds ("甲3"). */
export const tagsIn = (text: string, tag: string): string[] => text.match(new RegExp(`${tag}\\d+`, "g")) ?? [];

const nonBlank = (text: string) => text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");
const isSubsequence = (needle: string, hay: string) => {
  let k = 0;
  for (let i = 0; i < hay.length && k < needle.length; i++) if (hay[i] === needle[k]) k++;
  return k === needle.length;
};

const NEW_LINE = "(?:寫的新段落|加的一行|改寫的一行)";

/** Merged lines nobody wrote. A line of base or of a writer is fine, and so is one base line with both writers'
 *  additions to it (rule F03, decisions-core-sync.md: both only added characters, both kept), also when one writer split
 *  that line (Enter typed inside it) and the merge holds a piece of it. Not fine:
 *  - spliced: one writer's text inside a line the other writer newly wrote (rules 1–2: "新增（我）。");
 *  - invented: not a piece of any of the three texts, and not one line of each writer merged (each writer's line,
 *    or a piece of it, is in it in order). */
export function unwrittenLines(base: string, a: string, b: string, merged: string): string[] {
  const B = nonBlank(base), A = nonBlank(a), C = nonBlank(b);
  const known = new Set([...B, ...A, ...C]);
  const docs = [base, a, b].map((t) => t.replace(/\s+/g, ""));
  const spliced = (m: string) => [["甲", "乙"], ["乙", "甲"]].some(([w, o]) => new RegExp(`${o}\\d+${NEW_LINE}`).test(m) && new RegExp(`${w}\\d+`).test(m));
  // A writer's line, or the piece of it on the merged line: its characters that are base text or that writer's.
  // (A line split by the other writer leaves a prefix of it on one merged line and the rest on the next.)
  const pieceIn = (line: string, m: string) => {
    if (isSubsequence(line, m)) return true;
    for (let cut = 4; cut < line.length; cut++) if (isSubsequence(line.slice(0, cut), m) && !isSubsequence(line.slice(0, cut + 1), m)) return true;
    for (let cut = line.length - 4; cut > 0; cut--) if (isSubsequence(line.slice(cut), m) && !isSubsequence(line.slice(cut - 1), m)) return true;
    return false;
  };
  return nonBlank(merged).filter((m) => {
    if (known.has(m)) return false;
    if (spliced(m)) return true;
    if (docs.some((d) => d.includes(m.replace(/\s+/g, "")))) return false;
    return !(A.some((x) => pieceIn(x, m)) && C.some((y) => pieceIn(y, m)));
  });
}

/** Non-blank lines the merged body holds more often than base plus what each writer added of them. Base lines are
 *  unique and writers add tagged lines; only splitting a line can give two writers the same new line. */
export function doubledLines(base: string, a: string, b: string, merged: string): string[] {
  const count = (text: string) => { const m = new Map<string, number>(); for (const l of nonBlank(text)) m.set(l, (m.get(l) ?? 0) + 1); return m; };
  const cb = count(base), ca = count(a), cc = count(b);
  return [...count(merged)].filter(([l, n]) => (cb.has(l) || ca.has(l) || cc.has(l)) && n > (cb.get(l) ?? 0) + Math.max(0, (ca.get(l) ?? 0) - (cb.get(l) ?? 0)) + Math.max(0, (cc.get(l) ?? 0) - (cb.get(l) ?? 0))).map(([l]) => l);
}
