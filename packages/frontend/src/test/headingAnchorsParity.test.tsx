// Heading-anchor parity (audit D62): the app's renderer and the published
// site's TOC read a note's headings the way @onden/markdown headingAnchors
// does (the shared fixture: packages/markdown/src/fixtures/headingAnchors.json;
// the backend's md2html loads it too). The bugs it pins: rendered headings had
// no id, so the published TOC linked nowhere; `## 目標` linked to "#"; a
// `## comment` in a code fence was in the TOC; [[Note#Goals]] dropped the
// heading.

import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DOM_ID_PREFIX } from "@onden/markdown";
import MarkdownRenderer from "../components/MarkdownRenderer";
import { extractTOC } from "../components/templates/publishedCore";
import { extractHeadings } from "../lib/noteOutline";

const fixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../markdown/src/fixtures");
const fixture = JSON.parse(readFileSync(resolve(fixtureDir, "headingAnchors.json"), "utf8")) as {
  markdown: string; anchors: Array<{ depth: number; text: string; id: string }>; notHeadings: string[];
};
const note = readFileSync(resolve(fixtureDir, fixture.markdown), "utf8");
const headingIds = (root: ParentNode) => [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => h.id);

describe("heading anchors on screen and in the TOC (shared fixture)", () => {
  for (const profile of ["app", "published"] as const) {
    it(`MarkdownRenderer (${profile}): heading ids == headingAnchors ids == TOC hrefs`, () => {
      const { container } = render(<MarkdownRenderer profile={profile}>{note}</MarkdownRenderer>);
      const ids = headingIds(container);
      expect(ids).toEqual(fixture.anchors.map((a) => `${DOM_ID_PREFIX}${a.id}`));
      const toc = extractTOC(note);
      expect(toc.map((e) => e.text)).toEqual(fixture.anchors.filter((a) => a.depth === 2 || a.depth === 3).map((a) => a.text));
      // (1) every TOC link has its heading on the page.
      for (const e of toc) expect(ids, e.href).toContain(e.href.slice(1));
    });
  }

  it("(2) a CJK heading's TOC link is its own anchor, not '#'", () => {
    expect(extractTOC("## 目標")).toEqual([{ id: "目標", href: "#user-content-目標", text: "目標", level: 2 }]);
  });

  it("(3) a heading-like line in a code fence is not in the TOC", () => {
    expect(extractTOC("```\n## comment\n```\n\n## Real").map((e) => e.text)).toEqual(["Real"]);
    for (const text of fixture.notHeadings) expect(extractTOC(note).map((e) => e.text), text).not.toContain(text);
  });

  it("(4) a [[Note#Heading]] link forwards the heading; a same-note [[#Heading]] links in the page", () => {
    const navs: unknown[][] = [];
    const { container } = render(
      <MarkdownRenderer nodes={[{ id: "n1", slug: "plan", title: "Plan" } as never]} linkStyle="published"
        onNavigate={(...args) => navs.push(args)}>
        {"## 目標\n\nSee [[Plan#Goals]] and [[#目標]]."}
      </MarkdownRenderer>,
    );
    fireEvent.click(container.querySelector("button.published-inline-link")!);
    expect(navs).toEqual([["plan", "n1", undefined, "Goals"]]);
    const inPage = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(inPage).toEqual(["#user-content-目標"]);
  });

  it("(5) the info panel's 段落 list is the fixture's h1–h3, each on its own line", () => {
    const expected = fixture.anchors.filter((a) => a.depth <= 3);
    const headings = extractHeadings(note);
    expect(headings.map((h) => [h.level, h.text])).toEqual(expected.map((a) => [a.depth, a.text]));
    const lines = note.split("\n");
    for (const h of headings) expect(lines[h.line], h.text).toContain(h.text.split(" ")[0]);
  });
});
