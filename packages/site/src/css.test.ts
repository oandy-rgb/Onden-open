import { describe, expect, it } from "vitest";
import { bracesBalanced, sanitizeSiteCss, scopedCss, usesImport } from "./css.js";
import { defaultDesignV2 } from "./defaults.js";
import type { PuckData } from "./design.js";

const withCss = (css: string, parts: Array<{ id: string; css: string }> = []): [string, PuckData] => [
  css,
  { root: { props: {} }, content: parts.map((p) => ({ type: "stack", props: { id: p.id, css: p.css, items: [] } })) },
];

describe("bracesBalanced", () => {
  it.each([
    ["", true], ["a { b: c }", true], ["a { b { c: d } }", true], ["a { content: '}' }", true], ['a::after { content: "{" }', true],
    ["/* } */ a { b: c }", true], ["a { b: c", false], ["a { b: c } }", false], ["} a {", false], ["a { /* { */ b: c", false],
    ["a { content: 'x", false], ["a { b: \\} }", true],
  ])("%j → %s", (css, ok) => expect(bracesBalanced(css)).toBe(ok));
});

describe("sanitizeSiteCss", () => {
  it("neutralises </style in any case and cannot rebuild it", () => {
    for (const css of ["</style>", "</STYLE>", "</sty</stylele>", "a{}</Style><script>x</script>"]) {
      expect(sanitizeSiteCss(css).toLowerCase()).not.toContain("</style");
      expect(sanitizeSiteCss(css)).not.toContain("<");
    }
  });
  it("strips @import, also when escaped", () => {
    expect(sanitizeSiteCss('@import url("https://x/y.css"); a { b: c }')).not.toMatch(/import/i);
    expect(sanitizeSiteCss("@IMPORT 'x.css';\na{}")).not.toMatch(/import/i);
    expect(sanitizeSiteCss("@\\69mport 'x.css'; a{}")).not.toContain("@\\");
    expect(sanitizeSiteCss("a { b: c }")).toBe("a { b: c }");
  });
  it("cannot be made to rebuild @import from what a removal leaves behind", () => {
    for (const css of ["@i@import;mport url(https://x/y.css);", "@@import;import url(x);", "@i@i@import;mport;mport url(x);", "@\\@import;import url(x);"]) {
      expect(sanitizeSiteCss(css), css).not.toMatch(/@\s*\\?\s*import/i);
      expect(usesImport(css), css).toBe(true);
    }
  });
  it("usesImport is false for ordinary CSS", () => {
    expect(usesImport("a { color: red }")).toBe(false);
    expect(usesImport("@media (min-width: 1px) { a { b: c } }")).toBe(false);
    expect(usesImport(null)).toBe(false);
  });
});

describe("scopedCss", () => {
  it("scopes site CSS to .site-scope and part CSS to its data-node, nesting inside :scope", () => {
    const out = scopedCss(...withCss("p { color: red }", [{ id: "s1", css: "& h2 { margin: 0 }" }]));
    expect(out).toBe(
      '@scope (.site-scope) {\n:scope {\np { color: red }\n}\n}\n'
      + '@scope (.site-scope [data-node="s1"]) {\n:scope[data-node="s1"] {\n& h2 { margin: 0 }\n}\n}',
    );
  });
  it("puts every block inside an @scope, so selectors that point outside it match nothing (GAP-246)", () => {
    // `:root:has(&)`, `:not(&)` and `& ~ x` escaped plain nesting; inside @scope a rule only matches
    // elements under its root. The containment itself is the browser's (checked in e2e sitePages).
    const escapes = ":root:has(&) .hs-button { display: none } :not(&) > p { color: red } & ~ * { color: red }";
    const out = scopedCss(...withCss(escapes, [{ id: "p1", css: escapes }]));
    const blocks = out.split(/\n(?=@scope )/);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).toMatch(/^@scope \(\.site-scope( \[data-node="p1"\])?\) \{\n:scope(\[data-node="p1"\])? \{\n/);
      expect(block.endsWith("\n}\n}")).toBe(true);
      expect(bracesBalanced(block)).toBe(true);
    }
  });
  it("skips blocks whose braces do not balance, keeps the rest", () => {
    const out = scopedCss(...withCss("a { b: c", [{ id: "ok", css: "x { y: z }" }, { id: "bad", css: "} body { display: none" }]));
    expect(out).toBe('@scope (.site-scope [data-node="ok"]) {\n:scope[data-node="ok"] {\nx { y: z }\n}\n}');
  });
  it("a closing brace cannot break out of the scope", () => {
    expect(scopedCss(...withCss("} body { display: none } .x {"))).toBe("");
  });
  it("neutralises </style and strips @import in both kinds of block", () => {
    const out = scopedCss(...withCss("@import 'a.css'; a{}</style><script>1</script>", [{ id: "p", css: "</STYLE>b{}" }]));
    expect(out.toLowerCase()).not.toContain("</style");
    expect(out).not.toContain("<script");
    expect(out).not.toMatch(/@import/);
  });
  it("skips a part whose id could not sit in an attribute selector", () => {
    expect(scopedCss(...withCss("", [{ id: 'a"] { } x[', css: "a { b: c }" }]))).toBe("");
  });
  it("is empty for a design without CSS", () => {
    expect(scopedCss("", defaultDesignV2().home)).toBe("");
  });
});
