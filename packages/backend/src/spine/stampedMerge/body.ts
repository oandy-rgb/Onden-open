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

import { type Cell, type Unit, compareStamps, sameContent } from "./unit.js";

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
