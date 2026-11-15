// Property test of the client's prediction of 「空間發布」 (modules/website/publishBlocker.ts):
//   7. siteStanding agrees with the reference model of the rule, which is the
//      same file the backend's property test checks publishedNodeIds against
//      (backend/src/test/helpers/publishSetModel.ts, imported here, so the two
//      sides cannot each write their own rule). The server's read-restricted
//      tag exclusion is not predicted by the client and not in the model.
//   8. publishBlocker non-null ⇒ siteStanding is off, for the same reason.
//
// The generator drops what the client never holds (trashed notes, system
// machinery), so only live notes are compared.
//
// Replay: PROPS_SEED=<seed> PROPS_RUNS=<n> (helpers/propsConfig).

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import { modelPublished, worldArb, type World } from "../../../../backend/src/test/helpers/publishSetModel";
import { newNoteSiteDefault } from "@onden/markdown";
import { publishBlocker, siteStanding, PUBLISHED_ATTR } from "../../modules/website/publishBlocker";
import type { ContentNode } from "../../lib/api";
import type { Space } from "../../lib/spaces";

const spaceOf = (id: string, publish: boolean): Space => ({
  id, name: `space ${id}`, kind: "shared", is_default: false, owner_actor_id: null,
  capabilities: { publish }, permission: "edit", can_manage: true,
});

/** The world as the client holds it: live, non-system notes only. */
function clientView(world: World) {
  const spaces = world.spaces.map((s, i) => spaceOf(`s${i}`, s.publish));
  const nodes = world.notes.map((n, i) => ({
    index: i,
    held: !n.deleted && n.sourceType !== "system",
    node: {
      id: `n${i}`, hidden: n.hidden, space_id: `s${n.space}`, source_type: n.sourceType, markdown: n.markdown, body_len: n.markdown.length,
      attrs: { ...(n.flag ? { [PUBLISHED_ATTR]: n.flag } : {}), _note: "x", ...(n.hasKeptAttr ? { ink: "stroke" } : {}) },
    } as unknown as ContentNode,
    hasChild: world.notes.some((c) => c.parent === i && !c.deleted),
  }));
  return { spaces, nodes };
}

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

describe("siteStanding (client prediction of 空間發布)", () => {
  it("7: agrees with the reference model", () => {
    fc.assert(fc.property(worldArb, (world) => {
      const { spaces, nodes } = clientView(world);
      const model = modelPublished(world.spaces, world.notes);
      for (const { index, held, node, hasChild } of nodes) {
        if (!held) continue;
        expect(siteStanding(node, spaces, hasChild).on, `note ${index}`).toBe(model.has(index));
      }
    }), fcOpts);
  });

  // Found by this suite on 2026-11-11 (the client said "on" for a whitespace-only body because it also asked
  // body_len === 0) and since fixed in siteStanding; kept as a fixed case.
  it("a whitespace-only note is blank for the client too, as on the server", () => {
    const world: World = {
      spaces: [{ publish: true }],
      notes: [{ space: 0, parent: null, markdown: " ", hidden: false, flag: null, sourceType: "manual", hasKeptAttr: false, deleted: false }],
    };
    const { spaces, nodes } = clientView(world);
    expect(modelPublished(world.spaces, world.notes).has(0)).toBe(false);
    expect(siteStanding(nodes[0]!.node, spaces, false).on).toBe(false);
  });

  it("8: a blocker means the site is off, for the same reason", () => {
    fc.assert(fc.property(worldArb, (world) => {
      const { spaces, nodes } = clientView(world);
      for (const { held, node, hasChild } of nodes) {
        if (!held) continue;
        const blocker = publishBlocker(node, spaces);
        if (!blocker) continue;
        const standing = siteStanding(node, spaces, hasChild);
        expect(standing.on).toBe(false);
        if (!standing.on) expect(standing.reason).toBe(blocker.reason);
      }
    }), fcOpts);
  });

  // Owner 2026-11-13: a note made under a 「不發布」 note starts 「不發布」 too. The client draws the new note with
  // newNoteSiteDefault, the same function the server's createNote uses (backend services/siteDefault.ts), and the
  // server's own property (publishSet.property.integration.test.ts, 9) checks the real createNote against this model.
  it("9: a note made under another, drawn with the shared default, stands as the model says; no other note changes", () => {
    fc.assert(fc.property(worldArb, fc.nat(), (world, pick) => {
      const parents = world.notes.flatMap((n, i) => (!n.deleted && !n.hidden && n.sourceType === "manual" ? [i] : []));
      if (parents.length === 0) return;
      const parent = parents[pick % parents.length]!;
      const { spaces, nodes } = clientView(world);
      const attrs = newNoteSiteDefault(nodes[parent]!.node.attrs) ?? {};
      const born = { id: "born", hidden: false, space_id: `s${world.notes[parent]!.space}`, source_type: "manual", markdown: "text", body_len: 4, attrs: { _note: "x", ...attrs } } as unknown as ContentNode;
      const model = modelPublished(world.spaces, [...world.notes, { ...world.notes[parent]!, parent, markdown: "text", hidden: false, flag: world.notes[parent]!.flag === "false" ? "false" : null, sourceType: "manual", hasKeptAttr: false, deleted: false }]);
      expect(siteStanding(born, spaces, false).on, "the new note").toBe(model.has(world.notes.length));
      for (const { index, held, node, hasChild } of nodes) {
        if (!held) continue;
        // The parent now has a child: it is not blank any more.
        expect(siteStanding(node, spaces, hasChild || index === parent).on, `note ${index}`).toBe(model.has(index));
      }
    }), fcOpts);
  });

  it("the generator reaches blockers and every standing", () => {
    const worlds = fc.sample(worldArb, { numRuns: 300, seed: 1 });
    const reasons = new Set<string>();
    for (const w of worlds) {
      const { spaces, nodes } = clientView(w);
      for (const { held, node, hasChild } of nodes) {
        if (!held) continue;
        const s = siteStanding(node, spaces, hasChild);
        reasons.add(s.on ? "on" : s.reason);
      }
    }
    expect([...reasons].sort()).toEqual(["blank", "hidden", "kept_off", "on", "saved_article", "space"]);
    // kept_off_by_parent needs the mark the generator does not write: a fixed case.
    const { spaces } = clientView({ spaces: [{ publish: true }], notes: [] });
    expect(siteStanding({ id: "x", hidden: false, space_id: "s0", source_type: "manual", markdown: "t", body_len: 1, attrs: { _published: "false", _published_by_parent: "true" } } as unknown as ContentNode, spaces, false))
      .toEqual({ on: false, reason: "kept_off_by_parent" });
  });
});
