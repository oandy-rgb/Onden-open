// 太大送不出去的手寫存檔改以伺服器現值為基底重做（rebasedPatch.ts）：本機版本在衝突裡會被合併丟掉時也送合併值（業主 2026-11-20、#1783 第 3 輪），
// 不整份覆蓋——整份送出會蓋掉現值、靜靜藏掉另一台的筆。
import { describe, expect, it, vi } from "vitest";
import { encodeInk } from "@onden/markdown/ink";
import { emptyPageDoc } from "../pdf/pageUnits";
import { mergeInk, type InkDocument } from "@onden/markdown/ink";
import { applyPatch, type TextPatch } from "@onden/markdown";

const NODE = "11111111-1111-4111-8111-111111111111";
const stored: { value: string } = { value: "" };
vi.mock("../api", async (importOriginal) => ({ ...(await importOriginal<object>()), api: vi.fn(async () => [{ key: "ink_data", value: stored.value }]) }));
import { rebasedOnStored } from "./rebasedPatch";

const withStroke = (doc: InkDocument, id: string, x: number): InkDocument => ({
  ...doc, strokes: [...doc.strokes.filter((s) => s.id !== id), { id, points: [[x, 1], [x + 1, 2], [x + 2, 3]], color: "#000000", size: 2, toolId: "pen" }],
});
const body = (value: string, base: string) => JSON.stringify({ value, base_value: base, value_type: "text", is_inheritable: false });

describe("rebasedOnStored：衝突裡本機版本會被丟掉", () => {
  const base = withStroke(withStroke(emptyPageDoc(), "h", 0), "g", 50);
  const baseText = encodeInk(base);
  const theirs = encodeInk(withStroke(base, "h", 10));
  // "a" sorts before "h" in the stored text, so the stored head ends up last in the fixed order and keeps its h.
  const mineLoses = encodeInk(withStroke(withStroke(base, "a", 70), "h", 20));
  const mineWins = encodeInk(withStroke(withStroke(base, "k", 70), "h", 20));

  it("輸的一方：照樣送合併值（以現值為基底的 patch），不整份覆蓋", async () => {
    stored.value = theirs;
    const sent = await rebasedOnStored("PUT", `/api/nodes/${NODE}/attributes/ink_data`, body(mineLoses, baseText));
    expect(sent).not.toBeNull();
    const patch = JSON.parse(sent!) as { value_patch: TextPatch };
    expect(applyPatch(theirs, patch.value_patch)).toBe(mergeInk(baseText, theirs, mineLoses).value);
  });
  it("沒被丟掉的一方：照舊以現值為基底送 patch", async () => {
    stored.value = theirs;
    const sent = await rebasedOnStored("PUT", `/api/nodes/${NODE}/attributes/ink_data`, body(mineWins, baseText));
    expect(sent).not.toBeNull();
    expect(JSON.parse(sent!)).toHaveProperty("value_patch");
  });
});
