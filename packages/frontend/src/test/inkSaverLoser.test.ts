// 手寫存檔：本機版本在衝突裡輸掉時，它不能只存在畫面上。
// 情境（白板，筆畫可移動）：B 移了筆畫 h 並存檔；A 上一次存檔被伺服器合併過，所以伺服器文字有 B 的 h，但 A 的畫面沒重載
// （own != server）。A 也移了 h 並存檔：用戶端不能先自己合併把 A 的版本吞掉再把結果當成沒有衝突的值送出，
// 要把 A 的原版交給伺服器，由伺服器用 submitted_value_ref 同一套機制留下，之後用現有的還原路徑拿回來。
import { describe, expect, it } from "vitest";
import { decodeInk, mergeInkHeads, revertInkConflicts, type InkDocument, type InkMergeConflict } from "@onden/markdown/ink";
import { InkSaver } from "../lib/ink/surfaceSaver";
import { encodeInk } from "@onden/markdown/ink";
import { mergeDropsSent, type InkSaveBase } from "../lib/data";
import { emptyPageDoc } from "../lib/pdf/pageUnits";

type Send = NonNullable<ConstructorParameters<typeof InkSaver>[1]>;
type Record_ = { incoming: string; overridden: string; submitted: string | null; conflicts: InkMergeConflict[] };

/** The server as services/attributeWrites.ts setNodeAttribute runs it: merge by base, a conflict record that keeps the sent
 *  version when the merge dropped something of it, and the revert that takes the loser back from the record. */
class ServerModel {
  stored = "";
  records: Record_[] = [];
  /** Saves to refuse next (a 4xx: nothing stored). */
  refuse = 0;
  send(): Send {
    return (_node: string, doc: InkSaveBase, base: InkSaveBase | null | undefined) => {
      if (this.refuse > 0) { this.refuse--; return Promise.resolve({ saved: false, stored: null, sent: null }); }
      const incoming = typeof doc === "string" ? doc : encodeInk(doc);
      const baseText = base === undefined || base === null ? "" : typeof base === "string" ? base : encodeInk(base);
      let value = incoming;
      if (base !== undefined && this.stored !== "" && this.stored !== baseText && this.stored !== incoming) {
        const merged = mergeInkHeads(baseText, [this.stored, incoming]);
        value = merged.value;
        if (merged.conflicts.length > 0) {
          this.records.push({ incoming: value, overridden: this.stored, submitted: mergeDropsSent(merged, incoming) ? incoming : null, conflicts: merged.conflicts });
        }
      }
      this.stored = value;
      return Promise.resolve({ saved: true, stored: value, sent: incoming });
    };
  }
  /** The existing restore path (services/attributeWrites.ts revertAttributeConflict) for one record. */
  revert(record: Record_): string {
    return revertInkConflicts(record.incoming, record.submitted === null ? [record.overridden] : [record.overridden, record.submitted], record.conflicts);
  }
}

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const withStroke = (doc: InkDocument, id: string, x: number): InkDocument => ({
  ...doc, strokes: [...doc.strokes.filter((s) => s.id !== id), { id, points: [[x, 1], [x + 1, 2], [x + 2, 3]], color: "#000000", size: 2, toolId: "pen" }],
});
const xOf = (text: string, id: string): number | undefined => {
  const decoded = decodeInk(text);
  return decoded.kind === "page" ? decoded.doc.strokes.find((s) => s.id === id)?.points[0]?.[0] : undefined;
};

describe("InkSaver：本機版本在衝突裡輸掉", () => {
  // 固定順序看文字：A 多畫的那一筆叫 "a" 時 B 的版本排後面（A 輸），叫 "k" 時 A 的排後面（A 贏）。兩個方向，另一版都要拿得回來。
  it.each([["a", "輸", "loses"], ["k", "贏", "wins"]] as const)("A 多畫 %s（衝突 A %s）：兩個版本都還找得到", async (extra, _label, outcome) => {
    const [bX, aX] = [10, 20];
    const server = new ServerModel();
    const saverA = new InkSaver(undefined, server.send());
    const saverB = new InkSaver(undefined, server.send());
    const base = withStroke(withStroke(emptyPageDoc(), "h", 0), "g", 50);
    const baseText = encodeInk(base);
    server.stored = baseText;
    saverA.rebase("n", baseText);
    saverB.rebase("n", baseText);

    // B moves h and saves.
    saverB.save("n", withStroke(base, "h", bX)); await settle();
    // A draws something else and saves: the server merges it with B's h, so A's surface (own) differs from the server's text.
    const aDrawn = withStroke(base, extra, 70);
    saverA.save("n", aDrawn); await settle();
    expect(xOf(server.stored, "h")).toBe(bX);
    // A moves h and saves. Its surface still shows A's h.
    const aMoved = withStroke(aDrawn, "h", aX);
    saverA.save("n", aMoved); await settle();

    const aText = encodeInk(aMoved);
    const kept = xOf(server.stored, "h");
    const record = server.records.at(-1);
    // Each row says which way the fixed order goes, so a fixture change that flips it fails here instead of passing the other branch.
    if (outcome === "loses") {
      expect(kept, "B's h is kept").toBe(bX);
      expect(record?.submitted, "A's original is kept with the record").toBe(aText);
      expect(xOf(server.revert(record!), "h"), "Revert gives A's h back").toBe(aX);
    } else {
      expect(kept, "A's h is kept").toBe(aX);
      // B's version is B's own earlier save: in history, nothing of A's to keep in a record.
      expect(server.records.some((r) => r.submitted === aText)).toBe(false);
    }
    expect(xOf(server.stored, extra)).toBe(70);
  });
});

// PR #1783 round 4 (after #1896): a refused save's change is replayed onto the server's text before the next save. When
// that replay leaves out this surface's version of a stroke another device moved too, the version must not exist only on
// screen: the step is checked like any merge here, and the surface's drawing goes to the server to merge and keep.
describe("InkSaver：被拒的改動重播時，本機版本在衝突裡輸掉", () => {
  it.each([["a", "loses"], ["k", "wins"]] as const)("A 多畫 %s：A 移 h 被拒、B 移 h、A 再存——A 的 h 找得回來（A %s）", async (extra, outcome) => {
    const [bX, aX] = [10, 20];
    const server = new ServerModel();
    const saverA = new InkSaver(undefined, server.send());
    const saverB = new InkSaver(undefined, server.send());
    const base = withStroke(withStroke(emptyPageDoc(), "h", 0), "g", 50);
    const baseText = encodeInk(base);
    server.stored = baseText;
    saverA.rebase("n", baseText);
    saverB.rebase("n", baseText);

    // B moves h and saves.
    saverB.save("n", withStroke(base, "h", bX)); await settle();
    // A draws `extra` and saves: accepted, the server merges in B's h, so A's idea of the server's text holds B's h.
    const aDrawn = withStroke(base, extra, 70);
    saverA.save("n", aDrawn); await settle();
    expect(xOf(server.stored, "h")).toBe(bX);
    // A moves h; that save is refused, so the move waits to be replayed.
    const aMoved = withStroke(aDrawn, "h", aX);
    server.refuse = 1;
    saverA.save("n", aMoved); await settle();
    // A saves again (a later stroke): the refused move is replayed onto the server's text, which has B's h.
    const aLater = withStroke(aMoved, "z", 90);
    saverA.save("n", aLater); await settle();

    const kept = xOf(server.stored, "h");
    expect(xOf(server.stored, extra), "A's other strokes are stored").toBe(70);
    expect(xOf(server.stored, "z")).toBe(90);
    if (outcome === "loses") {
      expect(kept, "B's h is kept").toBe(bX);
      const record = server.records.at(-1);
      expect(record?.submitted, "A's drawing is kept with the record").toBe(encodeInk(aLater));
      expect(xOf(server.revert(record!), "h"), "Revert gives A's h back").toBe(aX);
    } else {
      expect(kept, "A's h is kept").toBe(aX);
    }
  });
});

