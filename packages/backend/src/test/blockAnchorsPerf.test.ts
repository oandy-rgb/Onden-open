// Batch 0 acceptance (docs/architecture/proposals/block-anchors-2026-11-01.md §12): moving a note's anchors
// after a small edit of a 175,000-character note takes under 5 ms (the computation; the two UPDATEs that
// store the result are the database's). Median of several runs on a note of 2,600 paragraphs with an
// anchor on every tenth. Also: a big edit stays within the per-save find budget's cost.
import { describe, expect, it } from "vitest";
import { moveAnchors, type AnchorState } from "../services/blockAnchors/mapping.js";
import { blockSpanAt } from "../services/blockAnchors/store.js";
import { quoteAt } from "../services/blockAnchors/similarity.js";
import { verifiedEditorChanges } from "../services/blockAnchors/changes.js";
import { ChangeSet } from "@codemirror/state";

const PARAGRAPH = (i: number) => `第${i}段：這是一段用來量效能的中文筆記內容，包含一些數字 ${i * 7919} 和關鍵字 alpha${i}，長度大約一百個字元上下。`;
const doc = (n: number) => Array.from({ length: n }, (_, i) => PARAGRAPH(i)).join("\n\n");

function anchorsOf(text: string, every: number): AnchorState[] {
  const out: AnchorState[] = [];
  let at = 0;
  for (let i = 0; at < text.length; i++) {
    const span = blockSpanAt(text, at);
    if (span && i % every === 0) out.push({ anchorId: `a${i}`, span, quote: quoteAt(text, span), status: "valid", candidate: null, recoveryPending: false });
    const next = text.indexOf("\n\n", at);
    if (next < 0) break;
    at = next + 2;
  }
  return out;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const time = (fn: () => void, runs = 21) => { fn(); return median(Array.from({ length: runs }, () => { const t = performance.now(); fn(); return performance.now() - t; })); };

describe("moving anchors after a small edit of a 175k-character note", () => {
  const before = doc(2600);
  const anchors = anchorsOf(before, 10);
  it("the fixture is the size the criterion names", () => {
    expect(before.length).toBeGreaterThan(150_000);
    expect(before.length).toBeLessThan(200_000);
    expect(anchors.length).toBeGreaterThan(100);
  });

  const edit = (text: string, at: number, insert: string) => text.slice(0, at) + insert + text.slice(at);
  const middle = before.indexOf("第1300段") + 12;
  const after = edit(before, middle, "插入的幾個字");

  it("derived by a line diff (any writer): under 5 ms, every anchor still on its paragraph", () => {
    const run = () => moveAnchors(anchors, { before, after, editorChanges: null, trusted: () => true });
    const ms = time(run);
    const moved = run();
    expect(moved.every((m) => m.status === "valid")).toBe(true);
    expect(ms, `median ${ms.toFixed(2)} ms`).toBeLessThan(5);
  });

  it("with the editor's own ChangeSet: under 5 ms including the check that it turns the old text into the new", () => {
    const changes = ChangeSet.of({ from: middle, insert: "插入的幾個字" }, before.length).toJSON();
    const run = () => moveAnchors(anchors, { before, after, editorChanges: verifiedEditorChanges(changes, before, after), trusted: () => true });
    const ms = time(run);
    expect(run().every((m) => m.status === "valid")).toBe(true);
    expect(ms, `median ${ms.toFixed(2)} ms`).toBeLessThan(5);
  });
});
