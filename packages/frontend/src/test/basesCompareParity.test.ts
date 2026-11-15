// The onden-base block compares and sorts attribute values by the attribute
// value rule (D49) — the server's typed filters and attribute sort. The same
// fixture is checked on the backend
// (packages/backend/src/test/attributeCompareParity.integration.test.ts).
// Also here: file.hasLink resolves links as the server's wikilink edges do,
// and EvalNode.value_types comes from the tag schemas.

import { describe, it, expect } from "vitest";
import fixture from "./fixtures/attributeCompareParity.json";
import { applyView, attributeValueTypes, evalFilter, linkTargetsResolver, type EvalNode } from "../lib/basesEval";
import { parseBaseSpec } from "@onden/markdown";
import type { AttributeValueType } from "@onden/markdown";

const nodes: EvalNode[] = fixture.notes.map((n) => {
  // Each attribute is [value, value_type].
  const attrs = Object.entries(n.attrs as Record<string, string[]>);
  return {
    id: n.key, title: n.key, markdown: "", node_type: "content",
    frontmatter: Object.fromEntries(attrs.map(([k, [v]]) => [k, v])),
    value_types: Object.fromEntries(attrs.map(([k, [, t]]) => [k, t as AttributeValueType])),
  };
});

describe("Bases attribute comparisons match the server's (D49)", () => {
  for (const f of fixture.filters) {
    it(f.expr, () => {
      const rows = nodes.filter((n) => evalFilter(n, { kind: "leaf", expr: f.expr }));
      expect(rows.map((r) => r.id).sort()).toEqual([...f.expect].sort());
    });
  }
  for (const s of fixture.sorts) {
    it(`order: [${s.dir === "desc" ? "-" : ""}${s.key}]`, () => {
      const spec = parseBaseSpec(`views:\n  - type: table\n    name: t\n    order: [${s.dir === "desc" ? "-" : ""}${s.key}]\n`);
      expect(applyView(nodes, spec, spec.views[0]!).map((r) => r.id)).toEqual(s.expect);
    });
  }
});

describe("value types from the tag schemas", () => {
  it("a field's storage type governs; a free-form value is typed by its grammar", () => {
    const fields: Record<string, Array<{ name: string; type: string }>> = {
      book: [{ name: "rating", type: "rating" }, { name: "isbn", type: "text" }],
    };
    expect(attributeValueTypes(
      { rating: "5", isbn: "9780", due: "2026-10-01", note: "hi" }, ["book", "label"], (id) => fields[id],
    )).toEqual({ rating: "number", isbn: "text", due: "date", note: "text" });
  });

  it("a text field's digits never compare as a number", () => {
    const n: EvalNode = {
      id: "1", title: "T", markdown: "", node_type: "content",
      frontmatter: { isbn: "9780" }, value_types: { isbn: "text" },
    };
    expect(evalFilter(n, { kind: "leaf", expr: "isbn > 1" })).toBe(false);
    expect(evalFilter(n, { kind: "leaf", expr: 'isbn == "9780"' })).toBe(true);
  });
});

describe("file.hasLink resolves links like the server's wikilink edges", () => {
  const plan = { id: "p", title: "Plan", slug: "plan", node_type: "content", space_id: "s1", attrs: { aliases: '["Roadmap"]' } };
  const other = { id: "o", title: "Elsewhere", slug: "elsewhere", node_type: "content", space_id: "s2", attrs: { aliases: "Old" } };
  const linkTargets = linkTargetsResolver([plan, other]);
  const from = (markdown: string, space_id: string | null = "s1"): EvalNode =>
    ({ id: "n", title: "N", markdown, node_type: "content", space_id });
  const hasLink = (n: EvalNode, name: string) => evalFilter(n, { kind: "leaf", expr: `file.hasLink("${name}")` }, { linkTargets });

  it("counts |alias, #heading, ^block and the note's aliases", () => {
    expect(hasLink(from("see [[Plan|our plan]]"), "Plan")).toBe(true);
    expect(hasLink(from("see [[plan#^abc123]]"), "Plan")).toBe(true);
    expect(hasLink(from("see [[Plan#Goals]]"), "Plan")).toBe(true);
    expect(hasLink(from("see [[Roadmap]]"), "Plan")).toBe(true);
    expect(hasLink(from("see [[Roadmap]]"), "Roadmap")).toBe(true);
    expect(hasLink(from("see [[Planning]]"), "Plan")).toBe(false);
  });

  it("follows the space rule; a name no note answers is matched by name", () => {
    // Elsewhere lives in s2: from s1 its alias reaches nothing…
    expect(hasLink(from("[[Old]]"), "Elsewhere")).toBe(false);
    expect(hasLink(from("[[Old]]", "s2"), "Elsewhere")).toBe(true);
    // …and [[Elsewhere]] there is a dangling link, which still names it.
    expect(hasLink(from("[[Elsewhere]]"), "Elsewhere")).toBe(true);
    expect(hasLink(from("[[Nowhere|x]]"), "nowhere")).toBe(true);
    // Without linkTargets the names alone decide.
    expect(evalFilter(from("[[Plan|our plan]]"), { kind: "leaf", expr: 'file.hasLink("Plan")' })).toBe(true);
  });
});
