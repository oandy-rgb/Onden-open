// The exports and the published site write a note's frontmatter as nothing:
// no setext heading from `description: x\n---`, no rule for the fences.
import { describe, expect, it } from "vitest";
import { md2html } from "../modules/website/publishing/htmlUtils.js";

describe("md2html frontmatter", () => {
  it("drops the block, and keeps a later --- rule", () => {
    const html = md2html("---\ndescription: x\noutput: note\n---\nBody text\n\n---\n\nAfter\n");
    expect(html).not.toMatch(/<h[1-6]/);
    expect(html).not.toContain("description");
    expect(html).toContain("Body text");
    expect(html.match(/<hr/g)).toHaveLength(1);
  });
});
