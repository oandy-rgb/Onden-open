// Guard: a diagram layout is an upload anyone can forge, so what the server
// accepts and draws is held to a fixed gate (docs/architecture/precompiled-diagrams.md).
// 1. A corpus of malicious uploads: every one is refused.
// 2. Whatever IS accepted is drawn with the template's own tags and attributes,
//    survives an allow-list sanitizer untouched, and carries no script, event
//    handler, link, style or url().
import rehypeSanitize from "rehype-sanitize";
import { unified } from "unified";
import rehypeStringify from "rehype-stringify";
import { describe, expect, it } from "vitest";
import { validateDiagramLayout, type DiagramLayout } from "../../diagramLayout.js";
import { diagramHast, diagramSvgTree, SVG_ATTRS, SVG_TAGS } from "../../diagramSvg.js";
import { GOOD, SOURCE } from "../diagramFixture.js";

const withNode = (patch: Record<string, unknown>) => ({ ...GOOD, nodes: [{ ...GOOD.nodes[0], ...patch }, ...GOOD.nodes.slice(1)] });
const withEdge = (patch: Record<string, unknown>) => ({ ...GOOD, edges: [{ ...GOOD.edges[0], ...patch }, ...GOOD.edges.slice(1)] });

const MALICIOUS: Array<[string, unknown, string?]> = [
  ["script tag in a node label", withNode({ label: "<script>alert(1)</script>" })],
  ["img onerror in a label", withNode({ label: "<img src=x onerror=alert(1)>" })],
  ["svg onload in a label", withNode({ label: "<svg onload=alert(1)>" })],
  ["a label that is not in the block", withNode({ label: "Totally different" })],
  ["foreignObject as a shape", withNode({ shape: "foreignObject" })],
  ["script as a shape", withNode({ shape: "script" })],
  ["quote-breaking node id", withNode({ id: 'a" onload="x' })],
  ["space in a node id", withNode({ id: "a b" })],
  ["javascript url as an id", withNode({ id: "javascript:alert(1)" })],
  ["path with a url()", withEdge({ path: "M0,0L1,1 url(#x)" })],
  ["path with an event attribute", withEdge({ path: 'M0,0" onload="alert(1)' })],
  ["path with a script tag", withEdge({ path: "M0,0<script>" })],
  ["path with an arc command", withEdge({ path: "M0,0A5,5,0,0,1,9,9" })],
  ["path with relative commands", withEdge({ path: "m0,0l5,5" })],
  ["path with an exponent", withEdge({ path: "M0,0L1e999,5" })],
  ["path with a huge number", withEdge({ path: "M0,0L99999999,5" })],
  ["path longer than the limit", withEdge({ path: `M0,0${"L1,1".repeat(2000)}` })],
  ["arrow outside the list", withEdge({ arrow_end: "arrow\" onload=\"x" })],
  ["line style outside the list", withEdge({ line: "dashed; background:url(x)" })],
  ["edge label with markup", withEdge({ label: "<b>yes</b>" })],
  ["edge to an unknown node", withEdge({ to: "nope" })],
  ["position as a string", withNode({ x: "10" })],
  ["position NaN", withNode({ x: Number.NaN })],
  ["position Infinity", withNode({ y: Number.POSITIVE_INFINITY })],
  ["negative size", withNode({ w: -5 })],
  ["huge canvas", { ...GOOD, width: 1e9 }],
  ["a different version", { ...GOOD, version: 99 }],
  ["a kind that is not the block's", { ...GOOD, kind: "state" }],
  ["too many nodes", { ...GOOD, nodes: Array.from({ length: 500 }, (_, i) => ({ ...GOOD.nodes[0], id: `n${i}` })) }],
  ["nodes as an object", { ...GOOD, nodes: { 0: GOOD.nodes[0] } }],
  ["null", null],
  ["a string of svg", "<svg onload=alert(1)></svg>"],
  ["an array", []],
  ["a sequence diagram's source", GOOD, "sequenceDiagram\nStart->>Go: hi"],
];

describe("malicious diagram uploads", () => {
  for (const [name, upload, source] of MALICIOUS) it(`refuses ${name}`, () => expect(validateDiagramLayout(upload, source ?? SOURCE).ok).toBe(false));
});

const sanitizer = unified().use(rehypeSanitize, {
  tagNames: [...SVG_TAGS, "div"],
  attributes: { "*": [...SVG_ATTRS], div: ["className"] },
  strip: ["script"],
});
const html = unified().use(rehypeStringify);

describe("an accepted diagram's drawing", () => {
  // Text that is safe to carry (escaped on the way out) yet looks like what an attacker would try.
  const NASTY = "x > 5 && y < 3 \"q\" 'a'";
  const source = `${SOURCE}\n  A[${NASTY}]`;
  const layout = validateDiagramLayout({ ...GOOD, nodes: [{ ...GOOD.nodes[0], label: NASTY }, ...GOOD.nodes.slice(1)] }, source);

  it("accepts the awkward but harmless text", () => expect(layout.ok).toBe(true));

  it("passes an allow-list sanitizer unchanged and has no active content", () => {
    const tree = diagramHast(diagramSvgTree((layout as { layout: DiagramLayout }).layout));
    const wrapped = { type: "root" as const, children: [tree] };
    const clean = sanitizer.runSync(wrapped);
    const out = html.stringify(wrapped);
    expect(html.stringify(clean)).toBe(out);
    expect(out).not.toMatch(/<script|<foreignObject|<style|\son\w+=|javascript:|href=|style=|url\(/i);
    expect(out).toContain("x > 5 &#x26;&#x26; y &#x3C; 3");
  });
});
