// How much does an anchor lose if its place is a pure function of (current text, selector) instead of following each save?
// Evidence for docs/architecture/proposals/anchors-deterministic-2026-11-16.md §3 (design 乙), and the byte counts for design 甲.
//
//   npm run build -w @onden/markdown && npx tsx packages/backend/scripts/measure-anchor-place-by-function.mts
//
// Data: the git history of this repo's docs/**/*.md (the experiment's loadHistories; needs history — a shallow clone gives few versions).
// Per file: up to 6 single paragraphs at the start version and at the middle version, followed for up to 60 later versions.
// Truth is the experiment's character-tracking Oracle. Compared per (anchor, version) step:
//   chain  today's way: m3Step carried from version to version (each version = one save)
//   jump   the same anchor moved from the start version straight to version k in ONE step (a node that only sees version k)
//   B      place-by-function: fuzzyFind(quote taken once at the start version, text of version k)
//   Bs     place-by-function with the quote refreshed from where it was found at every version (a writer that refreshes the selector)
// Limits (also in the proposal): the Oracle is the same family as m3Step so it favours chain/jump; each version is a commit, much coarser
// than autosaves; docs are technical notes, not daily notes; fuzzyFind is the experiment's copy (find threshold 0.8), not services/blockAnchors/findQuote.
//
// Also prints the size of what the writer knows and a reader cannot compute from (before, after): the editor's ChangeSet. Here it is the
// derived one (diffByLinesThenChars → ChangeSet JSON) as a proxy: the editor's real one is typed keystrokes and is usually larger.
import { ChangeSet } from "@codemirror/state";
import { loadHistories } from "../../../scripts/experiments/block-anchor-mapping/history.ts";
import { DEFAULTS, fuzzyFind, quoteAt, classify, iou, Oracle, segment, eligible, lineAlign, m3Init, m3Step, diffByLinesThenChars, type Range, type CharAnchor } from "../../../scripts/experiments/block-anchor-mapping/lib.ts";

type T = { correct: number; lost: number; wrong: number };
const mk = (): T => ({ correct: 0, lost: 0, wrong: 0 });
const tally: Record<string, T> = { chain: mk(), jump: mk(), B: mk(), Bs: mk() };
const bump = (m: string, c: string) => { tally[m]![c.startsWith("wrong") ? "wrong" : (c as "correct" | "lost")]++; };
let n = 0, differ = 0, foundVsLost = 0, files = 0, versions = 0;
const csBytes: number[] = [];
const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };

for (const h of loadHistories(30)) {
  const texts = h.versions.map((v) => v.text); files++; versions += texts.length;
  for (let k = 1; k < texts.length; k++) {
    const ops = diffByLinesThenChars(texts[k - 1]!, texts[k]!);
    csBytes.push(JSON.stringify(ChangeSet.of(ops, texts[k - 1]!.length).toJSON()).length);
  }
  const starts = new Set<number>();
  const fv = texts.findIndex((t) => segment(t).filter((s) => eligible(t, s)).length >= 10);
  if (fv >= 0) starts.add(fv);
  starts.add(Math.floor(texts.length / 2));
  for (const start of starts) {
    if (texts.length - start < 4) continue;
    const t0 = texts[start]!;
    const segs = segment(t0).filter((s) => eligible(t0, s));
    const picks = segs.filter((_, i) => i % Math.max(1, Math.floor(segs.length / 6)) === 0).slice(0, 6).map((s) => lineAlign(t0, { from: s.from, to: s.to }));
    for (const r0 of picks) {
      const oracle = new Oracle(t0, r0);
      const q0 = quoteAt(t0, r0);
      let qs = q0;
      const chain: CharAnchor = m3Init(t0, r0);
      for (let k = start + 1; k < Math.min(texts.length, start + 61); k++) {
        oracle.step(texts[k - 1]!, texts[k]!);
        if (oracle.goneSteps > 3) break;
        const chainRange: Range | null = chain.lost ? null : m3Step(chain, texts[k - 1]!, texts[k]!, DEFAULTS);
        const jumpRange = m3Step(m3Init(t0, r0), t0, texts[k]!, DEFAULTS);
        const b = fuzzyFind(q0, texts[k]!, DEFAULTS.find);
        const bs = fuzzyFind(qs, texts[k]!, DEFAULTS.find);
        if (bs) qs = quoteAt(texts[k]!, bs);
        n++;
        bump("chain", classify(chainRange, oracle.range)); bump("jump", classify(jumpRange, oracle.range));
        bump("B", classify(b, oracle.range)); bump("Bs", classify(bs, oracle.range));
        const same = chainRange === null || jumpRange === null ? chainRange === jumpRange : iou(chainRange, jumpRange) >= 0.999;
        if (!same) differ++;
        if ((chainRange === null) !== (jumpRange === null)) foundVsLost++;
      }
    }
  }
}
console.log(`files ${files}, versions ${versions}, steps ${n}`);
for (const [m, t] of Object.entries(tally)) {
  const tot = t.correct + t.lost + t.wrong;
  console.log(m.padEnd(6), `correct ${(100 * t.correct / tot).toFixed(1)}%  lost ${(100 * t.lost / tot).toFixed(1)}%  wrong ${(100 * t.wrong / tot).toFixed(1)}%`, JSON.stringify(t));
}
console.log(`chain vs jump: different range ${differ} (${(100 * differ / n).toFixed(1)}%), one found / one lost ${foundVsLost} (${(100 * foundVsLost / n).toFixed(1)}%)`);
console.log(`ChangeSet JSON per version step (derived, proxy for the editor's): n=${csBytes.length} median ${pct(csBytes, 0.5)} B, p95 ${pct(csBytes, 0.95)} B, max ${Math.max(...csBytes)} B`);
// Design 甲 carries per anchor: id (newBlockId, 8 chars), from, to, status, candidate span (maybe/lost only).
const rowBytes = (from: number, to: number) => JSON.stringify({ id: "abcd1234", from, to, status: "valid" }).length;
console.log(`design 甲 row per anchor (valid, offsets < 1,000,000): ${rowBytes(999999, 999999)} B raw JSON; 50 anchors ≈ ${50 * rowBytes(999999, 999999)} B, 200 ≈ ${200 * rowBytes(999999, 999999)} B per save before compression`);
