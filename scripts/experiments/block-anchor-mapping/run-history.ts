// 真實編輯歷史：每個檔案在起始版本選定段落，之後每個版本更新一次，與參考答案比。
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadHistories, OUT } from "./history.ts";
import {
  DEFAULTS, GONE_CUT, Oracle, segment, eligible, lineAlign, m1Mark, m1Locate, m1Step, m2Init, m2Step, m3Init, m3Step,
  type Params, type Range, type Seg, type Form, type M1Anchor, type LineAnchor, type CharAnchor,
} from "./lib.ts";

export type Rec = {
  file: string; start: number; step: number; anchor: string; kind: "single" | "range";
  touched: boolean; frac: number; oracle: Range | null; prevOracle: Range | null;
  res: Record<"M1a" | "M1b" | "M2" | "M3", Range | null>;
  mergeBroken: { M1a: boolean; M1b: boolean };
};

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

type Pick = { id: string; kind: "single" | "range"; segs: Seg[]; range: Range };
function pickAnchors(text: string, seed: number): Pick[] {
  const segs = segment(text).filter((s) => eligible(text, s));
  const rand = rng(seed);
  const used = new Set<number>();
  const picks: Pick[] = [];
  const free = (i: number) => !used.has(i) && !used.has(i - 1) && !used.has(i + 1);
  // 3 個範圍（2–3 個連續段落），6 個單段，互不相鄰。
  for (let n = 0; n < 3; n++) {
    const len = 2 + Math.floor(rand() * 2);
    const cand = Array.from({ length: Math.max(0, segs.length - len + 1) }, (_, i) => i).filter((i) => Array.from({ length: len }, (_, k) => i + k).every(free));
    if (!cand.length) break;
    const i = cand[Math.floor(rand() * cand.length)]!;
    for (let k = 0; k < len; k++) used.add(i + k);
    const first = segs[i]!, last = segs[i + len - 1]!;
    picks.push({ id: `zr${String(picks.length).padStart(2, "0")}${seed % 997}`, kind: "range", segs: [first, last], range: lineAlign(text, { from: first.from, to: last.to }) });
  }
  for (let n = 0; n < 6; n++) {
    const cand = segs.map((_, i) => i).filter(free);
    if (!cand.length) break;
    const i = cand[Math.floor(rand() * cand.length)]!;
    used.add(i);
    picks.push({ id: `zs${String(picks.length).padStart(2, "0")}${seed % 997}`, kind: "single", segs: [segs[i]!], range: lineAlign(text, { from: segs[i]!.from, to: segs[i]!.to }) });
  }
  return picks;
}

const SHARED = new Map<string, any[]>();
export const T = { merge: 0, locate: 0, oracle: 0, m2: 0, m3: 0, t0: 0 };
export function runHistory(P: Params = DEFAULTS, nFiles = 30, maxSteps = 60): Rec[] {
  const recs: Rec[] = [];
  for (const h of loadHistories(nFiles)) {
    if (process.env.ONLY && !h.path.includes(process.env.ONLY)) continue;
    const texts = h.versions.map((v) => v.text);
    const firstViable = texts.findIndex((t) => segment(t).filter((s) => eligible(t, s)).length >= 10);
    const starts = new Set<number>();
    if (firstViable >= 0) starts.add(firstViable);
    starts.add(Math.floor(texts.length / 2));
    for (const start of starts) {
      if (start < 0 || texts.length - start < 4) continue;
      const t0 = texts[start]!;
      const picks = pickAnchors(t0, hash(h.path) + start);
      if (!picks.length) continue;
      const oracles = picks.map((p) => new Oracle(t0, p.range));
      const m2 = picks.map((p): LineAnchor => m2Init(t0, p.range));
      const m3 = picks.map((p): CharAnchor => m3Init(t0, p.range));
      const marks = picks.flatMap((p) => p.kind === "single" ? [{ id: p.id, seg: p.segs[0]! }] : [{ id: p.id + "a", seg: p.segs[0]! }, { id: p.id + "b", seg: p.segs[1]! }]);
      const ids = marks.map((m) => m.id);
      const m1a: M1Anchor[] = picks.map((p) => ({ id: p.id, kind: p.kind }));
      const marked: Record<Form, string> = { eol: m1Mark(t0, marks, "eol"), next: m1Mark(t0, marks, "next") };
      for (let k = start + 1; k < Math.min(texts.length, start + 1 + maxSteps); k++) {
        const prev = texts[k - 1]!, next = texts[k]!;
        const key = `${h.path}|${start}|${k}`;
        let shared = SHARED.get(key);
        if (!shared) {
          // 與門檻無關的部分（參考答案、M1）只算一次，掃門檻時重用。
          const mm = { eol: m1Step(marked.eol, prev, next), next: m1Step(marked.next, prev, next) };
          marked.eol = mm.eol.marked; marked.next = mm.next.marked;
          const loc = { eol: picks.map((_, i) => m1Locate(marked.eol, m1a[i]!, "eol", ids)), next: picks.map((_, i) => m1Locate(marked.next, m1a[i]!, "next", ids)) };
          shared = picks.map((_, i) => {
            const o = oracles[i]!;
            if (o.goneSteps > 3) return null;
            const prevOracle = o.range;
            const { touched, frac } = o.step(prev, next);
            return { touched, frac, oracle: o.range, prevOracle, M1a: loc.eol[i]!.range, M1b: loc.next[i]!.range, bA: loc.eol[i]!.clean !== next, bB: loc.next[i]!.clean !== next };
          });
          SHARED.set(key, shared);
        }
        picks.forEach((p, i) => {
          const sh = shared![i];
          if (!sh) return;
          const r2 = m2Step(m2[i]!, prev, next, P);
          const r3 = m3Step(m3[i]!, prev, next, P);
          recs.push({
            file: h.path, start, step: k, anchor: p.id, kind: p.kind, touched: sh.touched, frac: sh.frac, oracle: sh.oracle, prevOracle: sh.prevOracle,
            res: { M1a: sh.M1a, M1b: sh.M1b, M2: r2, M3: r3 }, mergeBroken: { M1a: sh.bA, M1b: sh.bB },
          });
        });
      }
    }
  }
  return recs;
}

if (process.argv[1]?.endsWith("run-history.ts")) {
  const t = Date.now();
  const recs = runHistory();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, process.env.ONLY ? "peek.json" : "history-records.json"), JSON.stringify(recs));
  console.log(recs.length, "records", (Date.now() - t) / 1000, "s", JSON.stringify(T));
}
