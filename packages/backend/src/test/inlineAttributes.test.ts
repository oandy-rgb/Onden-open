// Unit tests for extractAttributes — covers both Onden's `#key=value` form
// and the Obsidian/Dataview `key:: value` forms added in W2 P3.

import { describe, it, expect } from "vitest";
import { extractAttributes } from "../utils.js";

describe("extractAttributes — #key=value (Onden form)", () => {
  it("extracts hashtag-style attrs", () => {
    expect(extractAttributes("Some note #status=done #priority=high")).toEqual({
      status: "done",
      priority: "high",
    });
  });

  it("returns empty for empty markdown", () => {
    expect(extractAttributes("")).toEqual({});
  });
});

describe("extractAttributes — key:: value (Obsidian/Dataview form)", () => {
  it("extracts standalone line form", () => {
    const md = [
      "status:: doing",
      "priority:: high",
      "",
      "Some paragraph content.",
    ].join("\n");
    expect(extractAttributes(md)).toEqual({
      status: "doing",
      priority: "high",
    });
  });

  it("extracts bracketed inline form within a paragraph", () => {
    const md = "Reading [author:: Roy Fielding] on [year:: 2000] this week.";
    expect(extractAttributes(md)).toEqual({
      author: "Roy Fielding",
      year: "2000",
    });
  });

  it("supports both forms in the same document", () => {
    const md = [
      "status:: doing",
      "Some text with #priority=high",
      "Reading [author:: Someone] this week.",
    ].join("\n");
    expect(extractAttributes(md)).toEqual({
      status: "doing",
      priority: "high",
      author: "Someone",
    });
  });

  it("last occurrence wins when the same key appears twice (matches #key=value semantics)", () => {
    const md = "status:: first\nstatus:: second\n";
    expect(extractAttributes(md)).toEqual({ status: "second" });
  });

  it("ignores key:: value INSIDE fenced code blocks", () => {
    const md = [
      "status:: real",
      "",
      "```",
      "status:: in-code",
      "priority:: also-in-code",
      "```",
      "",
      "more text",
    ].join("\n");
    expect(extractAttributes(md)).toEqual({ status: "real" });
  });

  it("requires whitespace after :: (not just punctuation)", () => {
    // "::value" with no space → not extracted (avoid matching :: as part of paths)
    expect(extractAttributes("foo::value-no-space")).toEqual({});
  });

  it("standalone form requires line-start anchor", () => {
    // `text status:: value` — the key isn't at line start so it shouldn't match.
    // Only the bracketed form supports mid-line keys.
    const md = "this is text status:: value";
    expect(extractAttributes(md)).toEqual({});
  });

  it("bracketed form requires both bracket boundaries", () => {
    // `[status:: value` — missing closing bracket, not extracted
    expect(extractAttributes("[status:: value")).toEqual({});
  });

  it("trims surrounding whitespace from the value", () => {
    expect(extractAttributes("key::   spaced value   ")).toEqual({
      key: "spaced value",
    });
  });

  it("ignores key:: value inside ~~~ fences too (the renderer's fence rule)", () => {
    const md = ["status:: real", "~~~", "status:: in-tilde", "[k:: v] #p=q", "~~~", "after:: yes"].join("\n");
    expect(extractAttributes(md)).toEqual({ status: "real", after: "yes" });
  });

  it("a ``` line inside a ~~~ block does not close it", () => {
    const md = ["~~~", "```", "leak:: no", "~~~", "ok:: yes"].join("\n");
    expect(extractAttributes(md)).toEqual({ ok: "yes" });
  });

  it("indexes an attribute line joined to prose (the line the renderer hides)", () => {
    const md = "Intro.\n\ndue:: 2026-10-20\nCall the lawyer about the contract.\n\nEnd.";
    expect(extractAttributes(md)).toEqual({ due: "2026-10-20" });
  });

  it("indexes an attribute line in the middle of a paragraph", () => {
    expect(extractAttributes("First line.\nstatus:: doing\nLast line.")).toEqual({ status: "doing" });
  });
});
