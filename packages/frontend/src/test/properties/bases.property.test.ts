// Property-based hardening of the Bases YAML parser + filter evaluator
// (lib/basesParser.ts, lib/basesEval.ts). Pure / DOM-free.
//
// Fixed fc seed (CI determinism), capped runs.
//
//   • parseYaml / parseBaseSpec never throw on ANY input string
//   • a generated spec emitted as YAML parses back to the same structure
//   • evalFilter agrees with an independent reference evaluator over
//     generated filter trees and rows
//   • applyView: a row failing the (global ∧ view) filter NEVER appears in
//     the output; limit is respected; output is a subsequence of the input

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import { parseYaml, parseBaseSpec, type FilterNode, type BaseSpec } from "@onden/markdown";
import { evalFilter, applyView, type EvalNode } from "../../lib/basesEval";

const fcOpts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

// decodeView warns on unknown view types — silence the firehose for the
// arbitrary-input property (the warning itself is the fail-soft behavior
// under test, not an error).
// Spies are restored after every test (test/setup.ts), so silence each one.
beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });

// ── Generators ───────────────────────────────────────────────────────────────

// Hostile YAML-ish soup: indentation, dashes, colons, quotes, comments, unicode.
const yamlChar = fc.constantFrom(
  "a", "z", "0", ":", "-", " ", "  ", "\n", "#", '"', "'", "[", "]", ",",
  "\t", "字", "😀", "~", ".", "_",
);
const hostileYaml = fc.array(yamlChar, { maxLength: 60 }).map((a) => a.join(""));

const TAG_POOL = ["alpha", "beta", "gamma", "delta"] as const;
const KEY_POOL = ["year", "score", "rank"] as const;

// Leaf predicates kept inside the evaluator's supported subset, paired with a
// reference implementation computed independently in the test.
type LeafSpec =
  | { expr: string; ref: (n: EvalNode) => boolean };

const leafArb: fc.Arbitrary<LeafSpec> = fc.oneof(
  fc.constantFrom(...TAG_POOL).map((tag) => ({
    expr: `file.hasTag("${tag}")`,
    ref: (n: EvalNode) => (n.class_tag_names ?? []).some((t) => t.toLowerCase() === tag),
  })),
  fc.tuple(fc.constantFrom(...KEY_POOL), fc.constantFrom("==", "!=", ">", "<", ">=", "<="), fc.integer({ min: 0, max: 5 }))
    .map(([key, op, num]) => ({
      expr: `${key} ${op} ${num}`,
      ref: (n: EvalNode) => {
        const actual = n.frontmatter?.[key];
        if (op === "==") return actual === num;
        if (op === "!=") return actual !== num;
        const an = typeof actual === "number" ? actual : Number(actual);
        if (!Number.isFinite(an)) return false;
        switch (op) {
          case ">": return an > num;
          case "<": return an < num;
          case ">=": return an >= num;
          default: return an <= num;
        }
      },
    })),
  fc.constantFrom(true, false).map((b) => ({
    expr: String(b),
    ref: () => b,
  })),
);

type TreeSpec = { node: FilterNode; ref: (n: EvalNode) => boolean };

const treeArb: fc.Arbitrary<TreeSpec> = fc.letrec<{ tree: TreeSpec }>((tie) => ({
  tree: fc.oneof(
    { maxDepth: 3, withCrossShrink: true },
    leafArb.map((l): TreeSpec => ({ node: { kind: "leaf", expr: l.expr }, ref: l.ref })),
    fc.array(tie("tree"), { minLength: 1, maxLength: 3 }).map((items): TreeSpec => ({
      node: { kind: "and", items: items.map((i) => i.node) },
      ref: (n) => items.every((i) => i.ref(n)),
    })),
    fc.array(tie("tree"), { minLength: 1, maxLength: 3 }).map((items): TreeSpec => ({
      node: { kind: "or", items: items.map((i) => i.node) },
      ref: (n) => items.some((i) => i.ref(n)),
    })),
    fc.array(tie("tree"), { minLength: 1, maxLength: 2 }).map((items): TreeSpec => ({
      node: { kind: "not", items: items.map((i) => i.node) },
      ref: (n) => !items.some((i) => i.ref(n)),
    })),
  ),
})).tree;

const rowArb: fc.Arbitrary<EvalNode> = fc.record({
  idn: fc.nat({ max: 9999 }),
  tags: fc.uniqueArray(fc.constantFrom(...TAG_POOL), { maxLength: 4 }),
  fm: fc.dictionary(fc.constantFrom(...KEY_POOL), fc.integer({ min: 0, max: 5 }), { maxKeys: 3 }),
}).map(({ idn, tags, fm }) => ({
  id: `n-${idn}`,
  title: `Node ${idn}`,
  markdown: "",
  node_type: "content",
  class_tag_names: tags as unknown as string[],
  frontmatter: fm,
}));

const rowsArb = fc.array(rowArb, { maxLength: 15 });

// ── Properties ───────────────────────────────────────────────────────────────

describe("bases parser properties", () => {
  it("parseYaml / parseBaseSpec never throw on arbitrary input", () => {
    fc.assert(
      fc.property(hostileYaml, (text) => {
        parseYaml(text); // must not throw
        const spec = parseBaseSpec(text);
        expect(Array.isArray(spec.views)).toBe(true);
      }),
      fcOpts,
    );
  });

  it("a generated spec round-trips through its YAML form", () => {
    const exprChar = fc.constantFrom("a", "z", "0", " ", "=", ".", "(", ")", "_");
    const expr = fc.array(exprChar, { minLength: 1, maxLength: 12 }).map((a) => a.join("").trim() || "x");
    const viewType = fc.constantFrom("table", "cards", "list", "map");
    const specArb = fc.record({
      exprs: fc.array(expr, { minLength: 1, maxLength: 4 }),
      views: fc.array(fc.record({
        type: viewType,
        name: fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/),
        limit: fc.integer({ min: 1, max: 50 }),
      }), { minLength: 1, maxLength: 3 }),
    });
    fc.assert(
      fc.property(specArb, ({ exprs, views }) => {
        const yaml = [
          "filters:",
          "  and:",
          ...exprs.map((e) => `    - "${e}"`),
          "views:",
          ...views.flatMap((v) => [
            `  - type: ${v.type}`,
            `    name: "${v.name}"`,
            `    limit: ${v.limit}`,
          ]),
        ].join("\n");
        const spec = parseBaseSpec(yaml);
        expect(spec.filters).toEqual({
          kind: "and",
          items: exprs.map((e) => ({ kind: "leaf", expr: e })),
        });
        expect(spec.views.map((v) => ({ type: v.type, name: v.name, limit: v.limit })))
          .toEqual(views);
      }),
      fcOpts,
    );
  });
});

describe("bases eval properties", () => {
  it("evalFilter agrees with an independent reference evaluator", () => {
    fc.assert(
      fc.property(treeArb, rowsArb, (tree, rows) => {
        for (const row of rows) {
          expect(evalFilter(row, tree.node)).toBe(tree.ref(row));
        }
      }),
      fcOpts,
    );
  });

  it("applyView: rows failing a filter never appear; limit respected; output ⊆ input in order", () => {
    fc.assert(
      fc.property(treeArb, treeArb, rowsArb, fc.option(fc.integer({ min: 1, max: 10 }), { nil: undefined }), (global, viewTree, rows, limit) => {
        const spec: BaseSpec = { views: [], filters: global.node };
        const view = { type: "table" as const, filters: viewTree.node, ...(limit !== undefined ? { limit } : {}) };
        const out = applyView(rows, spec, view);

        // every output row passes BOTH filters (reference evaluation)
        for (const row of out) {
          expect(global.ref(row)).toBe(true);
          expect(viewTree.ref(row)).toBe(true);
        }
        // no passing row is dropped (when under the limit)
        const passing = rows.filter((r) => global.ref(r) && viewTree.ref(r));
        if (limit === undefined) {
          expect(out).toEqual(passing);
        } else {
          expect(out).toEqual(passing.slice(0, limit));
          expect(out.length).toBeLessThanOrEqual(limit);
        }
      }),
      fcOpts,
    );
  });

  it("unknown leaf expressions deny (never let everything through)", () => {
    fc.assert(
      fc.property(hostileYaml, rowArb, (expr, row) => {
        const t = expr.trim();
        // skip strings that happen to BE supported syntax
        fc.pre(t !== "true" && !/^(?:note\.)?[\p{L}_][\p{L}\p{N}_]*\s*(==|!=|>=|<=|>|<)/u.test(t) && !/^file\./.test(t));
        expect(evalFilter(row, { kind: "leaf", expr })).toBe(false);
      }),
      fcOpts,
    );
  });
});
