import { describe, expect, it } from "vitest";
import { diagramsBySource, diagramKindOf, mermaidSources, validateDiagramLayout } from "./diagramLayout.js";
import { GOOD, SOURCE } from "./test/diagramFixture.js";
import { DIAGRAM_CSS, diagramSvgTree, SVG_ATTRS, SVG_TAGS, type SvgNode } from "./diagramSvg.js";

const clone = () => structuredClone(GOOD) as DiagramLayout & Record<string, any>;
const bad = (mutate: (l: any) => void, source = SOURCE) => { const l = clone(); mutate(l); return validateDiagramLayout(l, source); };

describe("mermaidSources", () => {
  it("reads blocks the way the renderers do", () => {
    expect(mermaidSources("a\n```mermaid\ngraph TD\n  A-->B\n```\nb\n~~~mermaid\nstateDiagram-v2\n~~~\n```js\nx\n```")).toEqual(["graph TD\n  A-->B", "stateDiagram-v2"]);
    expect(mermaidSources("  ```mermaid\n  graph TD\n   A-->B\n  ```")).toEqual(["graph TD\n A-->B"]);
    expect(mermaidSources("- ```mermaid\n  graph TD\n  ```")).toEqual([]);
  });
  it("kind", () => {
    expect(diagramKindOf("%% c\ngraph LR\nA-->B")).toBe("flowchart");
    expect(diagramKindOf("stateDiagram-v2\n[*] --> A")).toBe("state");
    for (const s of ["sequenceDiagram\nA->>B: hi", "gantt\n", "pie\n", "", "journey"]) expect(diagramKindOf(s)).toBeNull();
  });
});

describe("validateDiagramLayout", () => {
  it("accepts a good layout and rebuilds it", () => {
    const r = validateDiagramLayout({ ...GOOD, extra: "<script>" }, SOURCE);
    expect(r).toEqual({ ok: true, layout: GOOD });
  });
  const cases: Array<[string, (l: any) => void]> = [
    ["a label with a script tag", (l) => { l.nodes[0].label = "<script>alert(1)</script>"; }],
    ["a label not in the block", (l) => { l.nodes[0].label = "Secret"; }],
    ["an edge label not in the block", (l) => { l.edges[1].label = "no"; }],
    ["a path with letters", (l) => { l.edges[0].path = "M0,0 L1,1 onload=x"; }],
    ["a relative path", (l) => { l.edges[0].path = "m0,0l1,1"; }],
    ["an arc path", (l) => { l.edges[0].path = "M0,0A1,1 0 0 1 2,2"; }],
    ["an exponent number", (l) => { l.edges[0].path = "M0,0L1e9,1"; }],
    ["a path not starting with M", (l) => { l.edges[0].path = "L0,0L1,1"; }],
    ["a path with url()", (l) => { l.edges[0].path = "M0,0 url(http://x)"; }],
    ["an unknown shape", (l) => { l.nodes[0].shape = "foreignObject"; }],
    ["an unknown arrow", (l) => { l.edges[0].arrow_end = "x\" onload=\""; }],
    ["a bad id", (l) => { l.nodes[0].id = "a\"><script>"; }],
    ["a duplicate id", (l) => { l.nodes[1].id = "A"; }],
    ["an edge to nowhere", (l) => { l.edges[0].to = "Z"; }],
    ["NaN", (l) => { l.nodes[0].x = Number.NaN; }],
    ["a string number", (l) => { l.nodes[0].x = "10"; }],
    ["a huge coordinate", (l) => { l.nodes[0].x = 1e9; }],
    ["a negative size", (l) => { l.nodes[0].w = -1; }],
    ["a wrong version", (l) => { l.version = 2; }],
    ["a kind that differs from the block", (l) => { l.kind = "state"; }],
    ["too many nodes", (l) => { l.nodes = Array.from({ length: 101 }, (_, i) => ({ ...l.nodes[0], id: `n${i}` })); }],
    ["too many edges", (l) => { l.edges = Array.from({ length: 201 }, (_, i) => ({ ...l.edges[0], id: `e${i}` })); }],
    ["a very long label", (l) => { l.nodes[0].label = "Start".repeat(100); }],
    ["a control character in a label", (l) => { l.nodes[0].label = "Start\u0000"; }],
    ["no nodes", (l) => { l.nodes = []; }],
  ];
  for (const [name, mutate] of cases) it(`rejects ${name}`, () => expect(bad(mutate).ok).toBe(false));
  it("rejects a type this version does not draw, and non-objects", () => {
    expect(validateDiagramLayout(GOOD, "sequenceDiagram\nStart->>Go: hi").ok).toBe(false);
    for (const raw of [null, 1, "x", [], undefined]) expect(validateDiagramLayout(raw, SOURCE).ok).toBe(false);
  });
  it("allows a bare comparison in a label", () => {
    const r = validateDiagramLayout({ ...GOOD, nodes: [{ ...GOOD.nodes[0], label: "x > 5" }, ...GOOD.nodes.slice(1)] }, `${SOURCE}\n  A[x > 5]`);
    expect(r.ok).toBe(true);
  });
  it("diagramsBySource keeps only what passes", () => {
    const map = diagramsBySource([{ source: SOURCE, layout: GOOD }, { source: SOURCE.replace("Go", "Stop"), layout: GOOD }, { source: 1 }, null]);
    expect([...map.keys()]).toEqual([SOURCE]);
  });
});

describe("diagramSvgTree", () => {
  const walk = (node: SvgNode, visit: (n: SvgNode) => void) => { visit(node); node.children?.forEach((c) => walk(c, visit)); };
  it("uses only the allowed tags and attributes, and no markup in values", () => {
    const hostile = { ...GOOD, nodes: [{ ...GOOD.nodes[0], label: "Start" }, ...GOOD.nodes.slice(1)] };
    const tree = diagramSvgTree(hostile);
    walk(tree, (n) => {
      expect(SVG_TAGS).toContain(n.tag);
      for (const [k, v] of Object.entries(n.attrs ?? {})) {
        expect(SVG_ATTRS).toContain(k);
        expect(String(v)).not.toMatch(/url\(|javascript:|<|on\w+=/i);
      }
    });
  });
  it("draws every node and edge, and the texts as text nodes", () => {
    const texts: string[] = [];
    walk(diagramSvgTree(GOOD), (n) => { if (n.text) texts.push(n.text); });
    expect(texts).toEqual(["yes", "Start", "Ready?", "Go"]);
  });
  it("css has no url() or import", () => expect(DIAGRAM_CSS).not.toMatch(/url\(|@import/));
});
