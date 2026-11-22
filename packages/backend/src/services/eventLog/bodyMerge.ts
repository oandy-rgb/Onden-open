// Three-way merge of a note body, line by line (diff3, as git merges files).
//
// base     — what the writer last loaded
// incoming — what the writer now sends
// current  — what the server holds (another writer landed in between)
//
// Each side's change is a list of hunks over base lines, found by an exact
// line diff. Hunks from the two sides that touch the same base lines are one
// region: if only one side changed it, that change lands; if both changed it
// the same way, it lands once; otherwise it is a CONFLICT. Nothing is matched
// fuzzily, so an edit never lands on text it was not made against.
//
// Why not diff-match-patch's patch_apply (the previous merge): it is
// character-based and fuzzy. Two writers changing the same word ("一" → "二"
// and "一" → "三") applied cleanly — the patch's context still matched — so the
// other writer's word vanished with no conflict recorded.
//
// A conflict region keeps the incoming side in the merged body (the writer
// whose editor sent it is looking at that text) and is returned with both
// sides, so the losing text can be offered back instead of only living in
// version history.
//
// Placement rules for regions that only meet at an edge:
//   - two insertions at the same point: one region (their order is unknown).
//     What both wrote lands once: the exact common head and tail of the two
//     insertions (whole lines at line level, characters inside a line) are
//     kept once, and what differs between them stays from both sides, in a
//     fixed order (mergeInsertions). Two separate paragraphs stay two: a blank
//     line goes between them. Typing inside one line is merged
//     character by character (mergeChars), where only an insertion that
//     contains the other is cut (a coincidental shared "[" is not). A conflict when either side also
//     removed or rewrote text there.
//   - an insertion at the start or end of the other side's replaced lines:
//     not a conflict; the insertion goes before or after them.

import { fenceScanner } from "@onden/markdown";
import { diffRuns } from "./bodyPatch.js";

export type BodyConflict = {
  /** The base lines both sides changed. */
  base: string;
  /** The incoming side's text — what the merged body holds here. */
  incoming: string;
  /** The current (server) side's text — what the merge left out. */
  current: string;
  /** The merged body's line before and after `incoming` ("" at an edge), so
   *  the region can be found again after later edits. */
  before: string;
  after: string;
};

export type BodyMerge = { merged: string; clean: boolean; conflicts: BodyConflict[] };

/** Split keeping each line's "\n", so joining the pieces gives the text back. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

type Hunk = { start: number; end: number; lines: string[] };

/** diffRuns over the encoded lines, anchored on the lines both sides hold
 *  exactly once (as `git diff --patience` does). A plain diff of text with
 *  repeated lines (blank ones) may pick the alignment that matches the blank
 *  lines and calls the one distinctive line between them moved; the merge then
 *  lands that line twice. The anchors are the longest run of such lines in
 *  the same order, so they are common to both sides; the diff runs between them. */
function anchoredRuns(a: string, b: string): Array<[-1 | 0 | 1, string]> {
  const countIn = (text: string) => {
    const counts = new Map<string, number>();
    for (let k = 0; k < text.length; k++) counts.set(text[k]!, (counts.get(text[k]!) ?? 0) + 1); // one UTF-16 unit per line
    return counts;
  };
  const inA = countIn(a), inB = countIn(b);
  const posInB = new Map<string, number>();
  for (let j = 0; j < b.length; j++) if (inB.get(b[j]!) === 1) posInB.set(b[j]!, j);
  // Longest increasing subsequence of b-positions, walking a's unique lines.
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < a.length; i++) {
    const j = inA.get(a[i]!) === 1 ? posInB.get(a[i]!) : undefined;
    if (j !== undefined) pairs.push([i, j]);
  }
  const tails: number[] = []; // index into pairs of the smallest tail per length
  const prev: number[] = new Array(pairs.length).fill(-1);
  pairs.forEach(([, j], k) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]!]![1] < j) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[k] = tails[lo - 1]!;
    tails[lo] = k;
  });
  const anchors: Array<[number, number]> = [];
  for (let k = tails.length ? tails[tails.length - 1]! : -1; k >= 0; k = prev[k]!) anchors.unshift(pairs[k]!);
  if (anchors.length === 0) return diffRuns(a, b);
  const runs: Array<[-1 | 0 | 1, string]> = [];
  let i = 0, j = 0;
  for (const [ai, bj] of [...anchors, [a.length, b.length] as [number, number]]) {
    runs.push(...diffRuns(a.slice(i, ai), b.slice(j, bj)));
    if (ai < a.length) runs.push([0, a[ai]!]);
    i = ai + 1; j = bj + 1;
  }
  return runs;
}

/** The hunks turning `base` into `other`: replace base[start, end) with lines. */
function lineHunks(base: string[], other: string[], runs: typeof diffRuns = anchoredRuns): Hunk[] {
  // Encode each distinct line as one character, then diff the encodings.
  const ids = new Map<string, number>();
  const encode = (lines: string[]) => {
    let out = "";
    for (const line of lines) {
      let id = ids.get(line);
      if (id === undefined) { id = ids.size; ids.set(line, id); }
      out += String.fromCharCode(id);
    }
    return out;
  };
  const a = encode(base);
  const b = encode(other);
  // More distinct lines than one UTF-16 unit can name: no line diff, the
  // whole body is one hunk (a conflict if the other side changed it too).
  if (ids.size > 0xffff) return a === b ? [] : [{ start: 0, end: base.length, lines: other }];
  const hunks: Hunk[] = [];
  let i = 0; // base line
  let j = 0; // other line
  let open: Hunk | null = null;
  for (const [op, text] of runs(a, b)) {
    const n = text.length;
    if (op === 0) {
      if (open) { hunks.push(open); open = null; }
      i += n; j += n;
      continue;
    }
    open ??= { start: i, end: i, lines: [] };
    if (op === -1) { i += n; open.end = i; }
    else { open.lines.push(...other.slice(j, j + n)); j += n; }
  }
  if (open) hunks.push(open);
  return hunks;
}

const empty = (h: Hunk) => h.start === h.end;

function overlaps(x: Hunk, y: Hunk): boolean {
  if (empty(x) && empty(y)) return x.start === y.start;
  if (empty(x)) return y.start < x.start && x.start < y.end;
  if (empty(y)) return x.start < y.start && y.start < x.end;
  return x.start < y.end && y.start < x.end;
}

/** One side's text over base[start, end), with its hunks applied. */
function applyHunks(base: string[], start: number, end: number, hunks: Hunk[]): string[] {
  const out: string[] = [];
  let at = start;
  for (const h of hunks) {
    out.push(...base.slice(at, h.start), ...h.lines);
    at = h.end;
  }
  out.push(...base.slice(at, end));
  return out;
}

// Earlier start first; at the same start, an insertion before a replacement.
const byPosition = (x: Hunk, y: Hunk) => x.start - y.start || Number(!empty(x)) - Number(!empty(y));

type Region = { start: number; end: number; mine: Hunk[]; theirs: Hunk[] };

/** Walk both sides' hunks region by region, copying untouched base units and
 *  each region's merged units to `out`. A region only one side (or both, the
 *  same way) changed lands as is; `both` decides the rest. `out.length` at the
 *  call is where the region's units will start. */
function mergeRegions(
  baseUnits: string[], mine: Hunk[], theirs: Hunk[], out: string[],
  both: (region: Region, ours: string[], other: string[]) => string[],
): void {
  let at = 0; // base units copied so far
  let m = 0;
  let t = 0;
  while (m < mine.length || t < theirs.length) {
    // Seed a region with the earliest pending hunk, then pull in every hunk
    // from either side that overlaps a hunk already in it.
    const fromMine = t >= theirs.length || (m < mine.length && byPosition(mine[m]!, theirs[t]!) <= 0);
    const region = { start: 0, end: 0, mine: [] as Hunk[], theirs: [] as Hunk[] };
    if (fromMine) region.mine.push(mine[m++]!); else region.theirs.push(theirs[t++]!);
    for (let grew = true; grew;) {
      grew = false;
      const members = [...region.mine, ...region.theirs];
      if (m < mine.length && members.some((h) => overlaps(h, mine[m]!))) { region.mine.push(mine[m++]!); grew = true; }
      if (t < theirs.length && members.some((h) => overlaps(h, theirs[t]!))) { region.theirs.push(theirs[t++]!); grew = true; }
    }
    const all = [...region.mine, ...region.theirs];
    region.start = Math.min(...all.map((h) => h.start));
    region.end = Math.max(...all.map((h) => h.end));
    out.push(...baseUnits.slice(at, region.start));
    at = region.end;
    const ours = applyHunks(baseUnits, region.start, region.end, region.mine);
    if (region.theirs.length === 0) { out.push(...ours); continue; }
    const other = applyHunks(baseUnits, region.start, region.end, region.theirs);
    if (region.mine.length > 0 && ours.join("") !== other.join("")) out.push(...both(region, ours, other));
    else out.push(...other);
  }
  out.push(...baseUnits.slice(at));
}

/** The state after each prefix of `lines` (index i = after i lines): whether a fenced code block is open. One pass. */
function fenceOpenAfter(lines: string[]): boolean[] {
  const scan = fenceScanner();
  const open = [false];
  for (const line of lines) { const state = scan(line.replace(/\r?\n$/, "")); open.push(state === "open" || state === "inside"); }
  return open;
}

/** How many of the last lines of `shared` can be kept as a shared tail without cutting a fenced block
 *  (read from the shared lines alone, so it is the same whichever side asks). */
function keptTail(shared: string[]): number {
  const closed = (from: number) => !fenceOpenAfter(shared.slice(from)).at(-1);
  if (closed(0)) return shared.length;
  // Unclosed: drop leading lines until what is left is balanced; a bounded search, since the
  // shared tail can be long and this runs on every save.
  for (let from = 1; from < Math.min(shared.length, 64); from++) if (closed(from)) return shared.length - from;
  return 0;
}

/** What surrounds two line insertions: the lines just before and after the point (undefined at the note's edge). */
type LineContext = { before?: string; after?: string; eol: string };
const isBlank = (line: string | undefined) => line === undefined || line.trim() === "";

/** Two insertions at one point, as unit arrays (lines or characters): the
 *  exact common head and tail land once, the differing middles both stay in
 *  code-unit order. Head and tail never overlap (together at most the shorter
 *  insertion), so one side containing the other gives the longer one. The
 *  result does not depend on which side is `ours`.
 *  Lines (`around`):
 *  - a shared head or tail never cuts a fenced code block in two (two code blocks both opening and
 *    closing with "```" would become one block) — only when both middles differ; a side that
 *    contains the other is taken whole;
 *  - two separate paragraphs stay two: the blank lines around them were the shared head/tail, so
 *    trimming them left the blocks touching ("x\ny", one paragraph). A blank line goes between them
 *    when both stand alone (blank, or the note's edge, on both sides, and at least one real blank
 *    line: two bodies written into an empty note have nothing saying they are paragraphs, and
 *    lines of one list stay a list). A block that continues a list or paragraph keeps touching it. */
function mergeInsertions(ours: string[], other: string[], containedOnly = false, around?: LineContext): string[] {
  const max = Math.min(ours.length, other.length);
  let head = 0;
  while (head < max && ours[head] === other[head]) head++;
  let tail = 0;
  while (tail < max - head && ours[ours.length - 1 - tail] === other[other.length - 1 - tail]) tail++;
  if (around && head + tail < ours.length && head + tail < other.length) {
    const open = fenceOpenAfter(ours.slice(0, head));
    while (head > 0 && open[head]) head--;
    tail = keptTail(ours.slice(ours.length - tail));
  }
  const a = ours.slice(head, ours.length - tail);
  const b = other.slice(head, other.length - tail);
  // Inside one line a shared head/tail of different words is coincidence
  // ("[A]" and "[B]" share "[" and "]"): splicing there would mix the two
  // words, so only a side that contains the other is cut.
  if (containedOnly && a.length > 0 && b.length > 0) {
    const [x, y] = ours.join("") < other.join("") ? [ours, other] : [other, ours];
    return [...x, ...y];
  }
  const [first, second] = a.join("") < b.join("") ? [a, b] : [b, a];
  const before = head > 0 ? ours[head - 1] : around?.before;
  const after = tail > 0 ? ours[ours.length - tail] : around?.after;
  const alone = around && first.length > 0 && second.length > 0
    && isBlank(before) && isBlank(after) && !(before === undefined && after === undefined)
    && !isBlank(first[first.length - 1]) && !isBlank(second[0]);
  return [...ours.slice(0, head), ...first, ...(alone ? [around.eol] : []), ...second, ...ours.slice(ours.length - tail)];
}

/** Past this many characters a conflicting region is not tried character by
 *  character: the diff would cost more than it is worth. */
const CHAR_MERGE_MAX = 20_000;

/** Both writers changed the same lines. When both only ADDED text (typing,
 *  pasting; no character removed or replaced), merge again character by
 *  character: the additions land where each was made, and two made at one
 *  point both stay, in code-unit order of the added text — not by which save
 *  landed first, so a replay or the other tab's merge gives the same body.
 *  Null as soon as either side removed or rewrote characters:
 *  merging two rewrites piecewise would splice them into text neither writer
 *  wrote, so that stays a conflict (the later save kept, the other offered
 *  back). */
function mergeChars(base: string, incoming: string, current: string): string | null {
  if (base.length + incoming.length + current.length > CHAR_MERGE_MAX) return null;
  const baseChars = Array.from(base);
  const mine = lineHunks(baseChars, Array.from(incoming), diffRuns);
  const theirs = lineHunks(baseChars, Array.from(current), diffRuns);
  if (![...mine, ...theirs].every(empty)) return null;
  const out: string[] = [];
  // Two additions in one region can only be at one point (they would not
  // overlap otherwise).
  mergeRegions(baseChars, mine, theirs, out, (_region, ours, other) => mergeInsertions(ours, other, true));
  return out.join("");
}

/** Which body merge rule to apply. Rules 1 and 2 are kept as they were so a merge made under them can be computed again;
 *  3 changes how a conflicting region of several lines is merged character by character (`mergeLineByLine`) and what
 *  mergeBody does with a line held twice (bodyMergeMoves.ts). */
export type BodyMergeRule = 1 | 2 | 3;
/** The rule writes, restore and sync use now. distributedSync/types.ts publishes it as BODY_MERGE_RULE_VERSION for the
 *  sync version gate; changing what mergeBody returns adds one here. */
export const CURRENT_BODY_MERGE_RULE: BodyMergeRule = 3;

/** Rule 3's character merge of a conflicting region of whole lines. Rules 1–2 diffed the region as one string of
 *  characters, and that diff may match a base line's characters to a line the other writer newly wrote (the "。" of
 *  "段落。" to the "。" of a new paragraph "新增。"): the first writer's addition then landed inside the new paragraph,
 *  a line neither writer wrote. Here the lines are paired first and characters merged only within a pair:
 *  - each base line is paired with the one line of each side that holds it with characters only added (a
 *    subsequence), in order; a base line no single line holds, but a run of lines does, was split (Enter typed inside
 *    it) and pairs with that run; the side's other lines are lines it inserted;
 *  - when a base line has no such line (deleted, rewritten) or more than one pairing is possible (which line the writer
 *    edited is unknown), null: the region stays a conflict;
 *  - the pairs and insertions are merged like any lines (mergeRegions): a base line both writers edited is merged
 *    character by character with only its own versions (mergeChars, both only added), two insertions at one point by
 *    mergeInsertions.
 *  So no writer's addition lands on a line the other writer newly wrote. */
function mergeLineByLine(base: string[], ours: string[], other: string[], around: LineContext, baseLines: Set<string>): string[] | null {
  if (base.join("").length + ours.join("").length + other.join("").length > CHAR_MERGE_MAX) return null;
  const mine = pairedHunks(base, ours, baseLines), theirs = pairedHunks(base, other, baseLines);
  if (!mine || !theirs) return null;
  const out: string[] = [];
  let failed = false;
  mergeRegions(base, mine, theirs, out, (region, a, b) => {
    if (region.start === region.end) {
      return mergeInsertions(a, b, false, {
        before: region.start > 0 ? base[region.start - 1] : around.before,
        after: region.start < base.length ? base[region.start] : around.after,
        eol: around.eol,
      });
    }
    // A pair replaces one base line and insertions never overlap a pair, so this region is one base line both edited.
    const chars = a.length > 1 || b.length > 1
      ? mergeSplitLine(base[region.start]!, a.join(""), b.join(""))
      : mergeChars(base[region.start]!, a.join(""), b.join(""));
    if (chars === null) { failed = true; return a; }
    return splitLines(chars);
  });
  return failed ? null : out;
}

/** Where `line`'s characters are in `text` (a subsequence), matched from the start or from the end. */
function embed(line: string, text: string, forward: boolean): number[] {
  const at = new Array<number>(line.length);
  if (forward) for (let k = 0, x = 0; k < line.length; k++, x++) { while (text[x] !== line[k]) x++; at[k] = x; }
  else for (let k = line.length - 1, x = text.length - 1; k >= 0; k--, x--) { while (text[x] !== line[k]) x--; at[k] = x; }
  return at;
}

/** One base line both writers only added characters to, at least one of them also splitting it over several lines.
 *  Which line a base character went to can be read more than one way ("下週要交報告1。" split into "下週要交報告1",
 *  "甲0加的一行。", "。": is the "。" the last line, or the end of the inserted one?), and the other writer's
 *  addition next to it would land on a different line. So the characters are matched both from the start and from
 *  the end of each side, the merge is done for each reading, and taken only when they all give the same text. Two
 *  additions at one point keep the same-line rule (mergeInsertions: both, in code-unit order), also when one of them is
 *  the line break: Enter pressed where the other writer typed. Null: a conflict. */
function mergeSplitLine(base: string, ours: string, other: string): string | null {
  if (base.length + ours.length + other.length > CHAR_MERGE_MAX) return null;
  const mergeWith = (pa: number[], pb: number[]): string | null => {
    let out = "";
    for (let k = 0; k <= base.length; k++) {
      const x = ours.slice(k === 0 ? 0 : pa[k - 1]! + 1, k === base.length ? ours.length : pa[k]);
      const y = other.slice(k === 0 ? 0 : pb[k - 1]! + 1, k === base.length ? other.length : pb[k]);
      out += x && y && x !== y ? mergeInsertions(Array.from(x), Array.from(y), true).join("") : x || y;
      if (k < base.length) out += base[k];
    }
    return out;
  };
  const results = new Set<string | null>();
  for (const fa of [true, false]) for (const fb of [true, false]) results.add(mergeWith(embed(base, ours, fa), embed(base, other, fb)));
  const [only] = results;
  return results.size === 1 && only !== undefined ? only : null;
}

/** Whether `line`'s characters appear in order in `text`. */
function holds(line: string, text: string): boolean {
  let k = 0;
  for (let x = 0; x < text.length && k < line.length; x++) if (text[x] === line[k]) k++;
  return k === line.length;
}

/** The lines [first, last] of `to` a base line pairs with, searching forward from line `from` (or backward from it):
 *  the nearest single line that holds it, else the run its characters were split over, matched nearest first. Null: none. */
function pairOf(line: string, to: string[], from: number, forward: boolean, baseLines: Set<string>): [number, number] | null {
  const step = forward ? 1 : -1;
  for (let j = from; j >= 0 && j < to.length; j += step) if (holds(line, to[j]!)) return [j, j];
  // Split: match the characters greedily, nearest first; the run is the lines the matched characters are on.
  let k = forward ? 0 : line.length - 1, first = -1, last = -1;
  for (let j = from; j >= 0 && j < to.length && k >= 0 && k < line.length; j += step) {
    const text = to[j]!;
    for (let x = forward ? 0 : text.length - 1; x >= 0 && x < text.length && k >= 0 && k < line.length; x += step) {
      if (text[x] !== line[k]) continue;
      if (first < 0) first = j;
      last = j;
      k += step;
    }
  }
  if (k >= 0 && k < line.length) return null;
  const [lo, hi] = forward ? [first, last] : [last, first];
  // A line of the run that holds base characters is a piece of this line only if it is not another base line (moved
  // there) and holds at least two letters, digits or ideographs of it: "。", "1" or " " end or fill many lines, and
  // holding one of those is no sign of a piece (it may be a line the writer newly wrote, and the other writer's
  // addition next to that "。" would land in it).
  const run = to.slice(lo, hi + 1), at = embed(line, run.join(""), forward);
  let start = 0;
  for (const piece of run) {
    const end = start + piece.length;
    const held = at.flatMap((x, c) => (x >= start && x < end ? [line[c]!] : []));
    if (held.length > 0 && (baseLines.has(piece) || held.filter((ch) => WORD.test(ch)).length < 2)) return null;
    start = end;
  }
  return [lo, hi];
}
const WORD = /[\p{L}\p{N}]/u;

/** `side` as hunks over `base` when every base line pairs with one line (or the run it was split into) that holds it
 *  with characters only added, in order (see mergeLineByLine); null otherwise. Identical lines are paired by the line
 *  diff, as the line merge pairs them; inside each of its hunks, the base lines it replaced pair by subsequence,
 *  searched from the start and from the end: a single line must be the same both ways (else it is not unique). */
function pairedHunks(base: string[], side: string[], baseLines: Set<string>): Hunk[] | null {
  const out: Hunk[] = [];
  for (const h of lineHunks(base, side)) {
    const from = base.slice(h.start, h.end), to = h.lines;
    const pairs: Array<[number, number]> = [];
    for (let i = 0, j = 0; i < from.length; i++) {
      const p = pairOf(from[i]!, to, j, true, baseLines);
      if (!p) return null;
      pairs.push(p);
      j = p[1] + 1;
    }
    for (let i = from.length - 1, j = to.length - 1; i >= 0; i--) {
      const p = pairOf(from[i]!, to, j, false, baseLines);
      if (!p) return null;
      const f = pairs[i]!;
      if (p[0] !== f[0] || p[1] !== f[1]) {
        // Two single lines: which one the writer edited is unknown. A split: the run is read both ways; the pair is the
        // lines either reading uses, and mergeSplitLine takes it only if both readings merge to the same text.
        if (p[0] === p[1] && f[0] === f[1]) return null;
        pairs[i] = [Math.min(f[0], p[0]), Math.max(f[1], p[1])];
      }
      j = p[0] - 1;
    }
    for (let i = 1; i < pairs.length; i++) if (pairs[i]![0] <= pairs[i - 1]![1]) return null;
    let next = 0; // line of `to`
    pairs.forEach(([first, last], i) => {
      if (first > next) out.push({ start: h.start + i, end: h.start + i, lines: to.slice(next, first) });
      if (first !== last || to[first] !== from[i]) out.push({ start: h.start + i, end: h.start + i + 1, lines: to.slice(first, last + 1) });
      next = last + 1;
    });
    if (next < to.length) out.push({ start: h.end, end: h.end, lines: to.slice(next) });
  }
  return out;
}

export function threeWayMergeBody(base: string, incoming: string, current: string, rule: BodyMergeRule = 1): BodyMerge {
  if (incoming === current || current === base) return { merged: incoming, clean: true, conflicts: [] };
  if (incoming === base) return { merged: current, clean: true, conflicts: [] };
  // Every side ends with "\n" while merging, so text added after a last line
  // that had none is an insertion, not a change of that line. The result ends
  // without one when the side that changed the ending (else the others) did.
  // An empty body has no lines and no ending: closing it would invent a blank
  // line that the other side's text then lands next to as a duplicate. The
  // ending added is the bodies' own (CRLF when any side has one), the same for
  // all three: "B" closed as "B\n" in one side and "B\r\n" in another would
  // read as a changed line.
  const open = (text: string) => text !== "" && !text.endsWith("\n");
  // An empty side has no ending to vote with (the line above): when the other
  // side deleted the whole body, reading "" as "ends with a newline" gave the
  // merged text a trailing "\n" nobody typed, and the next merge trimmed it again.
  const noFinalNewline = incoming !== "" && open(incoming) !== open(base) ? open(incoming)
    : current !== "" ? open(current) : open(incoming);
  const eol = [base, incoming, current].some((text) => text.includes("\r\n")) ? "\r\n" : "\n";
  const close = (text: string) => open(text) ? `${text}${eol}` : text;
  const baseLines = splitLines(close(base));
  const mine = lineHunks(baseLines, splitLines(close(incoming)));
  const theirs = lineHunks(baseLines, splitLines(close(current)));
  const out: string[] = [];
  const conflicts: Array<BodyConflict & { line: number; lines: number }> = [];
  let allBase: Set<string> | undefined;
  mergeRegions(baseLines, mine, theirs, out, (region, ours, other) => {
    // Both sides only inserted lines at one point: merge whole lines, so the
    // common head/tail is cut at line edges, never inside a line.
    if (region.start === region.end) return mergeInsertions(ours, other, false, { before: baseLines[region.start - 1], after: baseLines[region.start], eol });
    if (rule >= 3) {
      allBase ??= new Set(baseLines);
      const lines = mergeLineByLine(baseLines.slice(region.start, region.end), ours, other, { before: baseLines[region.start - 1], after: baseLines[region.end], eol }, allBase);
      if (lines !== null) return lines;
    } else {
      const chars = mergeChars(baseLines.slice(region.start, region.end).join(""), ours.join(""), other.join(""));
      if (chars !== null) return splitLines(chars);
    }
    conflicts.push({
      base: baseLines.slice(region.start, region.end).join(""), incoming: ours.join(""), current: other.join(""),
      before: "", after: "", line: out.length, lines: ours.length,
    });
    return ours;
  });
  const merged = out.join("");
  const trim = (text: string) => !noFinalNewline ? text : text.endsWith(eol) ? text.slice(0, -eol.length) : text.endsWith("\n") ? text.slice(0, -1) : text;
  return {
    merged: trim(merged),
    clean: conflicts.length === 0,
    conflicts: conflicts.map(({ line, lines, ...c }) => {
      const last = line + lines === out.length;
      return {
        ...c,
        incoming: last ? trim(c.incoming) : c.incoming,
        current: last ? trim(c.current) : c.current,
        before: out[line - 1] ?? "",
        // The body's last line loses the "\n" the merge added to it.
        after: last ? "" : line + lines === out.length - 1 ? trim(out[line + lines]!) : out[line + lines]!,
      };
    }),
  };
}

/** Past this many characters of conflict text, BODY_CONFLICT keeps only the
 *  count: the left-out text is then in version history, not in the event. */
const PAYLOAD_TEXT_MAX = 50_000;

/** BODY_CONFLICT's payload: the conflicts (or just their count when large). */
export function bodyConflictPayload(conflicts: BodyConflict[]): { conflicts: BodyConflict[]; conflict_count: number; truncated?: true } {
  const size = conflicts.reduce((n, c) => n + c.base.length + c.incoming.length + c.current.length + c.before.length + c.after.length, 0);
  return size > PAYLOAD_TEXT_MAX
    ? { conflicts: [], conflict_count: conflicts.length, truncated: true }
    : { conflicts, conflict_count: conflicts.length };
}
