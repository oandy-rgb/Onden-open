// Shared by the "anchor path" pins (anchorPath.test.ts, properties/anchorPath.property.test.ts):
// run the pure anchor mover (services/blockAnchors/mapping.ts) along a path of body versions and compare
// the stored state it leaves. The state compared is what the table keeps: span, status, candidate, quote, recoveryPending.
import { ChangeSet } from "@codemirror/state";
import { moveAnchors, type AnchorState } from "../../services/blockAnchors/mapping.js";
import { lineAlign, quoteAt } from "../../services/blockAnchors/similarity.js";

/** What the table keeps of an anchor, with `atBody`: the body its position or conclusion was measured on (the table's at_body_hash). */
export type Stored = Pick<AnchorState, "anchorId" | "span" | "quote" | "status" | "candidate" | "recoveryPending"> & { atBody: string };

/** An anchor on the first occurrence of `paragraph` in `doc`, measured on `doc` (what ensureBlockAnchor writes). */
export function anchorOn(doc: string, paragraph: string, anchorId: string): AnchorState & { atBody: string } {
  const start = doc.indexOf(paragraph);
  if (start < 0) throw new Error(`paragraph not in doc: ${paragraph}`);
  const span = lineAlign(doc, { from: start, to: start + paragraph.length });
  return { anchorId, span, quote: quoteAt(doc, span), status: "valid", candidate: null, recoveryPending: false, atBody: doc };
}

/** After a move every anchor is measured on the new body, as moveAnchorsForBodyChange writes at_body_hash for all of them. */
const keep = (body: string) => (a: AnchorState): Stored => ({ anchorId: a.anchorId, span: a.span, quote: a.quote, status: a.status, candidate: a.candidate, recoveryPending: a.recoveryPending, atBody: body });
const settledOn = (anchors: Stored[], body: string) => { const done = new Set(anchors.filter((a) => a.atBody === body).map((a) => a.anchorId)); return (id: string) => done.has(id); };

/** One save: the store's trusted rule (all anchors were measured on the previous body) applied by hand. */
export function save(anchors: Stored[], before: string, after: string, editorChanges?: ChangeSet | null, findBudget?: number): Stored[] {
  return moveAnchors(anchors as AnchorState[], { before, after, editorChanges: editorChanges ?? null, trusted: () => true, findBudget, settled: settledOn(anchors, after) }).map(keep(after));
}

/** A walk along `versions` (versions[0] is where the anchors were measured), one save per step. */
export function walk(anchors: Stored[], versions: string[]): Stored[] {
  let cur = anchors;
  for (let i = 1; i < versions.length; i++) cur = save(cur, versions[i - 1]!, versions[i]!);
  return cur;
}

/** The outbox pass (recover.ts): before = null, so nothing is trusted by position; repeat until nothing is pending. */
export function recoveryPass(anchors: Stored[], body: string, findBudget?: number): Stored[] {
  let cur = anchors;
  for (let pass = 0; pass < 40 && cur.some((a) => a.recoveryPending); pass++) {
    cur = moveAnchors(cur as AnchorState[], { before: null, after: body, trusted: () => false, findBudget, settled: settledOn(cur, body) }).map(keep(body));
  }
  return cur;
}

/** What differs between two walks, in plain words (for the failure message and for the report). */
export function diffStates(a: Stored[], b: Stored[]): string[] {
  const out: string[] = [];
  const byId = new Map(b.map((x) => [x.anchorId, x]));
  for (const x of a) {
    const y = byId.get(x.anchorId)!;
    const same = JSON.stringify(x) === JSON.stringify(y);
    if (!same) out.push(`${x.anchorId}: ${x.status}${x.recoveryPending ? "+pending" : ""} [${x.span.from},${x.span.to}) vs ${y.status}${y.recoveryPending ? "+pending" : ""} [${y.span.from},${y.span.to})`);
  }
  return out;
}

/** An editor ChangeSet from a list of {from,to,insert} against `doc`. */
export const csOf = (doc: string, ...ops: Array<{ from: number; to?: number; insert?: string }>) => ChangeSet.of(ops, doc.length);
