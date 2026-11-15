// Block anchors on screen: the app's renderer and the published site's renderer tag the same blocks
// (`data-block-id`) from a note's anchors, whatever kind of block it is — a heading, a paragraph, a list item (nested
// too), a quote — and show no id in the text. The bug it pins (audit D59): a list item's or heading's anchor tagged
// nothing, so a link to it could not scroll there. The text carries no `^id` (段落錨點批 3); a `^word` typed in it is
// just text. The shared fixture (packages/markdown/src/fixtures/blockAnchors.json) is in the OLD form and belongs to
// the markdown package's own parity test.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import MarkdownRenderer from "../components/MarkdownRenderer";

const NOTE = "## Title\n\nA paragraph\nover two lines.\n\n- item one\n- item two\n  - nested\n\n> quoted words\n\nlast ^typed";
const at = (words: string) => ({ from: NOTE.indexOf(words), to: NOTE.indexOf(words) + words.length });
const ANCHORS = [
  { id: "h1", ...at("## Title") },
  { id: "p1", ...at("A paragraph\nover two lines.") },
  { id: "li1", ...at("- item one") },
  { id: "li2", ...at("- nested") },
  { id: "qp", ...at("quoted words") },
];

describe("block anchors on screen and in the preview", () => {
  for (const profile of ["app", "published"] as const) {
    it(`MarkdownRenderer (${profile}) tags each anchored block, and the text shows no id`, () => {
      const { container } = render(<MarkdownRenderer profile={profile} blockAnchors={ANCHORS}>{NOTE}</MarkdownRenderer>);
      const tagged = [...container.querySelectorAll("[data-block-id]")].map((el) => [el.getAttribute("data-block-id"), el.tagName.toLowerCase()]);
      expect(tagged).toEqual([["h1", "h2"], ["p1", "p"], ["li1", "li"], ["li2", "li"]]);
      const text = container.textContent ?? "";
      for (const { id } of ANCHORS) expect(text, id).not.toContain(id);
      // Not an anchor: shown as typed.
      expect(text).toContain("^typed");
    });

    it(`MarkdownRenderer (${profile}) tags nothing when the note has no anchors`, () => {
      const { container } = render(<MarkdownRenderer profile={profile}>{NOTE}</MarkdownRenderer>);
      expect(container.querySelectorAll("[data-block-id]")).toHaveLength(0);
    });
  }
});
