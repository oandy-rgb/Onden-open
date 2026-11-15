import { describe, expect, it } from "vitest";
import { bodyAfterTitle, noteSummary } from "./summary.js";

// A note as Obsidian writes it: frontmatter, then the title as an H1 (D37).
const OBSIDIAN = [
  "---",
  "status: reading",
  "tags: [book]",
  "---",
  "# Deep Work",
  "",
  "Focus is a **skill**, see [[Cal Newport|Newport]].",
  "",
  "## Notes",
  "- rule one",
].join("\n");

describe("noteSummary", () => {
  it("never shows the frontmatter fence or its keys", () => {
    const out = noteSummary(OBSIDIAN, { title: "Deep Work", maxLen: 280 });
    expect(out).toBe("Focus is a skill, see Newport. rule one");
    expect(out).not.toContain("---");
    expect(out).not.toContain("status");
  });

  it("a frontmatter description: is the summary", () => {
    const note = "---\nstatus: reading\ndescription: \"A book about [[focus]].\"\n---\n# Deep Work\n\nBody text.";
    expect(noteSummary(note, { title: "Deep Work", maxLen: 280 })).toBe("A book about focus.");
  });

  it("the description is cut like the body", () => {
    const note = `---\ndescription: ${"word ".repeat(50).trim()}\n---\nBody`;
    const out = noteSummary(note, { maxLen: 40 });
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(41);
  });

  it("skips the first line only when it repeats the title", () => {
    expect(noteSummary("# Deep Work\n\nBody.", { title: "Deep Work", maxLen: 280 })).toBe("Body.");
    expect(noteSummary("Deep Work\nBody.", { title: "Deep Work", maxLen: 280 })).toBe("Body.");
    // A first line that is not the title is prose (no heading marker).
    expect(noteSummary("Intro line\nBody.", { title: "Deep Work", maxLen: 280 })).toBe("Intro line Body.");
  });

  it("drops headings, tables, rules, code and list markers", () => {
    const md = "# H\n\n| a | b |\n|---|---|\n\n***\n\n```js\ncode();\n```\n\n1. first ^abc\n- [x] done\n> quoted\n\n![img](/a.png) [link](https://x)";
    expect(noteSummary(md, { maxLen: 280 })).toBe("first done quoted link");
  });

  it("drops a handwriting page's image and address lines, and only those", () => {
    expect(noteSummary("words\n\n![][ink-page-1]\n\n[ink-page-1]: /api/media/a.svg#ink-page-1", { maxLen: 80 })).toBe("words");
    expect(noteSummary("![][ink-page-1]\n\n[ink-page-1]: /api/media/a.svg#ink-page-1", { maxLen: 80 })).toBe("");
    expect(noteSummary("![x][p1]", { maxLen: 80 })).toBe("![x][p1]");
  });

  it("keeps hashtags and a # that is not a heading", () => {
    expect(noteSummary("#garden notes\n\nText", { maxLen: 280 })).toBe("#garden notes Text");
  });

  it("cuts on a word boundary with an ellipsis", () => {
    const long = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
    const out = noteSummary(long, { maxLen: 100 });
    expect(out.length).toBeLessThanOrEqual(101);
    expect(out.slice(0, -1).trim().split(" ").pop()).toMatch(/^word\d+$/);
  });

  it("never cuts a surrogate pair in half", () => {
    const out = noteSummary("😀".repeat(100), { maxLen: 11 });
    expect(out).toBe("😀".repeat(5) + "…");
  });

  it("an empty or furniture-only note has no summary", () => {
    expect(noteSummary("", { maxLen: 280 })).toBe("");
    expect(noteSummary("---\nstatus: x\n---\n# Title\n", { title: "Title", maxLen: 280 })).toBe("");
  });

  it("stays fast on a pathological body", () => {
    const body = "```".repeat(30_000) + "[".repeat(50_000) + "![x](".repeat(20_000) + ` ^a${" ".repeat(50_000)}x`;
    const started = performance.now();
    noteSummary(body, { maxLen: 280 });
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("bodyAfterTitle", () => {
  it("removes the frontmatter and the title H1 (Obsidian note)", () => {
    expect(bodyAfterTitle(OBSIDIAN, "Deep Work")).toBe(
      "\nFocus is a **skill**, see [[Cal Newport|Newport]].\n\n## Notes\n- rule one");
  });

  it("keeps a first line that is not the title", () => {
    expect(bodyAfterTitle("---\na: 1\n---\n# Other\nText", "Deep Work")).toBe("# Other\nText");
  });

  it("an empty title removes nothing but the frontmatter", () => {
    expect(bodyAfterTitle("---\na: 1\n---\n#\nText", "")).toBe("#\nText");
  });
});
