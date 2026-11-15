// A ```steps figure in the offline HTML exports (md2html): the file runs no
// player, so every step is written out in order, through the same sanitizer.
import { describe, expect, it } from "vitest";
import { md2html } from "../modules/website/publishing/htmlUtils.js";
import { publishedCspContent } from "../modules/website/publishing/htmlUtils.js";

const NOTE = "Intro\n\n````steps\nAbout it.\n\n## First\n```js\nlet a = 1;\n```\n\n## Second\n<script>alert(1)</script>\n\n- a\n- b\n````\n\nEnd";

describe("md2html with a steps figure", () => {
  const html = md2html(NOTE);

  it("lists each step's title and content in order", () => {
    const at = (s: string) => html.indexOf(s);
    expect(at("About it.")).toBeGreaterThan(-1);
    expect(at(">First<")).toBeGreaterThan(at("About it."));
    expect(at("let")).toBeGreaterThan(at(">First<"));
    expect(at(">Second<")).toBeGreaterThan(at("let"));
    expect(at("<li>b</li>")).toBeGreaterThan(at(">Second<"));
    expect(html).toContain("End");
  });

  it("is a plain document: no fence text, no script", () => {
    expect(html).not.toContain("language-steps");
    expect(html).not.toContain("<script");
    expect(html).toContain("&#x3C;script>");
  });

  it("the page's policy still allows no script of its own", () => {
    expect(publishedCspContent({ variant: "static" })).toContain("script-src 'none'");
  });

  it("leaves a note without a figure alone", () => {
    expect(md2html("plain")).toContain("<p>plain</p>");
    expect(md2html("```js\n// steps\n```")).toContain("language-js");
  });
});
