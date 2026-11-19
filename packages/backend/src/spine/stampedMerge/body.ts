// A body written on two nodes. Not a merge written here: `merge` is the one body merge (services/eventLog/bodyMergeMoves.ts
// `mergeBody`, rule version 2), passed in because spine/ may not import services/ (the caller, in services/, holds the reference).
//
// The answer is a VIEW of the unit's heads, not a new write: every node holding the same heads computes the same text,
// and a caller that wants to store the result must stamp it with an id derived from the heads (body-history-merge §5 item 5),
// otherwise two nodes each store a different "merged" write and the merge itself becomes the next conflict.
//
//   one value                        its text.
//   several, a base is known         fold from the oldest stamp to the newest: each newer text is merged into what the older ones gave
//                                    (`mergeBody(base, newer /*incoming*/, folded /*current*/)`), so a conflict keeps the newer text
//                                    in the body and offers the other back, exactly as a conflict does on one node.
//   several, no base                 never merged: the newest text stays, the others are returned whole ("needs-decision").
// The base is the caller's: the version both writers started from (found by body hash + the field's stamp, add-device-snapshot §5).

import { type Cell, type Unit, canonical, compareStamps, sameContent } from "./unit.js";
import { type AnchorFact, chooseAnchorHead, parseAnchorUnit, usableFact } from "./anchorUnit.js";

export type { AnchorFact } from "./anchorUnit.js";

export type BodyMergeFn = (base: string, incoming: string, current: string) => { merged: string; clean: boolean };

export type BodyResolution =
  | { kind: "single"; text: string }
  | { kind: "merged"; text: string }
  /** The merge could not combine them: `text` is what the body shows (the newer side), `offered` the texts that were left out, each with its stamp. */
  | { kind: "conflict"; text: string; offered: Cell[] }
  | { kind: "needs-decision"; text: string; offered: Cell[]; reason: "no-base" };

export function resolveBody(unit: Unit, base: string | null, merge: BodyMergeFn): BodyResolution {
  const distinct: Cell[] = [];
  for (const c of unit.filter((x) => !x.deleted).sort((a, b) => compareStamps(a.stamp, b.stamp))) if (!distinct.some((d) => sameContent(d, c))) distinct.push(c);
  const newest = distinct[distinct.length - 1];
  if (!newest) return { kind: "single", text: "" };
  if (distinct.length === 1) return { kind: "single", text: newest.value as string };
  if (base === null) return { kind: "needs-decision", text: newest.value as string, offered: distinct.slice(0, -1), reason: "no-base" };
  let text = distinct[0]!.value as string;
  let folded: Cell[] = [distinct[0]!]; // the writes `text` is made of since the last conflict
  const offered: Cell[] = [];
  for (const next of distinct.slice(1)) {
    const r = merge(base, next.value as string, text);
    if (!r.clean) { offered.push(...folded); folded = [next]; } else folded.push(next);
    text = r.merged;
  }
  return offered.length ? { kind: "conflict", text, offered } : { kind: "merged", text };
}

// ── The anchors of a body (anchors proposal 2026-11-16 §3.1 design A, steps 2-3) ─────────────────────────────────────────────────────────────────────────────
// An anchor's place is written by the same write as the body it was measured on (its note's anchors unit, note_anchor_places, migration 215), so each head of the body carries its anchors.
// Which anchors go with the text `resolveBody` answers:
//   single, needs-decision   the text IS one head's: its anchors as that head wrote them, never worked out again on the receiver. A text that was left out (`offered`)
//                            keeps its own anchors too (`offeredAnchors`): each version stays with the anchors measured on it.
//   merged, conflict         a text nobody wrote: `mergeAnchors`, a pure function of (base and its anchors, every head and its anchors, the merged text). This is the
//                            only place such a text gets anchors; the receiver of a single head never calls it.

/** A body version and the anchors written with it. */
export type BodyVersion = { text: string; anchors: readonly AnchorFact[] };
/** The ONE rule that carries a version's anchors onto another text, from the texts and the anchors alone (no editor ChangeSet, no budget, no clock): the caller passes
 *  services/blockAnchors/mapping.ts `moveAnchors` with every position trusted and no find budget (spine/ may not import services/). It must be pure. */
export type MoveAnchorsFn = (anchors: readonly AnchorFact[], from: string, to: string) => AnchorFact[];

const factText = (a: AnchorFact): string => canonical(a);
const byId = (x: AnchorFact, y: AnchorFact) => (x.anchorId < y.anchorId ? -1 : x.anchorId > y.anchorId ? 1 : 0);
const copyFact = (a: AnchorFact): AnchorFact => ({ ...a, candidate: a.candidate ? { ...a.candidate } : null });

/** The usable anchors of one version, one per id: when a version names an id twice, the smallest by content (the same whatever the order it was given in). */
function factsOfVersion(anchors: readonly unknown[]): Map<string, AnchorFact> {
  const out = new Map<string, AnchorFact>();
  for (const raw of anchors) {
    const f = usableFact(raw);
    if (!f) continue;
    const had = out.get(f.anchorId);
    if (!had || factText(f) < factText(had)) out.set(f.anchorId, f);
  }
  return out;
}

/**
 * The anchors of `merged`, a text made of several heads (`resolveBody` kind merged or conflict). Pure, total (an unusable fact or head is left out, nothing throws), and a
 * function of the SET of heads: the same heads in any order, any of them twice, give the same rows, byte for byte (sorted by id). For each anchor id:
 *   - the heads that hold it AND changed the text (their text is not the base's) say where it is; when none changed the text, the heads that hold it do (a paragraph a head
 *     only anchored). A head whose text is `merged` gives its anchors as they are; any other is carried onto `merged` by `move`.
 *   - all of them say the same place (status, position, candidate): that, with the words the merged text has there when one of them says those. Otherwise the anchor is `maybe`, stands nowhere, and its candidate is the smallest of the places they name: two writers disagree
 *     about one paragraph, and the person confirms it (proposal §3.1: "不一致就以「備選」表示，不靜靜選一邊").
 * So with one side unchanged (its text is the base's) the result is the other side's anchors unchanged, plus any anchor only the unchanged side holds.
 */
export function mergeAnchors(m: { base: BodyVersion | null; heads: readonly BodyVersion[]; merged: string }, move: MoveAnchorsFn): AnchorFact[] {
  // nothing below depends on the order of the heads or on a head given twice: ids are taken in order, what the heads say is a set, and a disagreement is settled by content
  const placed = m.heads.filter((h) => typeof h?.text === "string" && Array.isArray(h.anchors)).map((h) => {
    const own = [...factsOfVersion(h.anchors).values()];
    return { changed: m.base === null || h.text !== m.base.text, anchors: factsOfVersion(h.text === m.merged ? own : move(own, h.text, m.merged)) };
  });
  const ids = [...new Set(placed.flatMap((p) => [...p.anchors.keys()]))].sort();
  const out: AnchorFact[] = [];
  for (const id of ids) {
    const holders = placed.filter((p) => p.anchors.has(id));
    const writers = holders.filter((p) => p.changed);
    const says = (writers.length ? writers : holders).map((p) => p.anchors.get(id)!);
    const distinct = [...new Map(says.map((a) => [factText(a), a] as const)).values()].sort((x, y) => (factText(x) < factText(y) ? -1 : 1));
    // they agree on where it is (status, position, candidate) and differ only in the words they last saw there: that place, with the words the merged text has there when
    // one of them says those, else the smallest by content
    const placeOf = (a: AnchorFact) => canonical({ s: a.status, f: a.from, t: a.to, c: a.candidate });
    if (new Set(distinct.map(placeOf)).size === 1) {
      const here = distinct.find((a) => a.status === "valid" && a.quote === m.merged.slice(a.from, a.to)) ?? distinct[0]!;
      out.push(copyFact(here));
      continue;
    }
    const places = distinct.map((a) => (a.status === "valid" ? { from: a.from, to: a.to } : a.candidate)).filter((p): p is { from: number; to: number } => p !== null)
      .sort((x, y) => x.from - y.from || x.to - y.to);
    const candidate = places[0] ?? null;
    out.push({ ...copyFact(distinct[0]!), status: "maybe", from: 0, to: 0, candidate: candidate ? { ...candidate } : null, recoveryPending: false });
  }
  return out.sort(byId);
}

/** `resolveBody` with the anchors of its answer: the text and the anchors that go with it, and each left-out version with its own anchors. `anchorsOf` gives a head's anchors
 *  (the anchors unit's head measured on that head's text, `anchorsOfVersion`). Unusable facts are left out (`usableFact`). */
export function resolveBodyAnchors(unit: Unit, base: BodyVersion | null, merge: BodyMergeFn, anchorsOf: (head: Cell) => readonly AnchorFact[], move: MoveAnchorsFn):
  BodyResolution & { anchors: AnchorFact[]; offeredAnchors: AnchorFact[][] } {
  const r = resolveBody(unit, base?.text ?? null, merge);
  const offered = "offered" in r ? r.offered : [];
  const own = (c: Cell) => [...factsOfVersion(anchorsOf(c)).values()].sort(byId);
  const offeredAnchors = offered.map(own);
  if (r.kind === "single" || r.kind === "needs-decision") {
    const winner = [...unit].filter((x) => !x.deleted).sort((a, b) => compareStamps(b.stamp, a.stamp)).find((c) => c.value === r.text);
    return { ...r, anchors: winner ? own(winner) : [], offeredAnchors };
  }
  const heads = unit.filter((x) => !x.deleted).map((c) => ({ text: c.value as string, anchors: anchorsOf(c) }));
  return { ...r, anchors: mergeAnchors({ base, heads, merged: r.text }, move), offeredAnchors };
}


/** The anchors written with the body whose sha-256 is `bodyHash` and whose length is `bodyLength` UTF-16 units (`chooseAnchorHead`), as facts: the ones measured on that
 *  body (an anchor the head carries with a hash of its own was not). Pure and total: a unit in, facts out. */
export function anchorsOfVersion(unit: Unit, bodyHash: string, bodyLength: number): AnchorFact[] {
  const head = chooseAnchorHead(unit, bodyHash, bodyLength);
  if (head.text === null) return [];
  const p = parseAnchorUnit(head.text);
  if (!p.ok) return [];
  return p.unit.anchors.filter((a) => a.ownHash === null).map(({ ownHash: _own, ...f }) => f).sort(byId);
}
