// Moved paragraphs in a three-way body merge.
//
// bodyMerge.ts merges by line: it cannot tell that a paragraph moved, so
//   - one writer moves a paragraph and the other edits it → the edit sits at the old place and the
//     move at the new one, a conflict (and both are fine to keep);
//   - both writers move the same paragraph to different places → no hunks overlap, "clean", yet the
//     result keeps one move only or holds the paragraph twice.
// `mergeBody` is the entry that fixes both, and the only merge the callers use:
//   1. the line merge runs first and stays the main merge;
//   2. when it says conflict, and every conflicting region is made of units one side moved verbatim,
//      the units below (paragraph, list item, heading, quote, table, code block) are matched across
//      the three texts and merged per unit. The result is taken only if it is clean and passes
//      `mergeLossProblems` (a cheap line count: nothing doubled, nothing of either side's new lines
//      dropped, nothing invented); otherwise the line conflict stands. Not for other conflicts: two
//      writers rewriting one short paragraph look like "both deleted it, both added one" to the unit
//      matching, and the merge would keep both rewrites. Both sides editing the same unit still goes
//      through threeWayMergeBody, so two writers changing the same sentence stay a conflict;
//   3. when the line merge says clean but both sides moved a verbatim unit, the unit merge looks
//      for a unit moved to different places (or an order neither side wrote), and the line count looks
//      at the line merge's text for a doubled or missing line. Either is a conflict:
//      the merged body keeps the incoming text and the conflict carries the whole current text, the
//      same way every conflict offers the left-out side back.
//
// Changing what this returns is a merge rule version change (CURRENT_BODY_MERGE_RULE in bodyMerge.ts, published as BODY_MERGE_RULE_VERSION in distributedSync/types.ts): nodes on
// different versions would compute different bodies. docs/architecture/proposals/node-sync-channels-2026-11-14.md item 12.

import { bigrams, fenceScanner } from "@onden/markdown";
import { diffRuns } from "./bodyPatch.js";
import { CURRENT_BODY_MERGE_RULE, splitLines, threeWayMergeBody, type BodyConflict, type BodyMerge, type BodyMergeRule } from "./bodyMerge.js";
import { heldTwice, mergeLossProblems } from "./bodyMergeLoss.js";
import { FIND_VALID, KEEP_MOVED } from "../blockAnchors/index.js";

type UnitConflictKind = "edit-edit" | "edit-delete" | "move-delete";
type UnitKind = "para" | "list" | "heading" | "quote" | "table" | "code";
type Unit = { text: string; gap: string; kind: UnitKind; key: string; grams?: { map: Map<string, number>; n: number; sq: string } };
type Doc = { lead: string; units: Unit[] };
/** "block": a paragraph is a unit. "line": every non-blank line is (used to measure texts whose paragraph breaks are scrambled). */
type UnitMode = "block" | "line";

/** Bigram Dice like blockAnchors/similarity.ts, with each unit's bigrams counted once (thousands of pairs are compared). */
function dice(a: Unit, b: Unit): number {
  const g = (u: Unit) => (u.grams ??= (() => { const sq = u.key.replace(/\s+/g, ""); return { sq, n: Math.max(0, sq.length - 1), map: bigrams(sq) }; })());
  const x = g(a), y = g(b);
  if (x.sq === y.sq) return 1;
  if (x.sq.length < 2 || y.sq.length < 2) return 0;
  let hit = 0;
  const [small, big] = x.map.size <= y.map.size ? [x.map, y.map] : [y.map, x.map];
  for (const [k, n] of small) hit += Math.min(n, big.get(k) ?? 0);
  return (2 * hit) / (x.n + y.n);
}

const LIST = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
const bare = (line: string) => line.replace(/\r?\n$/, "");
const blank = (line: string) => bare(line).trim() === "";
const opensFence = (line: string): boolean => fenceScanner()(line) === "open";

/** The text as units. A unit's `gap` is the line break and blank lines after it, so joining text+gap gives the text back. */
function splitUnits(text: string, mode: UnitMode = "block"): Doc {
  const lines = splitLines(text);
  const units: Unit[] = [];
  let i = 0;
  let lead = "";
  while (i < lines.length && blank(lines[i]!)) lead += lines[i++];
  const continues = (k: number) => !blank(lines[k]!) && !LIST.test(bare(lines[k]!)) && !HEADING.test(bare(lines[k]!)) && !opensFence(bare(lines[k]!));
  while (i < lines.length) {
    const first = bare(lines[i]!);
    let end = i + 1;
    let kind: UnitKind = "para";
    const scan = fenceScanner();
    if (mode === "line") kind = LIST.test(first) ? "list" : HEADING.test(first) ? "heading" : "para";
    else if (scan(first) === "open") {
      kind = "code";
      while (end < lines.length && scan(bare(lines[end]!)) !== "close") end++;
      if (end < lines.length) end++; // the closing fence
    } else if (HEADING.test(first)) kind = "heading";
    else if (LIST.test(first)) {
      kind = "list";
      while (end < lines.length && continues(end)) end++;
    } else if (first.trimStart().startsWith(">")) {
      kind = "quote";
      while (end < lines.length && bare(lines[end]!).trimStart().startsWith(">")) end++;
    } else if (first.trimStart().startsWith("|")) {
      kind = "table";
      while (end < lines.length && bare(lines[end]!).trimStart().startsWith("|")) end++;
    } else {
      while (end < lines.length && continues(end)) end++;
    }
    let body = lines.slice(i, end).join("");
    const eol = /(\r?\n)$/.exec(body);
    let gap = "";
    if (eol) { gap = eol[1]!; body = body.slice(0, -gap.length); }
    let j = end;
    while (j < lines.length && blank(lines[j]!)) gap += lines[j++];
    units.push({ text: body, gap, kind, key: body.replace(/\r/g, "") });
    i = j;
  }
  return { lead, units };
}

type Side = {
  /** side unit → base unit, or -1 (added) */
  toBase: number[];
  /** base unit → side unit, or -1 (removed) */
  fromBase: number[];
  /** side units that are a base unit verbatim at another place, or moved and edited */
  moved: Set<number>;
};

/** Past this many (free base unit × free side unit) pairs the moved-and-edited step is skipped. */
const MAX_FUZZY_PAIRS = 250_000;

/** Which base unit each unit of one side is. In order: verbatim and in order (the line diff's common part); verbatim
 *  but elsewhere (moved); between two matched units and similar (Dice ≥ KEEP_MOVED, edited); the one left over at
 *  the same place on both sides (rewritten); similar enough to be the only candidate (Dice ≥ FIND_VALID, moved and
 *  edited). `exactOnly` stops after the verbatim steps: enough to see whether anything moved. Null when the texts
 *  have more distinct units than one UTF-16 unit can name. */
function matchUnits(base: Unit[], side: Unit[], exactOnly = false): Side | null {
  const ids = new Map<string, number>();
  const encode = (units: Unit[]) => {
    let s = "";
    for (const u of units) { let id = ids.get(u.key); if (id === undefined) { id = ids.size; ids.set(u.key, id); } s += String.fromCharCode(id); }
    return s;
  };
  const a = encode(base), b = encode(side);
  if (ids.size > 0xffff) return null;
  const toBase = new Array<number>(side.length).fill(-1);
  const fromBase = new Array<number>(base.length).fill(-1);
  const moved = new Set<number>();
  const link = (j: number, i: number) => { toBase[j] = i; fromBase[i] = j; };
  const anchorsI: number[] = [], anchorsJ: number[] = [];
  let i = 0, j = 0;
  for (const [op, run] of diffRuns(a, b)) {
    const n = run.length;
    if (op === 0) { for (let k = 0; k < n; k++) { link(j + k, i + k); anchorsI.push(i + k); anchorsJ.push(j + k); } i += n; j += n; }
    else if (op === -1) i += n; else j += n;
  }
  const free = new Map<string, number[]>();
  for (let x = 0; x < base.length; x++) if (fromBase[x]! < 0) { const l = free.get(base[x]!.key); if (l) l.push(x); else free.set(base[x]!.key, [x]); }
  for (let y = 0; y < side.length; y++) {
    if (toBase[y]! >= 0) continue;
    const l = free.get(side[y]!.key);
    if (l && l.length > 0) { link(y, l.shift()!); moved.add(y); }
  }
  if (exactOnly) return { toBase, fromBase, moved };
  // Between two matched units, in the same order: similar means edited.
  let pi = 0, pj = 0;
  for (let k = 0; k <= anchorsI.length; k++) {
    const ei = k < anchorsI.length ? anchorsI[k]! : base.length;
    const ej = k < anchorsJ.length ? anchorsJ[k]! : side.length;
    const bs: number[] = [], ss: number[] = [];
    for (let x = pi; x < ei; x++) if (fromBase[x]! < 0) bs.push(x);
    for (let y = pj; y < ej; y++) if (toBase[y]! < 0) ss.push(y);
    pi = ei + 1; pj = ej + 1;
    if (bs.length === 0 || ss.length === 0) continue;
    let last = -1;
    for (const y of ss) {
      let best = -1, bestScore = KEEP_MOVED;
      for (let q = last + 1; q < bs.length; q++) {
        const x = bs[q]!;
        if (fromBase[x]! >= 0) continue;
        const score = dice(base[x]!, side[y]!);
        if (score >= bestScore) { bestScore = score; best = q; }
      }
      if (best >= 0) { link(y, bs[best]!); last = best; }
    }
    // One left on each side at the same place: the same unit rewritten. Without this, two writers rewriting it
    // beyond recognition would read as "both deleted it, both added one" and the merge would keep two.
    const restB = bs.filter((x) => fromBase[x]! < 0), restS = ss.filter((y) => toBase[y]! < 0);
    if (restB.length === 1 && restS.length === 1) link(restS[0]!, restB[0]!);
  }
  const freeB: number[] = [], freeS: number[] = [];
  for (let x = 0; x < base.length; x++) if (fromBase[x]! < 0) freeB.push(x);
  for (let y = 0; y < side.length; y++) if (toBase[y]! < 0) freeS.push(y);
  if (freeB.length * freeS.length <= MAX_FUZZY_PAIRS) {
    for (const y of freeS) {
      let best = -1, bestScore = 0, second = 0;
      for (const x of freeB) {
        if (fromBase[x]! >= 0) continue;
        const score = dice(base[x]!, side[y]!);
        if (score > bestScore) { second = bestScore; bestScore = score; best = x; } else if (score > second) second = score;
      }
      if (best >= 0 && bestScore >= FIND_VALID && second < FIND_VALID) { link(y, best); moved.add(y); }
    }
  }
  return { toBase, fromBase, moved };
}

type Node = {
  /** The unit's text: a base unit's own for base nodes, the side's for added ones. */
  unit: Unit;
  baseIndex: number; // -1 = added
  origin: "base" | "mine" | "theirs";
  deleted: boolean;
  /** Added and moved nodes hang after the node that precedes them on their side and travel with it. */
  attached: Node[];
  id: number;
};

type UnitMerge = { merged: string; conflicts: BodyConflict[]; kinds: UnitConflictKind[] };
/** `order`: the units cannot be put in an order both sides agree with (moved to different places, or a cycle).
 *  `kinds` are the edit/delete conflicts found before that: a unit one side deleted and the other moved also breaks the order. */
type UnitMergeResult = UnitMerge | { order: "move-move" | "cycle"; kinds: UnitConflictKind[] } | null;

/** Three-way merge per unit. incoming is the side being saved, current the one on the server. Null: too many distinct units. */
export function mergeUnits(base: string, incoming: string, current: string, mode: UnitMode = "block", rule: BodyMergeRule = CURRENT_BODY_MERGE_RULE): UnitMergeResult {
  const B = splitUnits(base, mode), M = splitUnits(incoming, mode), T = splitUnits(current, mode);
  const mm = matchUnits(B.units, M.units), tm = matchUnits(B.units, T.units);
  if (!mm || !tm) return null;
  const conflicts: BodyConflict[] = [];
  const kinds: UnitConflictKind[] = [];
  const addConflict = (kind: UnitConflictKind, b: string, inc: string, cur: string) => {
    conflicts.push({ base: b, incoming: inc, current: cur, before: "", after: "" });
    kinds.push(kind);
  };

  let nextId = 0;
  const mk = (unit: Unit, baseIndex: number, origin: Node["origin"]): Node => ({ unit, baseIndex, origin, deleted: false, attached: [], id: nextId++ });
  const baseNodes = B.units.map((u, i) => mk(u, i, "base"));
  const head: Node = mk({ text: "", gap: "", kind: "para", key: "" }, -1, "base");
  const nodesOf = (sideName: "mine" | "theirs", S: Doc, m: Side): Node[] =>
    S.units.map((u, y) => (m.toBase[y]! >= 0 ? baseNodes[m.toBase[y]!]! : mk(u, -1, sideName)));
  const mineNodes = nodesOf("mine", M, mm), theirNodes = nodesOf("theirs", T, tm);

  // Content, one base unit at a time.
  const content = new Map<Node, { text: string; gap: string }>();
  const same = (u: Unit | undefined, i: number) => u !== undefined && u.key === B.units[i]!.key;
  // The blank lines after the document's last unit are its ending, not the gap before a next unit.
  const interiorGap = (d: Doc, j: number): string | null => (j >= 0 && j < d.units.length - 1 ? d.units[j]!.gap : null);
  const gapPick = (i: number, mj: number, tj: number): string => {
    const bg = B.units[i]!.gap;
    const mg = interiorGap(M, mj), tg = interiorGap(T, tj);
    if (i === B.units.length - 1) return mg ?? tg ?? bg;
    if (mg !== null && mg !== bg) return mg;
    if (tg !== null && tg !== bg) return tg;
    return bg;
  };
  for (const n of baseNodes) {
    const i = n.baseIndex;
    const mj = mm.fromBase[i]!, tj = tm.fromBase[i]!;
    const mu = mj >= 0 ? M.units[mj] : undefined, tu = tj >= 0 ? T.units[tj] : undefined;
    const movedM = mj >= 0 && mm.moved.has(mj), movedT = tj >= 0 && tm.moved.has(tj);
    const editedM = mu !== undefined && !same(mu, i), editedT = tu !== undefined && !same(tu, i);
    const gap = gapPick(i, mj, tj);
    const baseText = B.units[i]!.text;
    if (mj < 0 && tj < 0) { n.deleted = true; continue; }
    if (mj < 0 || tj < 0) {
      // One side removed it: gone if the other left it alone, else a conflict that keeps incoming's choice.
      const touched = mj < 0 ? (editedT || movedT) : (editedM || movedM);
      if (!touched) { n.deleted = true; continue; }
      if (mj < 0) {
        addConflict(editedT ? "edit-delete" : "move-delete", baseText, "", tu!.text);
        n.deleted = true;
      } else {
        addConflict(editedM ? "edit-delete" : "move-delete", baseText, mu!.text, "");
        content.set(n, { text: mu!.text, gap });
      }
      continue;
    }
    if (editedM && editedT && mu!.key !== tu!.key) {
      const r = threeWayMergeBody(baseText, mu!.text, tu!.text, rule);
      if (r.clean) content.set(n, { text: r.merged, gap });
      else { addConflict("edit-edit", baseText, mu!.text, tu!.text); content.set(n, { text: mu!.text, gap }); }
    } else content.set(n, { text: editedM ? mu!.text : editedT ? tu!.text : baseText, gap });
  }

  // Position: added and moved nodes hang after their predecessor on their side.
  const attachedTo = new Map<Node, Node>();
  let moveMove = false;
  const attach = (n: Node, at: Node) => {
    if (n.baseIndex < 0) { at.attached.push(n); return; }
    if (n.deleted) return;
    const before = attachedTo.get(n);
    if (before !== undefined) {
      if (before !== at) moveMove = true; // the same unit moved to different places
      return;
    }
    attachedTo.set(n, at);
    at.attached.push(n);
  };
  const place = (nodes: Node[], S: Side) => nodes.forEach((n, y) => {
    if (n.baseIndex < 0 || S.moved.has(y)) attach(n, y === 0 ? head : nodes[y - 1]!);
  });
  place(mineNodes, mm);
  place(theirNodes, tm);
  if (moveMove) return { order: "move-move", kinds };

  // Output, depth first.
  const out: Array<{ text: string; gap: string; kind: UnitKind; node: Node }> = [];
  const emitted = new Set<Node>();
  const sortKey = (n: Node) => n.unit.key;
  const order = (xs: Node[]): Node[] => [...xs].sort((x, y) => (sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : x.id - y.id));
  /** A run of added units that each hang after the one before it, from one side. */
  const chainOf = (c: Node): Node[] | null => {
    const chain: Node[] = [];
    for (let x: Node = c; ; ) {
      chain.push(x);
      if (x.attached.length === 0) return chain;
      const next = x.attached[0]!;
      if (x.attached.length !== 1 || next.baseIndex >= 0 || next.origin !== c.origin) return null;
      x = next;
    }
  };
  const emit = (n: Node, depth: number) => {
    if (depth > 100_000 || emitted.has(n)) return;
    emitted.add(n);
    if (n !== head && !n.deleted) {
      const c = content.get(n);
      if (n.baseIndex >= 0) out.push({ text: c!.text, gap: c!.gap, kind: n.unit.kind, node: n });
      else out.push({ text: n.unit.text, gap: n.unit.gap, kind: n.unit.kind, node: n });
    }
    // Both sides added a run at the same place: the line merge's rule for two insertions into an empty text
    // (a shared head and tail once, the rest from both sides in text order).
    const kids: Node[] = [];
    const chains: Record<"mine" | "theirs", Node[][]> = { mine: [], theirs: [] };
    for (const c of n.attached) {
      const chain = c.baseIndex < 0 ? chainOf(c) : null;
      if (chain && (c.origin === "mine" || c.origin === "theirs")) chains[c.origin].push(chain); else kids.push(c);
    }
    if (chains.mine.length === 1 && chains.theirs.length === 1) {
      const text = (ch: Node[]) => { const t = ch.map((x) => x.unit.text + x.unit.gap).join(""); return t.endsWith("\n") ? t : `${t}\n`; };
      const merged = threeWayMergeBody("", text(chains.mine[0]!), text(chains.theirs[0]!), rule).merged.replace(/(\r?\n)+$/, "");
      for (const x of [...chains.mine[0]!, ...chains.theirs[0]!]) emitted.add(x);
      const first = chains.mine[0]![0]!;
      // Rule 3: the gap after the merged runs is the wider of the two runs' gaps, whichever side is incoming (rule 2 took
      // the incoming run's, so swapping the writers could join a paragraph to the list after it).
      const gapOf = (ch: Node[]) => ch[ch.length - 1]!.unit.gap;
      const breaks = (g: string) => g.split("\n").length;
      const [gm, gt] = [gapOf(chains.mine[0]!), gapOf(chains.theirs[0]!)];
      const gap = rule < 3 ? first.unit.gap : breaks(gm) !== breaks(gt) ? (breaks(gm) > breaks(gt) ? gm : gt) : gm < gt ? gm : gt;
      kids.push(mk({ text: merged, gap, kind: first.unit.kind, key: merged }, -1, "mine"));
    } else for (const list of [...chains.mine, ...chains.theirs]) kids.push(list[0]!);
    for (const kid of order(kids)) emit(kid, depth + 1);
  };
  emit(head, 0);
  for (const n of baseNodes) if (!attachedTo.has(n)) emit(n, 0);
  // Nodes never reached hang on each other: no order to give them.
  if ([...baseNodes, ...mineNodes, ...theirNodes].some((n) => (n.baseIndex < 0 || !n.deleted) && !emitted.has(n) && n !== head)) return { order: "cycle", kinds };

  // A unit only one side moved must keep its order against the units the other side did not move. Two adjacent
  // paragraphs swapped is ambiguous (which one moved?), so each side "moving" a different one can give an order
  // neither wrote.
  {
    const posOf = (xs: Node[]) => { const m = new Map<Node, number>(); xs.forEach((n, k) => m.set(n, k)); return m; };
    const merged = posOf(out.map((o) => o.node));
    const sides: Array<[Node[], Side, Side, "mine" | "theirs"]> = [[mineNodes, mm, tm, "mine"], [theirNodes, tm, mm, "theirs"]];
    for (const [nodes, own, other, sideName] of sides) {
      const ownPos = posOf(nodes);
      const otherMoved = (n: Node) => n.baseIndex >= 0 && other.moved.has(other.fromBase[n.baseIndex]!);
      const movedHere = nodes.filter((n, y) => n.baseIndex >= 0 && own.moved.has(y) && merged.has(n) && !otherMoved(n));
      for (const u of movedHere) {
        for (const v of nodes) {
          if (v === u || !merged.has(v) || otherMoved(v) || (v.baseIndex < 0 && v.origin !== sideName)) continue;
          if ((ownPos.get(u)! < ownPos.get(v)!) !== (merged.get(u)! < merged.get(v)!)) return { order: "move-move", kinds };
        }
      }
    }
  }

  // Spacing: the last unit's ending is the one the side that changed it wrote; a missing gap between units is added.
  const endGap = (d: Doc) => d.units.length ? d.units[d.units.length - 1]!.gap : d.lead;
  const finalGap = endGap(M) !== endGap(B) ? endGap(M) : endGap(T);
  const lead = M.lead !== B.lead ? M.lead : T.lead;
  let text = lead;
  out.forEach((u, k) => {
    const last = k === out.length - 1;
    const next = out[k + 1];
    let gap = u.gap;
    if (last) gap = finalGap;
    else if (!/\n/.test(gap) || (mode === "block" && u.kind === "para" && next?.kind === "para" && !/\n[ \t]*\r?\n/.test(gap))) gap = u.kind === "list" && next?.kind === "list" ? "\n" : "\n\n";
    text += u.text + gap;
  });
  return { merged: text, conflicts, kinds };
}

/** The texts of the base units that `text` holds verbatim at another place. */
function movedUnitKeys(baseUnits: Unit[], text: string): Set<string> {
  const units = splitUnits(text).units;
  const side = matchUnits(baseUnits, units, true);
  return new Set(side ? [...side.moved].map((y) => units[y]!.key) : []);
}

/** Rule 3: the base units of a line conflict that a side holds elsewhere. The side's text in the conflict holds the unit
 *  fewer times than base did there, while the side's whole text holds it at least as often as base: that side moved it out
 *  of the region. Read from the line merge's own regions, so it agrees with the line diff on which paragraphs moved (two
 *  paragraphs trading places with two others is the same text either way; the unit diff may pick the other reading). */
function relocatedOutOf(c: BodyConflict, base: string, incoming: string, current: string): Set<string> {
  const counts = (text: string) => {
    const m = new Map<string, number>();
    for (const u of splitUnits(text).units) m.set(u.key, (m.get(u.key) ?? 0) + 1);
    return m;
  };
  const inBase = counts(base), inRegion = counts(c.base);
  const out = new Set<string>();
  for (const [sideText, regionText] of [[incoming, c.incoming], [current, c.current]] as const) {
    const whole = counts(sideText), region = counts(regionText);
    for (const [key, n] of inRegion) if ((region.get(key) ?? 0) < n && (whole.get(key) ?? 0) >= (inBase.get(key) ?? 0)) out.add(key);
  }
  return out;
}

const wholeConflict = (base: string, incoming: string, current: string): BodyMerge =>
  ({ merged: incoming, clean: false, conflicts: [{ base, incoming, current, before: "", after: "" }] });

/** The body merge every caller uses: the line merge, plus moved paragraphs (see the top of this file). `rule` is the merge
 *  rule (CURRENT_BODY_MERGE_RULE); an older one gives exactly what that rule gave, so a merge made under it can be redone. */
export function mergeBody(base: string, incoming: string, current: string, rule: BodyMergeRule = CURRENT_BODY_MERGE_RULE): BodyMerge {
  if (rule === 1) return threeWayMergeBody(base, incoming, current);
  const line = threeWayMergeBody(base, incoming, current, rule);
  if (incoming === current || current === base || incoming === base) return line;
  const baseUnits = splitUnits(base).units;
  const movedIncoming = movedUnitKeys(baseUnits, incoming), movedCurrent = movedUnitKeys(baseUnits, current);
  const rescue = (): BodyMerge | null => {
    const r = mergeUnits(base, incoming, current, "block", rule);
    if (!r || !("merged" in r) || r.conflicts.length > 0 || mergeLossProblems(base, incoming, current, r.merged).length > 0) return null;
    // Rule 3: only a text both writers would get, whichever of them is incoming.
    if (rule >= 3) {
      const swapped = mergeUnits(base, current, incoming, "block", rule);
      if (!swapped || !("merged" in swapped) || swapped.merged !== r.merged) return null;
    }
    return { merged: r.merged, clean: true, conflicts: [] };
  };
  // Rule 3: the line merge holds a line twice. A conflict keeps the incoming text of its region while the current side's
  // move of those lines lands at the new place too; a clean merge can hold a paragraph both writers moved to one place,
  // one of them also editing it, at both places. Either is a move the line merge cannot see: the units merge it, or the
  // whole text is the conflict. A conflict shows the doubled text only with one writer as incoming, so both orders are
  // looked at: the outcome must not depend on which writer saved last.
  if (rule >= 3 && (heldTwice(base, incoming, current, line.merged).length > 0
    || (!line.clean && heldTwice(base, current, incoming, threeWayMergeBody(base, current, incoming, rule).merged).length > 0))) {
    return rescue() ?? wholeConflict(base, incoming, current);
  }
  if (!line.clean) {
    // Only conflicts that a verbatim move explains are the units' to resolve: every conflicting base region is made of
    // moved units. Two writers rewriting a short paragraph beyond recognition is no move, and the unit merge would keep
    // both rewrites.
    const moved = [...movedIncoming, ...movedCurrent];
    const explained = (c: BodyConflict) => {
      const keys = rule >= 3 ? [...moved, ...relocatedOutOf(c, base, incoming, current)] : moved;
      return keys.length > 0 && keys.reduce((rest, key) => rest.replace(key, ""), c.base).trim() === "";
    };
    return (line.conflicts.every(explained) ? rescue() : null) ?? line;
  }
  // Clean, yet it may have kept one writer's move only, or both: look only when both sides moved a unit. Two moves
  // of one paragraph show as a doubled or missing line in the line merge's text, or as an order the units cannot
  // agree on. (Two adjacent paragraphs swapped is ambiguous: which one moved? The line count catches that.)
  if (movedIncoming.size === 0 || movedCurrent.size === 0) return line;
  const units = mergeUnits(base, incoming, current, "block", rule);
  // Not when a unit was also deleted by one side and moved by the other: the order is then ambiguous in a way that
  // depends on which side is incoming, and that case is not this rule's to decide.
  const ordering = units !== null && "order" in units && units.kinds.length === 0;
  if (ordering || mergeLossProblems(base, incoming, current, line.merged).length > 0) return wholeConflict(base, incoming, current);
  return line;
}
