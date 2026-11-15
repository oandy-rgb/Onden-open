// Property-based hardening of the body-patch core (services/eventLog/bodyPatch).
//
// DB-free. fast-check with a FIXED seed (CI determinism — change the seed only
// deliberately) and capped runs to keep the suite fast.
//
// The generators are deliberately unicode-hostile: CJK, emoji (surrogate
// pairs), combining marks, mixed line endings. The emoji coverage is what
// originally exposed the diff-match-patch surrogate-split bug (patch_toText
// threw "URI malformed" when a diff boundary landed inside a surrogate pair,
// 500ing PATCH /api/nodes) — now fixed by the full-replacement fallback in
// makeInversePatch; these properties pin the fix.

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import {
  makeInversePatch,
  rebuildPreEventBody,
  rebuildFromUnchangedBody,
} from "../../services/eventLog/bodyPatch.js";
import { threeWayMergeBody } from "../../services/eventLog/bodyMerge.js";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

// ── Generators ───────────────────────────────────────────────────────────────

// Unicode-hostile atoms: ASCII, CJK, emoji (astral / surrogate pairs),
// combining accents, and both line-ending conventions.
const atom = fc.constantFrom(
  "a", "b", "Z", "0", "9", " ", "#", '"', ":", "-", "_",
  "字", "測", "試", "日", "本", "語", "한", "글",
  "😀", "😁", "🦊", "👩‍👩‍👧", "✍️", "🇹🇼",
  "é", "ü", "​",
  "\n", "\r\n", "\t",
);

const body = fc.array(atom, { maxLength: 60 }).map((a) => a.join(""));

// A multi-line base where every line carries its index — unique content per
// line so "disjoint edits" really are disjoint for a char-based differ.
const word = fc.stringMatching(/^[a-z0-9]{3,8}$/);
const lines = fc.array(word, { minLength: 12, maxLength: 24 })
  .map((ws) => ws.map((w, i) => `line-${i}-${w}`));

// ── Properties ───────────────────────────────────────────────────────────────

describe("bodyPatch properties", () => {
  it("never throws, for any unicode-hostile (old, new) pair", () => {
    fc.assert(
      fc.property(body, body, (oldBody, newBody) => {
        const patch = makeInversePatch(oldBody, newBody);
        expect(typeof patch).toBe("string");
        // applying it must not throw either
        rebuildPreEventBody(newBody, patch);
        rebuildFromUnchangedBody(newBody, patch);
      }),
      fcOpts,
    );
  });

  it("round-trip: rebuilding from new with makeInversePatch(old,new) yields old", () => {
    fc.assert(
      fc.property(body, body, (oldBody, newBody) => {
        const patch = makeInversePatch(oldBody, newBody);
        expect(rebuildPreEventBody(newBody, patch)).toBe(oldBody);
        // An unchanged post body passes the legacy check too (D79).
        expect(rebuildFromUnchangedBody(newBody, patch)).toBe(oldBody);
      }),
      fcOpts,
    );
  });

  it("equal bodies produce the empty (no-op) patch; empty patch is identity", () => {
    fc.assert(
      fc.property(body, body, (a, x) => {
        expect(makeInversePatch(a, a)).toBe("");
        expect(rebuildPreEventBody(x, "")).toBe(x);
        expect(rebuildFromUnchangedBody(x, "")).toBe(x);
      }),
      fcOpts,
    );
  });

  it("merge identities: merge(base, base, theirs) === theirs and merge(base, mine, base) === mine", () => {
    fc.assert(
      fc.property(body, body, (base, other) => {
        const noEdit = threeWayMergeBody(base, base, other);
        expect(noEdit.merged).toBe(other);
        expect(noEdit.clean).toBe(true);

        const onlyMine = threeWayMergeBody(base, other, base);
        expect(onlyMine.merged).toBe(other);
        expect(onlyMine.clean).toBe(true);
      }),
      fcOpts,
    );
  });

  it("merge is conflict-free for edits on disjoint, well-separated lines", () => {
    fc.assert(
      fc.property(
        lines,
        fc.nat(), // picks the "mine" line in the top third
        fc.nat(), // picks the "theirs" line in the bottom third
        word,
        word,
        (ls, mSeedRaw, tSeedRaw, mWord, tWord) => {
          const third = Math.floor(ls.length / 3);
          const mi = mSeedRaw % third;                       // top third
          const ti = ls.length - 1 - (tSeedRaw % third);     // bottom third
          const base = ls.join("\n");
          const mineLines = [...ls];
          mineLines[mi] = `MINE-${mi}-${mWord}`;
          const theirLines = [...ls];
          theirLines[ti] = `THEIRS-${ti}-${tWord}`;

          const { merged, clean } = threeWayMergeBody(base, mineLines.join("\n"), theirLines.join("\n"));
          expect(clean).toBe(true);
          expect(merged).toContain(`MINE-${mi}-${mWord}`);
          expect(merged).toContain(`THEIRS-${ti}-${tWord}`);
          expect(merged).not.toContain(ls[mi]);
          expect(merged).not.toContain(ls[ti]);
        },
      ),
      fcOpts,
    );
  });

  it("regression: surrogate-pair-splitting emoji edit produces a working patch (was: URI malformed → 500)", () => {
    // 😀 (😀) → 😁 (😁): shared high surrogate makes the
    // char diff split the pair, the exact shape that used to throw.
    const patch = makeInversePatch("😀", "😁");
    expect(rebuildPreEventBody("😁", patch)).toBe("😀");
    expect(rebuildFromUnchangedBody("😁", patch)).toBe("😀");
  });
});
