// Heading-anchor parity (audit D62), the exports' side: md2html (the zip and
// the single-note export) gives every heading the id @onden/markdown
// headingAnchors reads (the shared fixture
// packages/markdown/src/fixtures/headingAnchors.json, which the app's renderer
// and the published TOC load too), and a [[Note#Heading]] link points at that
// heading on the page it opens — it used to drop the heading.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { headingAnchors, DOM_ID_PREFIX } from "@onden/markdown";
import { md2html } from "../modules/website/publishing/htmlUtils.js";

const fixtureDir = new URL("../../../markdown/src/fixtures/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("headingAnchors.json", fixtureDir), "utf8")) as {
  markdown: string; anchors: Array<{ depth: number; text: string; id: string }>; notHeadings: string[];
};
const note = readFileSync(new URL(fixture.markdown, fixtureDir), "utf8");
const headingIds = (html: string) => [...html.matchAll(/<h[1-6]\b[^>]*\sid="([^"]*)"/g)].map((m) => m[1]);
const hrefs = (html: string) => [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1]);

describe("md2html and headingAnchors agree (shared fixture)", () => {
  it("each heading carries its anchor id, prefixed as the sanitizer does", () => {
    expect(headingAnchors(note)).toEqual(fixture.anchors);
    expect(headingIds(md2html(note))).toEqual(fixture.anchors.map((a) => `${DOM_ID_PREFIX}${a.id}`));
  });
});

describe("[[Note#Heading]] in the exports", () => {
  const pages = [
    { id: "p1", title: "Plan", slug: "plan", markdown: "## 目標\n\n## Goals\n\n## Goals" },
    { id: "p2", title: "Old", slug: "old" },
  ];

  it("the zip (sibling pages) and the single export (site paths) link to the heading's anchor", () => {
    const md = "[[Plan#目標]] [[Plan#goals]] [[Plan#goals-1]] [[Plan#^b1]] [[Plan#Missing]] [[Old#Goals]]";
    expect(hrefs(md2html(md, { pages, relative: true }))).toEqual([
      "../plan/#user-content-目標", "../plan/#user-content-goals", "../plan/#user-content-goals-1",
      "../plan/", "../plan/", "../old/",
    ]);
    expect(hrefs(md2html(md, { pages }))).toEqual([
      "/site/plan#user-content-目標", "/site/plan#user-content-goals", "/site/plan#user-content-goals-1",
      "/site/plan", "/site/plan", "/site/old",
    ]);
  });

  it("a same-page [[#Heading]] links within the page; an unknown one stays text", () => {
    const html = md2html("## 目標\n\nSee [[#目標]] and [[#Nowhere]].", { pages });
    expect(hrefs(html)).toEqual(["#user-content-目標"]);
    expect(headingIds(html)).toEqual(["user-content-目標"]);
    expect(html).toContain("#Nowhere");
  });
});
