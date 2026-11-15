import fc from "fast-check";

// A short, independent statement of the 「空間發布」 rule (owner 2026-11-10), for
// the property tests. It deliberately does not call product code: the server
// answer is modules/website/publishing/publishedSet.ts, and these few lines
// are what that rule says. The frontend keeps a copy of the same model
// (packages/frontend/src/test/properties/helpers/publishSetModel.ts) and a
// fixed-case test compares the two, so the two sides cannot drift apart.

export type ModelNode = {
  /** Index of the note's space in the run's space list. */
  space: number;
  /** Index of the parent note (always earlier in the list, same space), or null. */
  parent: number | null;
  markdown: string;
  hidden: boolean;
  /** The note's own `_published` flag; null = none. */
  flag: "true" | "false" | null;
  sourceType: "manual" | "rss" | "system";
  /** Has an attribute that is not `_` bookkeeping (ink, a sketch …). */
  hasKeptAttr: boolean;
  deleted: boolean;
};

export type ModelSpace = { publish: boolean };

/** Only what Postgres counts as whitespace (`\S` in the server's `markdown !~ '\S'`): not JS `\s`, which also
 *  takes NBSP (U+00A0, U+2007, U+202F) and the BOM. */
const POSTGRES_SPACE_ONLY = /^[\t-\r \u0085\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]*$/;

/** The indexes of the notes the site shows. */
export function modelPublished(spaces: readonly ModelSpace[], notes: readonly ModelNode[]): Set<number> {
  const out = new Set<number>();
  notes.forEach((n, i) => {
    if (n.deleted || n.hidden || n.sourceType === "system") return; // never a page
    if (!spaces[n.space]!.publish) return; // nothing in a space that does not publish, whatever the note says
    if (n.flag === "false") return; // the owner's exception wins
    if (n.flag === "true") { out.add(i); return; }
    if (n.sourceType === "rss") return; // someone else's writing
    const hasText = !POSTGRES_SPACE_ONLY.test(n.markdown);
    const hasChild = notes.some((c) => c.parent === i && !c.deleted);
    if (!hasText && !hasChild && !n.hasKeptAttr) return; // blank
    out.add(i);
  });
  return out;
}

// ── Generated world ──────────────────────────────────────────────────────────

export type World = { spaces: ModelSpace[]; notes: ModelNode[] };

const MARKDOWNS = ["", " ", "\n", "  \n \t", "\u00a0", "\u3000", "text", "# title\n\nbody", " x "];

export const worldArb: fc.Arbitrary<World> = fc.integer({ min: 1, max: 3 }).chain((spaceCount) =>
  fc.tuple(
    fc.array(fc.constantFrom(true, true, false), { minLength: spaceCount, maxLength: spaceCount }),
    fc.array(
      fc.record({
        space: fc.nat(spaceCount - 1),
        parentPick: fc.option(fc.nat(30), { nil: null }),
        markdown: fc.constantFrom(...MARKDOWNS),
        hidden: fc.constantFrom(false, false, false, true),
        flag: fc.constantFrom<ModelNode["flag"]>(null, null, "true", "false"),
        sourceType: fc.constantFrom<ModelNode["sourceType"]>("manual", "manual", "manual", "manual", "manual", "rss", "system"),
        hasKeptAttr: fc.boolean(),
        deleted: fc.constantFrom(false, false, false, true),
      }),
      { maxLength: 25 },
    ),
  ).map(([publish, raw]) => {
    const notes: ModelNode[] = [];
    raw.forEach((r) => {
      // A parent is an earlier note in the same space (a note lives in its parent's space).
      const candidates = notes.map((n, j) => ({ n, j })).filter(({ n }) => n.space === r.space).map(({ j }) => j);
      const parent = r.parentPick !== null && candidates.length > 0 ? candidates[r.parentPick % candidates.length]! : null;
      // A trashed note takes its subtree with it; trashing is rare so most runs have live notes.
      const deleted = r.deleted ? true : parent !== null && notes[parent]!.deleted;
      notes.push({ space: r.space, parent, markdown: r.markdown, hidden: r.hidden, flag: r.flag, sourceType: r.sourceType, hasKeptAttr: r.hasKeptAttr, deleted });
    });
    return { spaces: publish.map((p) => ({ publish: p })), notes };
  }),
);

