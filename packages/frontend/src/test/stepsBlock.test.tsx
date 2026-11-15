// The ```steps figure on each surface: the app draws a player; the published
// profile draws every step as a list (the site's script makes it a player);
// a canvas card keeps it as code; the inline HTML of a step is still sanitized.
import { describe, expect, it, vi, beforeAll } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { loadAllEnhancers } from "@onden/markdown";
import MarkdownRenderer from "../components/MarkdownRenderer";
import { makeSiteMarkdown } from "../components/siteFrame/siteMarkdown";
import { usesStepsBlocks } from "../components/siteFrame/siteModel";

vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  apiFetch: vi.fn(async () => ({ rows: [], total: 0, next: null })),
}));

beforeAll(async () => { await loadAllEnhancers(); });

const NOTE = [
  "Before.",
  "",
  "````steps",
  "How a sum grows.",
  "",
  "## Start",
  "```js",
  "let total = 0;",
  "```",
  "",
  "## Add",
  "```js",
  "let total = 0;",
  "total += 1;",
  "```",
  "",
  "<script>alert(1)</script>",
  "",
  "## Done",
  "- all **added**",
  "````",
  "",
  "After.",
].join("\n");

describe("in the app", () => {
  it("draws a figure whose player is wired once its chunk loads", async () => {
    const { container } = render(<MarkdownRenderer>{NOTE}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector(".md-steps.is-player")).not.toBeNull());
    expect(container.querySelectorAll(".md-step")).toHaveLength(3);
    expect(container.querySelector(".md-steps-intro")!.textContent).toContain("How a sum grows.");
    expect(container.querySelector(".md-steps-status")!.textContent).toBe("Step 1 of 3 · Start");
    expect(container.querySelector(".md-steps")!.closest(".md-codeblock, pre")).toBeNull(); // not framed as one code block
    expect(container.querySelector(".md-step.is-active")!.textContent).toContain("let total = 0;");
  });

  it("each step is drawn by the page's own Markdown (code coloured, lists)", async () => {
    const { container } = render(<MarkdownRenderer>{NOTE}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector(".md-step pre code")).not.toBeNull());
    expect(container.querySelectorAll(".md-step")[2]!.querySelector("li strong")!.textContent).toBe("added");
  });

  it("stays code where steps are turned off (a canvas card)", () => {
    const { container } = render(<MarkdownRenderer steps={false}>{NOTE}</MarkdownRenderer>);
    expect(container.querySelector(".md-steps")).toBeNull();
    expect(container.querySelector("pre code.language-steps")).not.toBeNull();
  });

  it("a figure inside a step is not another figure", async () => {
    const inner = "`````steps\n## A\n````steps\n## inner\nx\n````\n`````";
    const { container } = render(<MarkdownRenderer>{inner}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector(".md-steps")).not.toBeNull());
    expect(container.querySelectorAll(".md-steps")).toHaveLength(1);
  });

  it("a block with no step is its intro alone", async () => {
    const { container } = render(<MarkdownRenderer>{"```steps\njust words\n```"}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector(".md-steps-intro")).not.toBeNull());
    expect(container.querySelector(".md-step")).toBeNull();
    expect(container.querySelector(".md-steps-bar")).toBeNull();
  });
});

describe("on the published site", () => {
  let html = "";
  beforeAll(() => { html = renderToString(makeSiteMarkdown([], { locale: "zh-TW" })(NOTE)); });

  it("lists every step, in order, with no script needed", () => {
    const titles = [...html.matchAll(/<h3 class="md-step-title">([^<]*)<\/h3>/g)].map((m) => m[1]);
    expect(titles).toEqual(["Start", "Add", "Done"]);
    expect(html).toContain("How a sum grows.");
    expect(html.replace(/<[^>]+>/g, "")).toContain("total += 1;");
  });

  it("marks the figure for the site's script, with the site's words", () => {
    expect(html).toContain('data-steps=""');
    expect(html).toContain('data-l-prev="上一步"');
    expect(html).toContain('data-l-count="第 {n} 步／共 {m} 步"');
  });

  it("keeps inline script out of a step (sanitized like the rest of the page)", () => {
    expect(html).not.toContain("<script");
  });

  it("draws the figure with no copy-button frame", () => {
    expect(html).not.toContain("language-steps");
    expect(html.match(/class="md-codeblock"/g)).toHaveLength(2); // the two code blocks of the steps, each with its own copy button
  });

  it("a site draws the script only when a note has a figure", () => {
    expect(usesStepsBlocks([{ markdown: NOTE }])).toBe(true);
    expect(usesStepsBlocks([{ markdown: "```js\n// steps\n```" }])).toBe(false);
  });
});
