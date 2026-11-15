// U+0000 can't be stored by Postgres: it is refused at the edge as a 400 (and
// by the size check every import path shares), not left to fail as a 500.
import { describe, it, expect } from "vitest";
import { DraftNode } from "@onden/contract";
import { newNoteExtrasSchema } from "../utils.js";
import { assertNoteSize, NoteSizeError } from "../services/noteSize.js";
import { noteSizeProblem } from "@onden/markdown";

describe("NUL in note text", () => {
  it("DraftNode refuses it in the title and the body", () => {
    expect(DraftNode.safeParse({ title: "ok", markdown: "fine" }).success).toBe(true);
    expect(DraftNode.safeParse({ title: "a\u0000b" }).success).toBe(false);
    expect(DraftNode.safeParse({ title: "ok", markdown: "a\u0000b" }).success).toBe(false);
  });
  it("initial attributes refuse it in key and value", () => {
    const attr = (key: string, value: string) => newNoteExtrasSchema.safeParse({ attributes: [{ key, value }] }).success;
    expect(attr("k", "v")).toBe(true);
    expect(attr("k", "v\u0000")).toBe(false);
    expect(attr("k\u0000", "v")).toBe(false);
  });
  it("the shared size check names it, so importers skip the file with a reason", () => {
    expect(noteSizeProblem({ markdown: "a\u0000" })).toBe("contains_nul");
    expect(noteSizeProblem({ title: "a\u0000" })).toBe("contains_nul");
    expect(() => assertNoteSize({ title: "ok", markdown: "x\u0000" })).toThrow(NoteSizeError);
    expect(noteSizeProblem({ title: "ok", markdown: "x" })).toBeNull();
  });
});
