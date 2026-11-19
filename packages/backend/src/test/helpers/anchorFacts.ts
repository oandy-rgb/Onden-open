// The anchors of a body version as the merge core takes them (spine/stampedMerge/body.ts AnchorFact), and the one mover it is given: the product's own pure
// services/blockAnchors/mapping.ts `moveAnchors`, with every position trusted and no find budget (the budget is a cost limit of a save, never part of what a merge answers).
import { moveAnchors, NO_POSITION, type AnchorState } from "../../services/blockAnchors/mapping.js";
import type { AnchorFact, MoveAnchorsFn } from "../../spine/stampedMerge/body.js";
import type { Stored } from "./anchorPath.js";

export const factOf = (a: Pick<AnchorState, "anchorId" | "span" | "quote" | "status" | "candidate" | "recoveryPending">): AnchorFact => ({
  anchorId: a.anchorId, status: a.status, from: a.span.from, to: a.span.to, candidate: a.candidate ? { ...a.candidate } : null,
  quote: a.quote.text, prefix: a.quote.prefix, suffix: a.quote.suffix, recoveryPending: a.recoveryPending,
});
export const anchorStateOf = (f: AnchorFact): AnchorState => ({
  anchorId: f.anchorId, status: f.status, span: f.status === "valid" ? { from: f.from, to: f.to } : NO_POSITION, candidate: f.candidate,
  quote: { text: f.quote, prefix: f.prefix, suffix: f.suffix }, recoveryPending: f.recoveryPending,
});
export const factsOf = (stored: readonly Stored[]): AnchorFact[] => stored.map(factOf).sort((x, y) => (x.anchorId < y.anchorId ? -1 : 1));

export const moveFacts: MoveAnchorsFn = (anchors, from, to) =>
  moveAnchors(anchors.map(anchorStateOf), { before: from, after: to, trusted: () => true, findBudget: Number.MAX_SAFE_INTEGER }).map(factOf);
