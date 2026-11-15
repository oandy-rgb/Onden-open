// Unit tests for extractFrontmatterAttributes — W2 P5 YAML subset parser.

import { describe, it, expect } from "vitest";
import { extractFrontmatterAttributes } from "../utils.js";

describe("extractFrontmatterAttributes", () => {
  it("returns null for markdown without frontmatter", () => {
    expect(extractFrontmatterAttributes("Just a body, no fence.\n")).toBeNull();
    expect(extractFrontmatterAttributes("")).toBeNull();
  });

  it("returns {} for an empty frontmatter fence", () => {
    expect(extractFrontmatterAttributes("---\n---\nbody\n")).toEqual({});
  });

  it("extracts simple scalar key: value pairs", () => {
    const md = [
      "---",
      "title: My Note",
      "status: doing",
      "---",
      "body content",
    ].join("\n");
    expect(extractFrontmatterAttributes(md)).toEqual({
      title: "My Note",
      status: "doing",
    });
  });

  it("strips surrounding double quotes from values", () => {
    const md = `---\ntitle: "Quoted Title"\n---\nbody`;
    expect(extractFrontmatterAttributes(md)).toEqual({ title: "Quoted Title" });
  });

  it("strips surrounding single quotes from values", () => {
    const md = `---\ntitle: 'Single Quoted'\n---\nbody`;
    expect(extractFrontmatterAttributes(md)).toEqual({ title: "Single Quoted" });
  });

  it("handles inline array form `[a, b, c]`", () => {
    const md = `---\ntags: [recipe, cooking, family]\n---\nbody`;
    expect(extractFrontmatterAttributes(md)).toEqual({
      tags: '["recipe","cooking","family"]',
    });
  });

  it("handles block-list form (key followed by indented `- item` lines)", () => {
    const md = [
      "---",
      "tags:",
      "  - recipe",
      "  - cooking",
      "---",
      "body",
    ].join("\n");
    expect(extractFrontmatterAttributes(md)).toEqual({
      tags: '["recipe","cooking"]',
    });
  });

  it("strips quotes inside block-list items", () => {
    const md = [
      "---",
      "tags:",
      "  - 'quoted item'",
      `  - "double quoted"`,
      "  - unquoted",
      "---",
    ].join("\n");
    expect(extractFrontmatterAttributes(md)).toEqual({
      tags: '["quoted item","double quoted","unquoted"]',
    });
  });

  it("ignores comment lines starting with #", () => {
    const md = [
      "---",
      "# this is a comment",
      "title: real",
      "---",
    ].join("\n");
    expect(extractFrontmatterAttributes(md)).toEqual({ title: "real" });
  });

  it("ignores frontmatter that is not at the top of the document", () => {
    const md = "Some text first.\n---\ntitle: not extracted\n---\n";
    // The opening fence isn't at position 0, so our regex requires
    // `^---\n` and won't match.
    expect(extractFrontmatterAttributes(md)).toBeNull();
  });

  it("requires a closing fence — unfinished YAML returns null", () => {
    const md = "---\ntitle: incomplete\n";
    expect(extractFrontmatterAttributes(md)).toBeNull();
  });

  it("handles \\r\\n line endings (CRLF) on the fence", () => {
    const md = "---\r\ntitle: Win\r\n---\r\nbody\r\n";
    expect(extractFrontmatterAttributes(md)).toEqual({ title: "Win" });
  });
});
