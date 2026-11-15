// A cheap line-count check of a clean body merge, used by bodyMergeMoves.ts to refuse a merge that doubled or dropped text.

type MergeProblem = { kind: "doubled" | "dropped" | "left-out" | "invented"; line: string };

const sq = (s: string) => s.replace(/\s+/g, "");
/** Whether `needle` is a subsequence of `hay`. */
const subsequence = (needle: string, hay: string): boolean => {
  let k = 0;
  for (let i = 0; i < hay.length && k < needle.length; i++) if (hay[i] === needle[k]) k++;
  return k === needle.length;
};
const countOf = (xs: string[]) => { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return m; };
/** The non-blank lines, trimmed (single-line paragraphs, list items and table rows are one line each). */
const lineKeys = (text: string) => text.split("\n").map((l) => l.replace(/\r$/, "").trim()).filter((l) => l !== "");

/** A cheap check of a clean merge, by line counts (whitespace ignored, so splitting or joining a paragraph is not a
 *  problem): a line held more often than the two sides' changes explain (doubled), a line a side newly wrote that
 *  is gone (dropped), a line both sides still had that is gone (left-out), a line neither side wrote and that is not
 *  a piece of one of the three texts (invented). It cannot see a line in the wrong place. */
export function mergeLossProblems(base: string, incoming: string, current: string, merged: string): MergeProblem[] {
  const out: MergeProblem[] = [];
  const B = lineKeys(base), I = lineKeys(incoming), C = lineKeys(current), M = lineKeys(merged);
  const cB = countOf(B), cI = countOf(I), cC = countOf(C), cM = countOf(M);
  const docM = sq(merged);
  // Lazily: the two checks that need these only run when a line is missing.
  let pairs: string[] | null = null;
  const present = (t: string) => { // t's characters are still in the merged text (as is, or merged into a line both sides changed)
    const s = sq(t);
    if (docM.includes(s)) return true;
    pairs ??= M.map((m, i) => sq(m) + (M[i + 1] === undefined ? "" : sq(M[i + 1]!)));
    return M.some((m) => subsequence(s, sq(m))) || pairs.some((m) => subsequence(s, m));
  };
  const docB = sq(base);
  /** A line that is entirely new: no small piece of it is in base. An edited old line is not (the other side may have replaced those very characters). */
  const wholeNew = (t: string) => { const x = sq(t); const n = x.length; return [0, Math.floor(n / 2) - 5, n - 10].every((i) => n < 10 || !docB.includes(x.slice(Math.max(0, i), Math.max(0, i) + 10))); };
  for (const t of new Set([...cB.keys(), ...cI.keys(), ...cC.keys()])) {
    const b = cB.get(t) ?? 0, dI = (cI.get(t) ?? 0) - b, dC = (cC.get(t) ?? 0) - b, got = (cM.get(t) ?? 0) - b;
    const sum = dI + dC;
    const same = dI !== 0 && dC !== 0 && Math.sign(dI) === Math.sign(dC);
    const lo = same ? (Math.abs(dI) > Math.abs(dC) ? dI : dC) : sum;
    const [min, max] = lo < sum ? [lo, sum] : [sum, lo];
    if (got > max) out.push({ kind: "doubled", line: t });
    if (got < min && (dI > 0 || dC > 0) && wholeNew(t) && !present(t)) out.push({ kind: "dropped", line: t });
    if (got < min && dI <= 0 && dC <= 0) out.push({ kind: "left-out", line: t });
  }
  const known = new Set([...B, ...I, ...C]);
  const docs = [sq(base), sq(incoming), sq(current)];
  const addedI = I.filter((x) => !cB.has(x)), addedC = C.filter((x) => !cB.has(x));
  for (const m of M) {
    if (known.has(m)) continue;
    const s = sq(m);
    if (docs.some((d) => d.includes(s))) continue; // a piece of a split or joined line
    if (addedI.some((a) => subsequence(sq(a), s)) && addedC.some((a) => subsequence(sq(a), s))) continue; // both sides' typing in one line
    out.push({ kind: "invented", line: m });
  }
  return out;
}
