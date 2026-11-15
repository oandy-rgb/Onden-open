// Random notes through the board's sub-note tree (lib/boardTree).
//
// Notes form a random forest with the things real data has: parent_id loops,
// parents the reader cannot see, hidden notes, tag rows, equal timestamps. For
// random depth, opened/closed branches, extra pages and budget, whatever the
// notes are:
//   1 never more cards than the budget, no card twice, only readable live notes
//   2 the root is first; every other card hangs under a card drawn before it that shows its sub-notes
//   3 a card shows at most a page (8, plus 8 per extra page) of sub-notes, newest first, and its +N says exactly what is left
//   4 a branch is shown when it is within the depth or opened, unless closed — except where the budget ran out
//   5 a collapsed branch's count is the notes really below it
//   6 the layout places every card, none on another
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/boardTree.property.test.ts

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ContentNode } from "../../lib/api";
import { boardTreePositions, computeBoardTree, TREE_CHILD_PAGE, TREE_DEPTHS, type TreeNoteEntry } from "../../lib/boardTree";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

type Spec = { parent: number | null; minute: number };

const forest = fc.array(
  fc.record({
    // A few busy parents (more than a page of sub-notes) among many ordinary ones.
    parent: fc.option(fc.oneof(fc.integer({ min: 0, max: 1 }), fc.integer({ min: 0, max: 60 })), { nil: null }),
    minute: fc.integer({ min: 0, max: 5 }),
  }),
  { minLength: 1, maxLength: 80 },
);

function build(specs: Spec[], extraHidden: number[], tags: number[]): ContentNode[] {
  return specs.map((spec, i) => ({
    id: `n${i}`, title: `n${i}`, slug: `n${i}`, markdown: "", source_type: "manual",
    node_type: tags.includes(i) ? "class_tag" : "content",
    // A parent beyond the list is a note the reader cannot see.
    parent_id: spec.parent === null ? null : `n${spec.parent}`,
    hidden: extraHidden.includes(i),
    updated_at: `2026-10-29T10:0${spec.minute}:00Z`,
  }) as ContentNode);
}

const input = fc.record({
  specs: forest,
  hidden: fc.array(fc.integer({ min: 0, max: 79 }), { maxLength: 4 }),
  tags: fc.array(fc.integer({ min: 0, max: 59 }), { maxLength: 3 }),
  depth: fc.constantFrom(...TREE_DEPTHS),
  open: fc.array(fc.integer({ min: 0, max: 79 }).map((i) => `n${i}`), { maxLength: 8 }),
  closed: fc.array(fc.integer({ min: 0, max: 79 }).map((i) => `n${i}`), { maxLength: 8 }),
  pages: fc.array(fc.tuple(fc.integer({ min: 0, max: 79 }).map((i) => `n${i}`), fc.integer({ min: 1, max: 3 })), { maxLength: 6 }),
  budget: fc.oneof(fc.integer({ min: 1, max: 40 }), fc.constant(100)),
  root: fc.oneof(fc.integer({ min: 0, max: 1 }), fc.integer({ min: 0, max: 79 })),
});

const cfg = { numRuns: PROPS_RUNS, seed: PROPS_SEED };

describe("computeBoardTree (property)", () => {
  it("keeps to the budget, the page size, the depth and the counts for any notes", () => {
    fc.assert(fc.property(input, (sample) => {
      const nodes = build(sample.specs, sample.hidden, sample.tags);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const rootId = `n${sample.root % nodes.length}`;
      const extraPages = new Map(sample.pages);
      const entries = computeBoardTree({
        nodes, rootId, depth: sample.depth, choices: { open: sample.open, closed: sample.closed }, extraPages, budget: sample.budget,
      });

      // 1
      expect(entries.length).toBeLessThanOrEqual(sample.budget);
      const entryIds = entries.map((e) => e.id);
      expect(new Set(entryIds).size).toBe(entryIds.length);
      const noteEntries = entries.filter((e): e is TreeNoteEntry => e.kind === "note");
      for (const e of noteEntries) expect(byId.has(e.id)).toBe(true);
      // 2
      if (entries.length === 0) return;
      expect(entries[0]).toMatchObject({ kind: "note", id: rootId, parentId: null, level: 0 });
      const seenAt = new Map(entryIds.map((id, at) => [id, at]));
      const entryOf = new Map(noteEntries.map((e) => [e.id, e]));
      for (const e of entries.slice(1)) {
        const parent = entryOf.get(e.parentId!);
        expect(parent?.expanded).toBe(true);
        expect(seenAt.get(e.parentId!)!).toBeLessThan(seenAt.get(e.id)!);
        if (e.kind === "note") {
          expect(byId.get(e.id)!.parent_id).toBe(e.parentId);
          expect(byId.get(e.id)!.hidden).toBe(false);
          expect(byId.get(e.id)!.node_type).toBe("content");
          expect(e.level).toBe(parent!.level + 1);
        }
      }
      // 3
      for (const parent of noteEntries) {
        const drawn = noteEntries.filter((e) => e.parentId === parent.id);
        const more = entries.find((e) => e.kind === "more" && e.parentId === parent.id);
        const page = TREE_CHILD_PAGE * (1 + (extraPages.get(parent.id) ?? 0));
        expect(drawn.length).toBeLessThanOrEqual(page);
        for (let i = 1; i < drawn.length; i++) {
          expect(byId.get(drawn[i - 1]!.id)!.updated_at! >= byId.get(drawn[i]!.id)!.updated_at!).toBe(true);
        }
        if (parent.expanded) {
          expect(drawn.length + (more && more.kind === "more" ? more.remaining : 0)).toBe(parent.childCount);
          expect(!!more).toBe(drawn.length < parent.childCount);
        } else {
          expect(drawn).toHaveLength(0);
          expect(more).toBeUndefined();
        }
      }
      // 4: with room to spare, the rule alone decides, and a page is whole.
      if (entries.length < sample.budget) {
        for (const e of noteEntries.filter((n) => n.expanded)) {
          const page = TREE_CHILD_PAGE * (1 + (extraPages.get(e.id) ?? 0));
          expect(noteEntries.filter((c) => c.parentId === e.id)).toHaveLength(Math.min(e.childCount, page));
        }
        const levels = sample.depth === "all" ? Infinity : sample.depth;
        for (const e of noteEntries) {
          const wanted = e.childCount > 0 && !sample.closed.includes(e.id) && (sample.open.includes(e.id) || e.level < levels);
          expect(e.expanded).toBe(wanted);
        }
      }
      // 5
      const children = new Map<string, string[]>();
      for (const n of nodes) {
        if (!n.parent_id || n.hidden || n.node_type === "class_tag") continue;
        children.set(n.parent_id, [...(children.get(n.parent_id) ?? []), n.id]);
      }
      for (const e of noteEntries) {
        if (e.expanded || e.childCount === 0) { expect(e.below).toBe(0); continue; }
        const seen = new Set([e.id]);
        const stack = [e.id];
        while (stack.length) for (const c of children.get(stack.pop()!) ?? []) if (!seen.has(c)) { seen.add(c); stack.push(c); }
        expect(e.below).toBe(seen.size - 1);
      }
      // 6
      const at = boardTreePositions(entries);
      expect(at.size).toBe(entries.length);
      expect(new Set([...at.values()].map((p) => `${p.x},${p.y}`)).size).toBe(entries.length);
    }), cfg);
  });
});
