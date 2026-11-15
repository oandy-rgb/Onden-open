import { describe, it, expect } from "vitest";
import { evalFilter, applyView, type EvalNode } from "../lib/basesEval";
import type { FilterNode, BaseSpec, ViewDef } from "@onden/markdown";

// Bases TRUST-BOUNDARY pen tests. The evaluator is presentational-only
// (basesEval.ts SECURITY NOTE): it filters an ALREADY-authorized node set and
// must never (a) execute injected code, (b) let a crafted `this` substitution
// break out of its quoted argument to widen the match, or (c) surface a node it
// was not handed. The random-fuzz "unknown leaf denies" case lives in
// properties/bases.property.test.ts; these are the NAMED attack vectors.

const leaf = (expr: string): FilterNode => ({ kind: "leaf", expr });
const node = (over: Partial<EvalNode> = {}): EvalNode => ({
  id: "n1", title: "Note", markdown: "", node_type: "content",
  class_tag_names: [], frontmatter: {}, ...over,
});

describe("Bases evaluator — penetration / sandbox", () => {
  it("a crafted `this` substitution cannot break out of its quoted argument", () => {
    const secret = node({ id: "s", class_tag_names: ["admin-secret"] });
    // Attacker controls the host-note title (the `this` value) and tries to
    // smuggle a second OR'd predicate so file.hasTag(this) also matches the
    // restricted tag. substituteThis escapes the quotes, so the result is no
    // longer a single whitelisted leaf → denied, even though `secret` HAS the
    // tag the injection names.
    const injection = 'x") or file.hasTag("admin-secret';
    expect(evalFilter(secret, leaf("file.hasTag(this)"), { thisTitle: injection })).toBe(false);
    // Control: a legitimate `this` still resolves and matches.
    expect(evalFilter(secret, leaf("file.hasTag(this)"), { thisTitle: "admin-secret" })).toBe(true);
  });

  it("code-exec / prototype-access payloads are denied and never throw or execute", () => {
    const n = node({ frontmatter: { x: 1 }, markdown: "[[Other]]" });
    const payloads = [
      "constructor",
      "__proto__",
      "this.constructor.constructor('return 1')()",
      "(() => true)()",
      'note.x == "1") || true',          // operator-injection past the anchor
      'file.hasTag("a") || 1',            // smuggled JS OR
      "process.exit(1)",
      "${file.hasTag('a')}",              // template-literal shape
    ];
    for (const p of payloads) {
      expect(() => evalFilter(n, leaf(p))).not.toThrow();
      expect(evalFilter(n, leaf(p)).valueOf()).toBe(false); // strictly denied
    }
  });

  it("privileged predicates only read caller-populated fields — they cannot conjure rows", () => {
    // A base asking for "admin's notes" only matches nodes the CALLER already
    // tagged with recent_actors/last_actor; a node lacking them is denied, so a
    // base can never widen the set beyond what the (read-policy'd) fetch gave it.
    const bare = node({ id: "bare" }); // no recent_actors / last_actor
    expect(evalFilter(bare, leaf('file.modifiedBy("admin")'))).toBe(false);
    expect(evalFilter(bare, leaf('file.lastActor == "admin"'))).toBe(false);

    // applyView never returns a node that was not in the input set.
    const spec: BaseSpec = { views: [] };
    const view: ViewDef = { type: "list", filters: leaf("true") };
    const input = [node({ id: "a" }), node({ id: "b" })];
    const out = applyView(input, spec, view);
    expect(out.every((r) => input.some((i) => i.id === r.id))).toBe(true);
  });
});
