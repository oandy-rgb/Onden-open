import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { applyPatch, hashText, isTextPatch, makePatch, TextPatchError } from "./textPatch.js";

describe("hashText", () => {
  it("is the sha256 hex of the UTF-8 bytes, as services/blobs.ts stores it", () => {
    for (const text of ["", "abc", "中文 😀 é", "x".repeat(200), "line\n".repeat(5000)]) {
      expect(hashText(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });
});

describe("makePatch / applyPatch", () => {
  it("sends only what changed", () => {
    const base = "# Title\n\nfirst\n\nsecond\n";
    const patch = makePatch(base, "# Title\n\nfirst\n\nsecond!\n");
    expect(patch.hunks).toEqual([{ at: base.length - 1, del: 0, ins: "!" }]);
    expect(applyPatch(base, patch)).toBe("# Title\n\nfirst\n\nsecond!\n");
  });

  it("equal texts have no hunks", () => {
    expect(makePatch("same", "same").hunks).toEqual([]);
    expect(makePatch("", "").hunks).toEqual([]);
  });

  it("does not split a surrogate pair", () => {
    const patch = makePatch("a😀b", "a😁b");
    expect(patch.hunks).toEqual([{ at: 1, del: 2, ins: "😁" }]);
  });

  it("splits far-apart edits in a big text into separate hunks", () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i} of the note`);
    const base = lines.join("\n");
    const edited = [...lines]; edited[10] = "changed A"; edited[3900] = "changed B";
    const next = edited.join("\n");
    const patch = makePatch(base, next);
    expect(patch.hunks.length).toBe(2);
    expect(JSON.stringify(patch).length).toBeLessThan(500);
    expect(applyPatch(base, patch)).toBe(next);
  });

  it("refuses a patch made from other text", () => {
    const patch = makePatch("one", "two");
    expect(() => applyPatch("uno", patch)).toThrow(TextPatchError);
    expect(() => applyPatch("uno", patch)).toThrow("base_mismatch");
  });

  it("refuses hunks that reach outside the text or overlap", () => {
    const base = "abcdef";
    const hash = hashText(base);
    expect(() => applyPatch(base, { base_hash: hash, hunks: [{ at: 5, del: 4, ins: "" }] })).toThrow("out_of_range");
    expect(() => applyPatch(base, { base_hash: hash, hunks: [{ at: 3, del: 1, ins: "" }, { at: 2, del: 0, ins: "x" }] })).toThrow("out_of_range");
    expect(() => applyPatch(base, { base_hash: hash, hunks: [{ at: -1, del: 0, ins: "" }] } as never)).toThrow("malformed");
  });

  it("recognises the shape of a patch", () => {
    expect(isTextPatch(makePatch("a", "b"))).toBe(true);
    expect(isTextPatch({ base_hash: "x", hunks: [] })).toBe(false);
    expect(isTextPatch(null)).toBe(false);
  });
});

describe("makePatch on one-line JSON (a drawing)", () => {
  // Fixed counterexample of the PDF save: a stroke is added to page 1 and again at the end of `annotations`, with the whole of
  // the text between them unchanged. Before the object split, the one hunk was everything from page 1 to the end.
  const stroke = (id: number) => `{"id":"s${id}","points":[[1.234567890123,2.345678901234,0.5],[3.1,4.1,0.5]],"size":2.5}`;
  const strokes = (from: number, n: number) => Array.from({ length: n }, (_, i) => stroke(from + i)).join(",");
  const env = (page1: string, page2: string, notes: string) => `{"version":1,"pages":{"1":[${page1}],"2":[${page2}]},"annotations":[${notes}],"unitsFrom":"abc"}`;

  it("a stroke added in two far-apart places is two small hunks, not the text between them", () => {
    const base = env(strokes(0, 40), strokes(100, 200), strokes(300, 40));
    const next = env(strokes(0, 40) + "," + stroke(900), strokes(100, 200), strokes(300, 40) + "," + stroke(901));
    const patch = makePatch(base, next);
    expect(applyPatch(base, patch)).toBe(next);
    expect(patch.hunks.length).toBeGreaterThanOrEqual(2);
    expect(patch.hunks.reduce((sum, h) => sum + h.ins.length, 0)).toBeLessThan(2 * stroke(900).length + 100);
  });
});
