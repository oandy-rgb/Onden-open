// Moving anchors across one body change. Pure: rows and texts in, rows out — no database, so the
// rules can be tested exhaustively (store.ts does the reading and writing).
//
// Per anchor:
//   1. positions are trusted (they were measured on `before`): move them with the ChangeSet
//      (start assoc 1, end assoc -1, TrackDel: typing at a boundary does not widen the block),
//      then check the text there still resembles the quote. Position kept but text replaced → find again.
//      A paragraph this edit cut in two keeps its anchor on one half: the one with the `{…}`, else the first
//      (@onden/markdown splitAnchorSpan, the same rule the editor applies).
//   2. otherwise (positions not measured on `before`, deleted ends, doubtful, lost) look the quote up
//      in the whole note: findQuote() decides valid / maybe / lost. It never answers "valid" for a
//      doubtful or non-unique match.
// At most FIND_BUDGET lookups per save (a whole-note scan costs ~50 ms at 175k characters); the rest
// are marked `recoveryPending` and are looked up by the next body write.

import { MapMode, type ChangeSet } from "@codemirror/state";
import { cutParagraphAt, dice, findCutParagraph, findQuote, KEEP_MOVED, lineTable, quoteAt, type Found, type LineTable, type Quote, type Span } from "./similarity.js";
import { deriveChangeSet } from "./changes.js";
import type { AnchorStatus } from "@onden/contract";
import { splitAnchorSpan } from "@onden/markdown";

export const FIND_BUDGET = 5;

export type MovedHow = "editor" | "diff" | "found" | "unchanged";

export type AnchorState = {
  anchorId: string;
  span: Span;
  quote: Quote;
  status: AnchorStatus;
  /** maybe: where it may be; lost: the best guess. */
  candidate: Span | null;
  recoveryPending: boolean;
};

export type MovedAnchor = AnchorState & { how: MovedHow; changed: boolean };

export type MoveContext = {
  /** The note's text the anchors were measured on, or null when unknown (then nothing is moved by position). */
  before: string | null;
  after: string;
  /** The editor's own ChangeSet, already verified (changes.ts verifiedEditorChanges). */
  editorChanges?: ChangeSet | null;
  /** Anchor ids whose stored positions were measured on `before`; others are found by their quote. */
  trusted: (anchorId: string) => boolean;
};

/** What puts a paragraph into a list item: text inserted before it that opens with a list marker (`- `, `1. `). */
const LIST_PREFIX = /^(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/** Text inserted before a block that is only a prefix of its line (no line break: a whole new line is another block). */
const startsListItem = (inserted: string): boolean => !inserted.includes("\n") && LIST_PREFIX.test(inserted);

const sameSpan = (a: Span | null, b: Span | null) => (a === null || b === null ? a === b : a.from === b.from && a.to === b.to);

export function moveAnchors(anchors: AnchorState[], ctx: MoveContext): MovedAnchor[] {
  let changeSet: ChangeSet | null = null;
  let how: MovedHow = "diff";
  const changes = (): ChangeSet => {
    if (changeSet) return changeSet;
    if (ctx.editorChanges) { changeSet = ctx.editorChanges; how = "editor"; } else changeSet = deriveChangeSet(ctx.before!, ctx.after);
    return changeSet;
  };
  let table: LineTable | null = null;
  const quoteInAfter = (span: Span): Quote => quoteAt(ctx.after, span, (table ??= lineTable(ctx.after)));
  let budget = FIND_BUDGET;
  const out: Array<MovedAnchor | undefined> = anchors.map(() => undefined);
  const lookups: number[] = [];

  anchors.forEach((a, index) => {
    // 1. Follow the text by position.
    if (a.status === "valid" && ctx.before !== null && ctx.trusted(a.anchorId)) {
      const cs = changes();
      const mapped = cs.mapPos(a.span.from, 1, MapMode.TrackDel);
      // A list marker (and task box) put in front of the block — the task tag does it, so does the person typing `- ` —
      // is not text typed into the block: it still starts where it did, the new list item.
      const before = cs.mapPos(a.span.from, -1, MapMode.TrackDel);
      const from = mapped !== null && before !== null && mapped > before && startsListItem(ctx.after.slice(before, mapped)) ? before : mapped;
      const to = cs.mapPos(a.span.to, -1, MapMode.TrackDel);
      // A paragraph cut in two by this edit: the identity goes to the half with the `{…}` (業主 2026-11-08; the editor
      // applies the same rule as the person types). A line diff maps the span onto the first half only, so the cut is
      // looked for where the paragraph starts, whichever way the change was derived.
      const cutSpan = from === null || ctx.after.startsWith(a.quote.text, from) ? null : cutParagraphAt(a.quote.text, ctx.after, from);
      if (cutSpan) {
        out[index] = {
          ...a, span: cutSpan, quote: quoteInAfter(cutSpan), candidate: null, recoveryPending: false, how, changed: true,
        };
        return;
      }
      if (from !== null && to !== null && to > from) {
        const text = ctx.after.slice(from, to);
        if (dice(a.quote.text, text) >= KEEP_MOVED) {
          const cut = splitAnchorSpan(a.quote.text, text);
          const span = cut ? { from: from + cut.from, to: from + cut.to } : { from, to };
          const unchanged = sameSpan(span, a.span) && ctx.after.slice(span.from, span.to) === a.quote.text;
          out[index] = {
            ...a, span, quote: unchanged ? a.quote : quoteInAfter(span),
            candidate: null, recoveryPending: false, how: unchanged ? "unchanged" : how, changed: !unchanged || a.recoveryPending,
          };
          return;
        }
      }
    } else if (a.status === "valid" && a.span.to <= ctx.after.length && ctx.after.slice(a.span.from, a.span.to) === a.quote.text) {
      // Measured on another version of the note, but the text is exactly there: still right.
      out[index] = { ...a, candidate: null, recoveryPending: false, how: "unchanged", changed: a.recoveryPending };
      return;
    }
    lookups.push(index);
  });

  // 2. Look the quote up — after every anchor that kept its place has claimed its block, and in the order the
  // anchors had in the note: a block is found by one anchor only, and two paragraphs that read alike are told
  // apart by which anchor stood first, not by which one scores a hair higher.
  const claimed: Span[] = out.flatMap((m) => (m && m.status === "valid" ? [m.span] : []));
  lookups.sort((x, y) => anchors[x]!.span.from - anchors[y]!.span.from || x - y);
  for (const index of lookups) {
    const a = anchors[index]!;
    if (budget <= 0) {
      out[index] = {
        ...a, status: a.status === "valid" ? "maybe" : a.status, recoveryPending: true, how: "unchanged",
        changed: a.status === "valid" || !a.recoveryPending,
      };
      continue;
    }
    budget--;
    const cut = findCutParagraph(a.quote.text, ctx.after, claimed);
    const found: Found = cut ? { outcome: "valid", span: cut, score: 1 } : findQuote(a.quote, ctx.after, claimed);
    if (found.outcome === "valid") {
      claimed.push(found.span);
      out[index] = {
        ...a, span: found.span, quote: quoteInAfter(found.span), status: "valid", candidate: null,
        recoveryPending: false, how: "found", changed: true,
      };
    } else {
      out[index] = {
        ...a, status: found.outcome, candidate: found.span, recoveryPending: false, how: "found",
        changed: a.status !== found.outcome || !sameSpan(a.candidate, found.span) || a.recoveryPending,
      };
    }
  }
  return out as MovedAnchor[];
}
