// A note's frontmatter is settings, not text: the preview and the published
// page show neither a heading nor a rule for it (stripFrontmatter), while a
// `---` rule later in the note still renders. The editor's own handling is
// lib/editorFrontmatter.ts.
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import MarkdownRenderer from "../components/MarkdownRenderer";
import { makeSiteMarkdown } from "../components/siteFrame/siteMarkdown";

const NOTE = "---\ndescription: x\noutput: note\n---\nBody text\n\n---\n\nAfter the rule\n";

function check(container: HTMLElement) {
  expect(container.querySelector("h1, h2, h3")).toBeNull();
  expect(container.textContent).not.toContain("description");
  expect(container.textContent).toContain("Body text");
  expect(container.querySelectorAll("hr")).toHaveLength(1); // only the real rule
}

describe("frontmatter in rendered notes", () => {
  it("is hidden in the preview renderer", () => {
    check(render(<MarkdownRenderer>{NOTE}</MarkdownRenderer>).container);
  });

  it("is hidden on the published page", () => {
    const body = makeSiteMarkdown([]);
    check(render(<>{body(NOTE)}</>).container);
  });
});
