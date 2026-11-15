import { describe, expect, it } from "vitest";
import { fieldList, fieldValue, frontmatterEndLine, frontmatterLength, parseFrontmatter, readFrontmatter, stripFrontmatter, stripSettingsFrontmatter } from "./frontmatter.js";

// One fence rule for every reader (depth audit D17): the closing `---` is a
// line of its own, so rendering hides exactly the block the indexer reads.
describe("frontmatter fences", () => {
  it("a --- inside a value does not close the block", () => {
    const note = "---\ntitle: a---b\nstatus: draft\n---\nBody";
    expect(stripFrontmatter(note)).toBe("Body");
    expect(parseFrontmatter(note)).toEqual({ title: "a---b", status: "draft" });
  });

  it("Windows line endings and a block at the very end", () => {
    expect(stripFrontmatter("---\r\ntitle: x\r\n---\r\nBody")).toBe("Body");
    expect(frontmatterLength("---\ntitle: x\n---")).toBe(16);
  });

  it("text without a block is left alone", () => {
    expect(stripFrontmatter("Intro\n---\nmore")).toBe("Intro\n---\nmore");
    expect(frontmatterLength("Intro")).toBe(0);
    expect(readFrontmatter("--- \nnot: closed")).toBeNull();
  });

  it("parseFrontmatter reads quoted values and lists through the codec", () => {
    expect(parseFrontmatter('---\nDescription: "Hi: there"\ntags: [a, b]\n---\n')).toEqual({ description: "Hi: there", tags: "a, b" });
  });

  it("a closing fence with text after it is not a fence; a leading rule pair hides what is between, as before", () => {
    expect(stripFrontmatter("---\ntitle: x\n---text\nbody")).toBe("---\ntitle: x\n---text\nbody");
    expect(stripFrontmatter("---\n\nSection\n\n---\n\nEnd")).toBe("\nEnd");
  });
});

describe("frontmatterEndLine", () => {
  const at = (text: string) => { const lines = text.split("\n"); return frontmatterEndLine(lines.length, (n) => lines[n - 1]!); };
  it("is the closing fence's line, found as readFrontmatter finds it", () => {
    expect(at("---\na: 1\n---\nbody")).toBe(3);
    expect(at("---\n---")).toBe(2);
  });
  it("is null for a lone rule with no closing fence (a rule, not frontmatter)", () => {
    expect(at("---\nno closing fence\n![x](a.png)")).toBeNull();
    expect(at("text\n---\n")).toBeNull();
    expect(at("---")).toBeNull();
  });
});

describe("a tag and a property with the same name stay separate", () => {
  it("`tags: [status]` and `status: doing` read back as a tag and a property", () => {
    const entries = readFrontmatter("---\ntags: [status, project]\nstatus: doing\nproject: onden\n---\nBody")!.entries;
    expect(fieldList(entries, "tags")).toEqual(["status", "project"]);
    expect(fieldValue(entries, "status")).toBe("doing");
    expect(fieldValue(entries, "project")).toBe("onden");
  });
});

describe("empty block and settings-only strip", () => {
  it("`---` / `---` is an empty block; what follows is the body", () => {
    expect(readFrontmatter("---\n---\n\nA\n\n---\n\nB")).toEqual({ entries: [], body: "\nA\n\n---\n\nB" });
  });
  it("stripSettingsFrontmatter keeps a leading block of plain text", () => {
    expect(stripSettingsFrontmatter("---\n\nA\n\n---\n\nB")).toBe("---\n\nA\n\n---\n\nB");
    expect(stripSettingsFrontmatter("---\ntitle: T\n---\nB")).toBe("B");
    expect(stripSettingsFrontmatter("---\n---\nB")).toBe("B");
    expect(stripSettingsFrontmatter("no block")).toBe("no block");
  });
});

describe("the strict settings reading and the empty-block offset", () => {
  it("a leading block with a heading, a paragraph or a list is not settings, even with a `Key: value` line", () => {
    for (const text of ["---\n# T\n\nAgenda: three\n---\n# P2", "---\nAgenda: x\n\nSome text\n---\nB", "---\n- a\n- b\n---\nB"]) {
      expect(stripSettingsFrontmatter(text)).toBe(text);
    }
    expect(stripSettingsFrontmatter("---\naliases:\n- x\ntitle: T\n\n---\nB")).toBe("B");
  });
  it("an Obsidian-style settings block (spaced or dotted keys, a comment line, lists) is still stripped", () => {
    expect(stripSettingsFrontmatter("---\ndate created: 2026-01-01\n# a note\nmy.key: v\ntags:\n  - a\n- b\n---\nB")).toBe("B");
    expect(stripSettingsFrontmatter('---\n"Due Date": x\n---\nB')).toBe("B");
  });
  it("a `#` line is a comment without a blank line in the block, a heading with one", () => {
    expect(stripSettingsFrontmatter("---\n# T\nAgenda: x\n---\nB")).toBe("B"); // known limit: valid settings
    expect(stripSettingsFrontmatter("---\n# T\n\nAgenda: x\n---\nB")).toBe("---\n# T\n\nAgenda: x\n---\nB");
    expect(stripSettingsFrontmatter("---\nAgenda:\n- a\n- b\n---\n# P2")).toBe("# P2"); // known limit: valid settings
  });
  it("frontmatterLength of a note that opens `---` / `---` is the empty block only", () => {
    expect(frontmatterLength("---\n---\n\nA\n\n---\n\nB")).toBe(8);
    expect(frontmatterLength("---\n---")).toBe(7);
  });
});
