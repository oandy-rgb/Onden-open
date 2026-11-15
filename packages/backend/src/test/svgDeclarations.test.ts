// An SVG with a DOCTYPE / ENTITY is refused at upload (hasXmlDeclarations), and
// published HTML shows an uploaded SVG only as an <img>, never as a link that
// opens it as a document. Pure: no DB.

import { describe, it, expect } from "vitest";
import { hasXmlDeclarations } from "../services/svgSanitize.js";
import { md2html } from "../modules/website/publishing/htmlUtils.js";

describe("hasXmlDeclarations", () => {
  it("catches DOCTYPE and ENTITY in any case or spacing", () => {
    for (const text of [
      `<!DOCTYPE svg [<!ENTITY a "inert">]><svg/>`,
      `<!doctype svg><svg/>`,
      `<svg><!ENTITY a "x"></svg>`,
      `< !DocType svg><svg/>`,
      `<\x00!ENTITY a "x"><svg/>`,
    ]) expect(hasXmlDeclarations(text)).toBe(true);
  });

  it("leaves an ordinary drawing alone", () => {
    expect(hasXmlDeclarations(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><!-- note --><rect/></svg>`)).toBe(false);
  });
});

describe("published HTML and uploaded SVGs", () => {
  it("turns a link to an uploaded SVG into an <img>", () => {
    const html = md2html("[圖](/api/media/0123456789abcdef0123456789abcdef.svg)");
    expect(html).toContain("<img");
    expect(html).toContain("0123456789abcdef0123456789abcdef.svg");
    expect(html).not.toMatch(/<a [^>]*\.svg/);
  });

  it("keeps an ordinary link and an SVG image as they were", () => {
    expect(md2html("[文件](/api/media/0123456789abcdef0123456789abcdef.pdf)")).toMatch(/<a [^>]*\.pdf/);
    expect(md2html("![圖](/api/media/0123456789abcdef0123456789abcdef.svg)")).toContain("<img");
  });
});
