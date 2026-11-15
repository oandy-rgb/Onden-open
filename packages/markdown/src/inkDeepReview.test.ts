import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { decodeInk, isInkReadOnly, encodeInk, mergeInk, type InkDocument, type InkStroke } from "./ink.js";

// 深入審查 2026-11-11（手寫）：docs/archive/deep-review-ink-2026-11-11.md。
// 這裡的 `it.fails` 釘住已重現的問題：測試名稱寫「應該怎樣」，修好後把 `.fails` 拿掉。

const stroke = (id: string, n = 3): InkStroke => ({
  id, points: Array.from({ length: n }, (_, i) => [i * 10, i * 5] as [number, number]), color: "#000", size: 2, toolId: "pen",
});
const page = (strokes: InkStroke[], erased: InkDocument["erased"] = {}, extra: Partial<InkDocument> = {}): InkDocument =>
  ({ version: 1, strokes, erased, page: { width: 1000 }, ...extra });
const enc = (d: InkDocument) => encodeInk(d);
const idsOf = (raw: string): string[] => {
  const d = decodeInk(raw);
  return d.kind === "page" ? d.doc.strokes.map((s) => s.id) : [];
};

describe("ink-1：一次沒存成的存檔不能讓後面的存檔把它的筆畫刪掉", () => {
  // 畫面把「上一次送出的內容」當成下一次存檔的 base（OverviewEditor saveSurfaceInk、CanvasInkLayer persist），
  // 不管上一次有沒有被伺服器收下。V1 被拒絕（或被丟棄）後，V2 帶著 base=V1 送出：
  // 伺服器看到「base 有、現存沒有、V2 沒動」，判成「另一邊刪掉了」，V1 獨有的筆畫就不見了。
  it.fails("V1 沒被收下時，V2（base=V1）存下來的內容仍含 V1 的筆畫", () => {
    const B0 = page([stroke("a")]);
    const V1 = page([stroke("a"), stroke("b")]);
    const V2 = page([stroke("a"), stroke("b"), stroke("c")]);
    // 伺服器仍是 B0（V1 被拒）；V2 的 base 是 V1。
    const result = mergeInk(enc(V1), enc(B0), enc(V2));
    expect(idsOf(result.value).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("ink-2：讀進來再存回去不可少東西", () => {
  it("較新版本的 morePages（version 2）讀進來再存回去仍在", () => {
    const raw = JSON.stringify({
      ...page([stroke("a")]),
      morePages: { version: 2, pages: { p2: { key: "p2", background: { kind: "blank" }, size: { width: 1000, height: 1500 }, doc: page([stroke("x")]) } } },
    });
    const d = decodeInk(raw);
    expect(d.kind).toBe("page");
    if (d.kind !== "page") return;
    expect(JSON.parse(encodeInk(d.doc)).morePages).toEqual(JSON.parse(raw).morePages);
    expect(isInkReadOnly(d.doc)).toBe(true);
  });
});

describe("ink-3（性質）：兩台裝置各自從同一個 base 畫／擦，合併後沒有人畫的筆畫消失", () => {
  const ids = fc.uniqueArray(fc.stringMatching(/^[a-f0-9]{4}$/), { minLength: 0, maxLength: 6 });
  it("合併保留兩邊新增的筆畫，且兩個順序收斂到同一組筆畫", () => {
    fc.assert(fc.property(ids, ids, ids, (baseIds, aIds, bIds) => {
      const taken = new Set(baseIds);
      const aNew = aIds.filter((i) => !taken.has(i)).map((i) => `A${i}`);
      const bNew = bIds.filter((i) => !taken.has(i)).map((i) => `B${i}`);
      const base = page(baseIds.map((i) => stroke(i)));
      const a = page([...base.strokes, ...aNew.map((i) => stroke(i))]);
      const b = page([...base.strokes, ...bNew.map((i) => stroke(i))]);
      const aFirst = mergeInk(enc(base), enc(a), enc(b)).value; // 先存 A 再存 B
      const bFirst = mergeInk(enc(base), enc(b), enc(a)).value;
      const want = [...baseIds, ...aNew, ...bNew].sort();
      expect(idsOf(aFirst).sort()).toEqual(want);
      expect(idsOf(bFirst).sort()).toEqual(want);
    }), { numRuns: 300 });
  });
});
