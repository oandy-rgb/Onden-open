// SVG sanitation -- pure, DB-free.

import { describe, it, expect } from "vitest";
import { sanitizeSvg } from "./svgSanitize.js";

// A single matcher for the dangerous constructs we never want surviving.
const DANGER =
  /onload|onerror|onmouseover|on\w+\s*=|javascript|vbscript|<\s*script|foreignObject|<\s*iframe|<\s*set\b|<\s*animate|evil\.com|data:text\/html/i;

describe("sanitizeSvg", () => {
  // Each vector must be neutralised. Keyed for readable failures.
  const vectors: Record<string, string> = {
    "inline <script>": `<svg><script>alert(1)</script></svg>`,
    "self-closing <script/>": `<svg><script src="x"/></svg>`,
    "slash-separated onload (no whitespace)": `<svg/onload=alert(1)></svg>`,
    "on* handler on child element": `<svg><image href="#x" onerror="alert(1)"/></svg>`,
    "<foreignObject> with iframe": `<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>`,
    "<foreignObject> with html onload/onerror": `<svg><foreignObject><body onload="alert(1)"><img src=x onerror=alert(1)></body></foreignObject></svg>`,
    "SMIL <set> retargeting href": `<svg><a><set attributeName="href" to="javascript:alert(1)"/></a></svg>`,
    "SMIL <animate> retargeting href": `<svg><a><animate attributeName="href" values="javascript:alert(1)"/></a></svg>`,
    "xlink:href javascript:": `<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`,
    "entity-encoded javascript:": `<svg><a href="&#106;avascript:alert(1)"><text>x</text></a></svg>`,
    "data:text/html href": `<svg><image href="data:text/html,&lt;script&gt;"/></svg>`,
    "external <use> ref": `<svg><use href="https://evil.com/x.svg#a"/></svg>`,
    "external <image> ref": `<svg><image href="https://evil.com/track.png"/></svg>`,
    "protocol-relative ref": `<svg><use href="//evil.com/x#a"/></svg>`,
    "tab-obfuscated javascript:": `<svg><a href="java\tscript:alert(1)"><text>x</text></a></svg>`,
  };

  for (const [name, input] of Object.entries(vectors)) {
    it(`neutralises: ${name}`, () => {
      expect(sanitizeSvg(input)).not.toMatch(DANGER);
    });
  }

  it("preserves same-document (#id) and root-relative refs and ordinary markup", () => {
    const clean = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
      `<defs><linearGradient id="g"/></defs>` +
      `<use href="#g"/>` +
      `<image href="/api/media/logo.png"/>` +
      `<circle cx="5" cy="5" r="4" fill="url(#g)"/>` +
      `<text>hello</text></svg>`;
    const out = sanitizeSvg(clean);
    expect(out).toContain(`href="#g"`);
    expect(out).toContain(`href="/api/media/logo.png"`);
    expect(out).toContain(`fill="url(#g)"`);
    expect(out).toContain("hello");
    expect(out).not.toMatch(DANGER);
  });
});
