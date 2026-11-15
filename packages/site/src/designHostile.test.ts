// The home-page design is data the owner's browser, an agent or a restored backup can store, and the public
// site draws it. These tests feed the validator and the CSS path hostile values (the review of 2026-11-11,
// docs/archive/deep-review-publish-2026-11-11.md) and check what is left is inert: never a throw, only
// values the style tokens allow, no way to close the `<style>` the CSS goes into, and no prototype pollution.

import { describe, expect, it } from "vitest";
import { defaultDesign, validateDesign } from "./designV3.js";
import { scopedCss, sanitizeSiteCss, SITE_CSS_MAX } from "./css.js";
import { STYLE_PRESET_NAMES, SCHEMES } from "./style.js";
import { COMPONENTS_MAX } from "./registry.js";
import { walkHome } from "./walk.js";

/** The rendered CSS text must never contain what ends a raw-text `<style>`, nor an import. */
function assertInertCss(css: string): void {
  expect(css).not.toContain("<");
  expect(css).not.toMatch(/@import/i);
  expect(css).not.toMatch(/@\s*\\/);
}

const HOSTILE_CSS = [
  "</style><script>alert(1)</script>",
  "a{}</STYLE ><img src=x onerror=alert(1)>",
  "@import url(//evil.example/x.css);",
  "@im\\70ort 'https://evil.example/x.css';",
  "@\\69mport url(x);",
  "@i@import;mport url(x);",
  "@@import;import url(x);",
  "a{background:url('javascript:alert(1)')}</style>",
  "/* </style> */ p{color:red}",
  "p{content:'</sty\\6c e>'}",
  "@ <",
  "\\<\\/style>",
];

describe("hostile design values", () => {
  it("a hostile accent, preset and scheme fall back to the allowed values", () => {
    const { design, problems } = validateDesign({
      v: 3, preset: "x\"onload=alert(1)", style: { accent: "red;}</style><script>x</script>", preset: "<b>", scheme: "javascript:" },
    });
    expect(design.style.accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(STYLE_PRESET_NAMES).toContain(design.style.preset);
    expect(SCHEMES).toContain(design.style.scheme);
    expect(problems.length).toBeGreaterThan(0);
  });

  it.each(HOSTILE_CSS.map((css) => [css]))("the design's CSS %j cannot end the style element or import another sheet", (css) => {
    const { design } = validateDesign({ v: 3, css, preset: null, legacy_home: { content: [{ type: "stack", props: { id: "s1", css, items: [] } }] } });
    assertInertCss(scopedCss(design.css, design.legacy_home));
    // Sanitising what the sanitiser wrote changes nothing: a stored copy is as safe as the first.
    const once = sanitizeSiteCss(css);
    expect(sanitizeSiteCss(once)).toBe(once);
    assertInertCss(once);
  });

  it("CSS over the cap is dropped, not cut into something that parses differently", () => {
    const { design, problems } = validateDesign({ v: 3, css: `a{color:red}${" ".repeat(SITE_CSS_MAX)}` });
    expect(design.css).toBe("");
    expect(problems.join()).toContain("over");
  });

  it("__proto__ / constructor keys in a design pollute nothing", () => {
    const hostile = JSON.parse(
      '{"v":3,"__proto__":{"polluted":1},"boxes":{"__proto__":{"polluted":2},"constructor":{"prototype":{"polluted":3}}},'
      + '"style":{"__proto__":{"polluted":4}},"legacy_home":{"content":[{"type":"stack","props":{"id":"a","__proto__":{"polluted":5},"items":[]}}]}}',
    );
    validateDesign(hostile);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("a design nested thousands deep or listing a million boxes neither throws nor takes long", () => {
    let nested: unknown = { type: "stack", props: { id: "leaf", items: [] } };
    for (let i = 0; i < 5000; i++) nested = { type: "stack", props: { id: `s${i}`, items: [nested] } };
    const started = Date.now();
    const result = validateDesign({ v: 3, preset: null, legacy_home: { content: [nested] }, boxes: { foot: new Array(1_000_000).fill({ widget: "copyright", variant: "simple" }) } });
    expect(Date.now() - started).toBeLessThan(5000);
    let count = 0;
    if (result.design.legacy_home) walkHome(result.design.legacy_home, () => { count++; });
    expect(count).toBeLessThanOrEqual(COMPONENTS_MAX);
  });

  it("junk of every shape never throws and always returns a design that validates to itself", () => {
    // A small deterministic generator (no extra dependency): objects, arrays, strings, numbers, nulls.
    let seed = 20261111;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const keys = ["v", "preset", "boxes", "style", "css", "legacy_home", "content", "type", "props", "items", "id", "accent", "scheme", "reading", "date_tags", "foot", "header", "widget", "variant", "noteId", "tagId", "cls", "css", "__proto__"];
    const junk = (depth: number): unknown => {
      const r = next();
      if (depth > 4 || r < 0.25) return [null, 3, "x", "</style>", true, -1, 1e999, NaN, "#12345g", "#ABCDEF"][Math.floor(next() * 10)];
      if (r < 0.5) return Array.from({ length: Math.floor(next() * 4) }, () => junk(depth + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(next() * 5) }, () => [keys[Math.floor(next() * keys.length)]!, junk(depth + 1)]));
    };
    for (let i = 0; i < 400; i++) {
      const input = { v: 3, ...(junk(0) as object) };
      const first = validateDesign(input).design;
      expect(first.v).toBe(3);
      expect(first.style.accent).toMatch(/^#[0-9a-f]{6}$/);
      expect(validateDesign(first).design).toEqual(first);
      assertInertCss(scopedCss(first.css, first.legacy_home));
    }
    expect(validateDesign(defaultDesign()).design).toEqual(defaultDesign());
  });
});
