// Database-free properties for the space-access rule.
//
// Two parts:
//   1. The tool gate (spine/toolScope.ts) against a plain model: which tool names
//      a token may call, including the stack of nested tool invocations.
//   2. The laws the reference model in helpers/spaceModel.ts must obey. The same
//      model is what properties/spineModel.property.integration.test.ts compares
//      with the real app, so a law broken here would make that test meaningless
//      rather than find a product bug. They are cheap, and they run without a
//      database.
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/spaceModel.property.test.ts

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { check, checkAsync } from "../helpers/propsConfig.js";
import { assertCurrentToolAllowed, isToolAllowed, ScopeError, withToolAuthority } from "../../spine/toolScope.js";
import type { ActorCtx } from "../../types.js";
import {
  WHO, canReadIn, canWriteIn, deleteSubtree, hiddenFrom, moveSubtree, subtreeOf, undeleteSubtree, visible, visibleIds, writable,
  type Member, type Model, type MNote, type Perm, type Who,
} from "../helpers/spaceModel.js";

// ── 1. The tool gate ─────────────────────────────────────────────────────────
const TOOLS = ["getNode", "searchNodes", "updateNode", "createNode", "applyTag", "removeTag"];
const toolList = fc.subarray(TOOLS);
/** null = unrestricted, [] = lockdown, otherwise a list. */
const allowedArb = fc.option(toolList, { nil: null });

const actorWith = (allowed: string[] | null | undefined): ActorCtx => ({
  id: "00000000-0000-4000-8000-000000000001", name: "gate", type: "agent",
  ...(allowed === undefined ? {} : { tokenScope: { tokenId: "t", allowedTools: allowed, access: "write" as const, writeMode: "apply", expiresAt: null } }),
});

describe("tool gate (spine/toolScope.ts)", () => {
  it("a token may call exactly the tools in its list; null is open, [] is closed, no token is not gated", () => {
    check(fc.property(fc.option(allowedArb, { nil: undefined }), fc.constantFrom(...TOOLS, "somethingElse"), (allowed, tool) => {
      const model = allowed === undefined || allowed === null ? true : allowed.includes(tool);
      expect(isToolAllowed(actorWith(allowed), tool)).toBe(model);
    }));
  });

  it("nested invocations: the current authority passes iff every tool on the stack is allowed", async () => {
    await checkAsync(fc.asyncProperty(allowedArb, fc.array(fc.constantFrom(...TOOLS), { minLength: 0, maxLength: 4 }), async (allowed, stack) => {
      const actor = actorWith(allowed);
      const want = allowed === null || stack.every((t) => allowed.includes(t));
      const run = (rest: string[]): Promise<void> =>
        rest.length === 0 ? Promise.resolve().then(() => assertCurrentToolAllowed(actor)) : withToolAuthority(rest[0]!, () => run(rest.slice(1)));
      if (want) await run(stack);
      else await expect(run(stack)).rejects.toBeInstanceOf(ScopeError);
    }));
  });

  it("outside any tool invocation the gate adds no restriction, even for a locked-down token", async () => {
    await checkAsync(fc.asyncProperty(allowedArb, async (allowed) => { assertCurrentToolAllowed(actorWith(allowed)); }));
  });
});

// ── 2. Laws of the reference model ───────────────────────────────────────────
type Shape = {
  spaces: Array<{ externalAi: boolean; members: Array<[Member, Perm]> }>;
  notes: Array<{ space: number; parent: number | null }>;
  token: { access: "read" | "write"; revoked: boolean } | null;
};
const memberArb = fc.constantFrom<Member>("owner", "A", "B", "G");
const shapeArb: fc.Arbitrary<Shape> = fc.record({
  spaces: fc.array(fc.record({
    externalAi: fc.boolean(),
    members: fc.uniqueArray(fc.tuple(memberArb, fc.constantFrom<Perm>("view", "edit")), { selector: ([who]) => who, maxLength: 4 }),
  }), { minLength: 1, maxLength: 3 }),
  notes: fc.array(fc.record({ space: fc.nat(2), parent: fc.option(fc.nat(7), { nil: null }) }), { maxLength: 8 }),
  token: fc.option(fc.record({ access: fc.constantFrom<"read" | "write">("read", "write"), revoked: fc.boolean() }), { nil: null }),
});

/** A model where each note's parent is an earlier note of the same space. */
function build(shape: Shape): Model {
  const spaces = shape.spaces.map((s, i) => ({ id: `s${i}`, externalAi: s.externalAi, members: new Map(s.members) }));
  const notes: MNote[] = [];
  shape.notes.forEach((n, i) => {
    const space = spaces[n.space % spaces.length]!.id;
    const parent = n.parent === null || i === 0 ? null : notes[n.parent % i]!;
    const inSpace = parent && parent.space === space ? parent.id : null;
    notes.push({ id: `n${i}`, mark: `m${i}`, space, everIn: new Set([space]), parent: inSpace, title: "t", body: "b", deleted: false, deletedBy: null, lostChild: false });
  });
  return { spaces, notes, edges: [], token: shape.token ? { id: "tok", plaintext: "x", ...shape.token } : null };
}
const modelArb = shapeArb.map(build);

describe("reference model laws", () => {
  it("what a person may write they may read, and what they may read they see (live notes)", () => {
    check(fc.property(modelArb, fc.constantFrom(...WHO), (m, w) => {
      for (const s of m.spaces) if (canWriteIn(m, w, s.id)) expect(canReadIn(m, w, s.id)).toBe(true);
      for (const n of m.notes) {
        if (writable(m, w, n)) expect(visible(m, w, n)).toBe(true);
        if (visible(m, w, n)) expect(n.deleted).toBe(false);
      }
    }));
  });

  it("a token never goes beyond its agent as a person, and a dead token goes nowhere", () => {
    check(fc.property(modelArb, (m) => {
      for (const n of m.notes) {
        const agentReads = m.spaces.find((s) => s.id === n.space)!.members.has("G");
        if (visible(m, "tok", n)) expect(agentReads).toBe(true);
        if (writable(m, "tok", n)) expect(m.token!.access).toBe("write");
        if (m.token === null || m.token.revoked) expect(visible(m, "tok", n) || writable(m, "tok", n)).toBe(false);
      }
    }));
  });

  it("removing a member or turning a switch off never makes anything newly visible", () => {
    check(fc.property(modelArb, fc.nat(2), memberArb, fc.boolean(), (m, si, who, dropMember) => {
      const before = new Map(WHO.map((w) => [w, new Set(visibleIds(m, w))]));
      const s = m.spaces[si % m.spaces.length]!;
      if (dropMember) s.members.delete(who); else s.externalAi = false;
      for (const w of WHO) for (const id of visibleIds(m, w)) expect(before.get(w)!.has(id), `${w} gained ${id}`).toBe(true);
    }));
  });

  it("downgrading edit to view never makes anything newly writable", () => {
    check(fc.property(modelArb, fc.nat(2), memberArb, (m, si, who) => {
      const key = (w: Who) => m.notes.filter((n) => writable(m, w, n)).map((n) => n.id);
      const before = new Map(WHO.map((w) => [w, new Set(key(w))]));
      const s = m.spaces[si % m.spaces.length]!;
      if (s.members.has(who)) s.members.set(who, "view");
      for (const w of WHO) for (const id of key(w)) expect(before.get(w)!.has(id)).toBe(true);
    }));
  });

  it("hidden notes are never visible, and hiding is by space only", () => {
    check(fc.property(modelArb, fc.constantFrom(...WHO), (m, w) => {
      for (const n of hiddenFrom(m, w)) expect(visible(m, w, n)).toBe(false);
    }));
  });

  it("deleting a subtree and restoring it puts the flags back; a move keeps the subtree together", () => {
    check(fc.property(modelArb, fc.nat(7), fc.nat(2), (m, ni, si) => {
      if (m.notes.length === 0) return;
      const n = m.notes[ni % m.notes.length]!;
      const flags = () => m.notes.map((x) => `${x.deleted}`).join();
      const before = flags();
      deleteSubtree(m, n);
      for (const d of subtreeOf(m, n)) expect(d.deleted).toBe(true);
      undeleteSubtree(m, n);
      expect(flags()).toBe(before);

      const to = m.spaces[si % m.spaces.length]!.id;
      const members = subtreeOf(m, n).map((x) => x.id);
      moveSubtree(m, n, to);
      expect(subtreeOf(m, n).map((x) => x.id).sort()).toEqual(members.sort());
      for (const d of subtreeOf(m, n)) { expect(d.space).toBe(to); expect(d.everIn.has(to)).toBe(true); }
      expect(n.parent).toBeNull();
    }));
  });
});
