import { describe, it, expect } from "vitest";
import { parseYaml, parseBaseSpec } from "@onden/markdown";
import { evalFilter, applyView, type EvalNode } from "../lib/basesEval";

describe("F3.2 basesParser / basesEval", () => {
  it("parses a flat map", () => {
    const v = parseYaml("a: 1\nb: hello\n");
    expect(v).toEqual({ a: 1, b: "hello" });
  });

  it("parses a nested map", () => {
    const v = parseYaml("filters:\n  and:\n    - 'file.hasTag(\"book\")'\n");
    expect(v).toEqual({ filters: { and: ['file.hasTag("book")'] } });
  });

  it("parses a list of objects (views)", () => {
    const v = parseYaml(`views:
  - type: table
    name: A
  - type: cards
    name: B
`);
    expect(v).toEqual({ views: [{ type: "table", name: "A" }, { type: "cards", name: "B" }] });
  });

  it("decodes a base spec end-to-end", () => {
    const spec = parseBaseSpec(`
filters:
  and:
    - 'file.hasTag("book")'
    - 'status == "read"'
views:
  - type: table
    name: Reading
    limit: 10
`);
    expect(spec.views).toHaveLength(1);
    expect(spec.views[0].type).toBe("table");
    expect(spec.views[0].limit).toBe(10);
    expect(spec.filters?.kind).toBe("and");
  });

  it("evaluates file.hasTag", () => {
    const node: EvalNode = {
      id: "1", title: "T", markdown: "", node_type: "content",
      class_tag_names: ["Book", "Recent"],
    };
    expect(evalFilter(node, { kind: "leaf", expr: 'file.hasTag("book")' })).toBe(true);
    expect(evalFilter(node, { kind: "leaf", expr: 'file.hasTag("other")' })).toBe(false);
  });

  it("evaluates frontmatter equality", () => {
    const node: EvalNode = {
      id: "1", title: "T", markdown: "", node_type: "content",
      frontmatter: { status: "read", year: 2024 },
    };
    expect(evalFilter(node, { kind: "leaf", expr: 'status == "read"' })).toBe(true);
    expect(evalFilter(node, { kind: "leaf", expr: 'status != "read"' })).toBe(false);
    expect(evalFilter(node, { kind: "leaf", expr: 'note.status == "read"' })).toBe(true);
  });

  it("compares keys in the one attribute key grammar (D44b)", () => {
    const node: EvalNode = {
      id: "1", title: "T", markdown: "", node_type: "content",
      frontmatter: { 作者: "王", "reading-list": "yes", 頁數: 300 },
    };
    expect(evalFilter(node, { kind: "leaf", expr: '作者 == "王"' })).toBe(true);
    expect(evalFilter(node, { kind: "leaf", expr: 'note.作者 != "王"' })).toBe(false);
    expect(evalFilter(node, { kind: "leaf", expr: 'reading-list == "yes"' })).toBe(true);
    expect(evalFilter(node, { kind: "leaf", expr: "頁數 >= 200" })).toBe(true);
  });

  it("evaluates compound and/or/not", () => {
    const n: EvalNode = { id: "1", title: "T", markdown: "", node_type: "content", class_tag_names: ["book"] };
    expect(evalFilter(n, { kind: "and", items: [
      { kind: "leaf", expr: 'file.hasTag("book")' },
      { kind: "leaf", expr: "true" },
    ]})).toBe(true);
    expect(evalFilter(n, { kind: "or", items: [
      { kind: "leaf", expr: 'file.hasTag("none")' },
      { kind: "leaf", expr: 'file.hasTag("book")' },
    ]})).toBe(true);
    expect(evalFilter(n, { kind: "not", items: [
      { kind: "leaf", expr: 'file.hasTag("none")' },
    ]})).toBe(true);
  });

  it("applies a view: filter + order + limit", () => {
    const nodes: EvalNode[] = [
      { id: "1", title: "Banana", markdown: "", node_type: "content", class_tag_names: ["book"] },
      { id: "2", title: "Apple",  markdown: "", node_type: "content", class_tag_names: ["book"] },
      { id: "3", title: "Carrot", markdown: "", node_type: "content", class_tag_names: ["food"] },
    ];
    const spec = parseBaseSpec(`
filters:
  - 'file.hasTag("book")'
views:
  - type: table
    name: Books
    order: [file.name]
    limit: 5
`);
    const out = applyView(nodes, spec, spec.views[0]);
    expect(out.map((n) => n.id)).toEqual(["2", "1"]);
  });

  it("substitutes `this` keyword from EvalContext", () => {
    const node: EvalNode = {
      id: "1", title: "X", markdown: "[[Project Alpha]] some text",
      node_type: "content", class_tag_names: ["Project Alpha"],
    };
    // Without context: `this` stays literal → no tag named "this" → false
    expect(evalFilter(node, { kind: "leaf", expr: 'file.hasTag(this)' })).toBe(false);
    // With context: this → "Project Alpha" → tag matches
    expect(evalFilter(node, { kind: "leaf", expr: 'file.hasTag(this)' }, { thisTitle: "Project Alpha" })).toBe(true);
    // hasLink with substitution
    expect(evalFilter(node, { kind: "leaf", expr: 'file.hasLink(this)' }, { thisTitle: "Project Alpha" })).toBe(true);
    // Word-boundary: identifier `thisYear` shouldn't be substituted
    const expr = 'note.thisYear == "2026"';
    const n2: EvalNode = { id: "2", title: "T", markdown: "", node_type: "content", frontmatter: { thisYear: "2026" } };
    expect(evalFilter(n2, { kind: "leaf", expr }, { thisTitle: "X" })).toBe(true);
  });

  it("evaluates F3.5 event-targeting predicates", () => {
    const n: EvalNode = {
      id: "1", title: "T", markdown: "", node_type: "content",
      last_actor: "claude",
      last_modified_at: "2026-06-01T12:00:00Z",
      recent_actors: ["claude", "andy"],
    };
    // modifiedBy
    expect(evalFilter(n, { kind: "leaf", expr: 'file.modifiedBy("andy")' })).toBe(true);
    expect(evalFilter(n, { kind: "leaf", expr: 'file.modifiedBy("gemini")' })).toBe(false);
    // lastActor ==
    expect(evalFilter(n, { kind: "leaf", expr: 'file.lastActor == "claude"' })).toBe(true);
    expect(evalFilter(n, { kind: "leaf", expr: 'file.lastActor != "claude"' })).toBe(false);
    // eventsSince
    expect(evalFilter(n, { kind: "leaf", expr: 'file.eventsSince("2026-05-01")' })).toBe(true);
    expect(evalFilter(n, { kind: "leaf", expr: 'file.eventsSince("2027-01-01")' })).toBe(false);
    // empty node — predicates return false
    const empty: EvalNode = { id: "2", title: "E", markdown: "", node_type: "content" };
    expect(evalFilter(empty, { kind: "leaf", expr: 'file.modifiedBy("andy")' })).toBe(false);
    expect(evalFilter(empty, { kind: "leaf", expr: 'file.eventsSince("2026-05-01")' })).toBe(false);
    expect(evalFilter(empty, { kind: "leaf", expr: 'file.lastActor == "claude"' })).toBe(false);
  });

  it("H2 — evaluates numeric comparison operators", () => {
    const n: EvalNode = {
      id: "1", title: "T", markdown: "", node_type: "content",
      frontmatter: { priority: 3, score: 7.5 },
    };
    expect(evalFilter(n, { kind: "leaf", expr: "priority > 2" })).toBe(true);
    expect(evalFilter(n, { kind: "leaf", expr: "priority > 5" })).toBe(false);
    expect(evalFilter(n, { kind: "leaf", expr: "priority >= 3" })).toBe(true);
    expect(evalFilter(n, { kind: "leaf", expr: "priority < 3" })).toBe(false);
    expect(evalFilter(n, { kind: "leaf", expr: "priority <= 3" })).toBe(true);
    expect(evalFilter(n, { kind: "leaf", expr: "score > 7" })).toBe(true);
    // Missing field → false (not crash)
    expect(evalFilter(n, { kind: "leaf", expr: "missing > 0" })).toBe(false);
    // Quoted string + numeric op falls through to false (not a meaningful compare)
    expect(evalFilter(n, { kind: "leaf", expr: 'priority > "2"' })).toBe(true); // "2" coerces to 2
  });

  it("H3 — applyView sorts on extended file.* properties", () => {
    const nodes: EvalNode[] = [
      { id: "1", title: "Z", markdown: "[[A]]", node_type: "content",
        last_modified_at: "2026-06-01", class_tag_names: ["x"] },
      { id: "2", title: "A", markdown: "[[B]][[C]]", node_type: "content",
        last_modified_at: "2026-06-10", class_tag_names: ["y"] },
    ];
    const spec = parseBaseSpec(`
views:
  - type: table
    order: [file.mtime]
`);
    const out = applyView(nodes, spec, spec.views[0]);
    // Newer mtime sorts later in default ascending order
    expect(out.map((n) => n.id)).toEqual(["1", "2"]);
  });

  it("strips trailing line-comments outside quotes", () => {
    const v = parseYaml(`a: 1  # comment
b: 'has # inside'  # trailing
`);
    expect(v).toEqual({ a: 1, b: "has # inside" });
  });
});

describe("Logseq 2.0.2 cross-check: malformed filters never throw", () => {
  const nodes: EvalNode[] = [
    { id: "1", title: "A(", markdown: "", node_type: "content", class_tag_names: ["book"] },
  ];
  it.each([
    'file.hasTag("book"',
    'file.name.matches("(")',
    "file.name == ",
    "((((",
    '"unterminated',
    "[abc",
    "title =~ /(/",
  ])("evalFilter / applyView survive %s", (expr) => {
    expect(() => evalFilter(nodes[0]!, { kind: "leaf", expr }, {})).not.toThrow();
    const spec = parseBaseSpec(`filters:\n  - '${expr.replace(/'/g, "''")}'\nviews:\n  - type: table\n    name: V\n    order: ["${expr.replace(/"/g, "'")}"]\n`);
    expect(() => applyView(nodes, spec, spec.views[0]!)).not.toThrow();
  });
});
