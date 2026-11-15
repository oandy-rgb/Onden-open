import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  INK_PAGE_KEY, decodePageText, emptyPageText, encodePageText, isPageTextReadOnly, mergePageText, pageTextPlain,
  pdfPageKey, revertPageTextConflicts, type PageTextBox, type PageTextDoc,
} from "./pageText.js";
import { PROPS_RUNS, PROPS_SEED } from "./test/helpers/propsConfig.js";

const box = (id: string, over: Partial<PageTextBox> = {}): PageTextBox => ({
  id, x: 10, y: 20, w: 300, text: id, size: 22, color: "#1f1f1f", align: "left", updated_at: "2026-10-28T00:00:00.000Z", ...over,
});
const doc = (pages: Record<string, PageTextBox[]>): string =>
  encodePageText({ v: 1, pages: Object.fromEntries(Object.entries(pages).map(([k, boxes]) => [k, { boxes }])) });
const idsOf = (value: string, key = "pdf:1") => decodePageText(value).pages[key]?.boxes.map((b) => b.id).sort() ?? [];

describe("page_text format", () => {
  it("round-trips, CJK and emoji text included", () => {
    const text = "標題 😀 👩‍👩‍👧\nsecond line \"quoted\" \\ é";
    const value = doc({ [pdfPageKey(3)]: [box("a", { text })], [INK_PAGE_KEY]: [box("b")] });
    expect(encodePageText(decodePageText(value))).toBe(value);
    expect(decodePageText(value).pages["pdf:3"]!.boxes[0]!.text).toBe(text);
  });

  it("reads nothing, garbage and other shapes as no boxes", () => {
    for (const raw of [null, undefined, "", "not json", "[]", "{}", '{"v":1,"pages":[]}']) {
      expect(decodePageText(raw)).toEqual(emptyPageText());
    }
  });

  it("repairs malformed boxes, drops ones without an id and a repeated id", () => {
    const raw = JSON.stringify({ v: 1, pages: { "pdf:1": { boxes: [
      { id: "a", x: "bad", y: NaN, w: -5, text: 7, size: 0, color: "javascript:x", align: "weird" },
      { x: 1 }, { id: "a", text: "second" }, "junk",
    ] } } });
    const boxes = decodePageText(raw).pages["pdf:1"]!.boxes;
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ id: "a", x: 0, y: 0, w: 40, text: "", size: 22, color: "#1f1f1f", align: "left" });
  });

  it("keeps fields it does not know, at every level", () => {
    const raw = JSON.stringify({ v: 1, extra: 1, pages: { "pdf:1": { note: "n", boxes: [{ ...box("a"), rot: 12 }] } } });
    const round = JSON.parse(encodePageText(decodePageText(raw)));
    expect(round.extra).toBe(1);
    expect(round.pages["pdf:1"].note).toBe("n");
    expect(round.pages["pdf:1"].boxes[0].rot).toBe(12);
  });

  it("leaves out pages without boxes", () => {
    expect(JSON.parse(encodePageText({ v: 1, pages: { "pdf:1": { boxes: [] } } })).pages).toEqual({});
  });

  it("a newer version is read-only", () => {
    expect(isPageTextReadOnly('{"v":2,"pages":{}}')).toBe(true);
    expect(isPageTextReadOnly('{"v":1,"pages":{}}')).toBe(false);
    expect(isPageTextReadOnly(null)).toBe(false);
  });

  it("lists the text for search in page order", () => {
    const value = doc({ "pdf:10": [box("c", { text: "ten" })], "pdf:2": [box("b", { text: " two " }), box("e", { text: "  " })] });
    expect(pageTextPlain(value)).toBe("two\nten");
  });
});

describe("mergePageText", () => {
  const base = doc({ "pdf:1": [box("a"), box("b")] });

  it("keeps different boxes added on both sides", () => {
    const stored = doc({ "pdf:1": [box("a"), box("b"), box("s")] });
    const incoming = doc({ "pdf:1": [box("a"), box("b"), box("i")] });
    const merged = mergePageText(base, stored, incoming);
    expect(idsOf(merged.value)).toEqual(["a", "b", "i", "s"]);
    expect(merged.conflicts).toEqual([]);
  });

  it("takes the side that changed a box", () => {
    const stored = doc({ "pdf:1": [box("a", { text: "stored" }), box("b")] });
    const incoming = doc({ "pdf:1": [box("a"), box("b", { x: 99 })] });
    const boxes = decodePageText(mergePageText(base, stored, incoming).value).pages["pdf:1"]!.boxes;
    expect(boxes.find((b) => b.id === "a")!.text).toBe("stored");
    expect(boxes.find((b) => b.id === "b")!.x).toBe(99);
  });

  it("both changed one box: incoming wins and the conflict is reported", () => {
    const stored = doc({ "pdf:1": [box("a", { text: "stored" }), box("b")] });
    const incoming = doc({ "pdf:1": [box("a", { text: "incoming" }), box("b")] });
    const merged = mergePageText(base, stored, incoming);
    expect(decodePageText(merged.value).pages["pdf:1"]!.boxes.find((b) => b.id === "a")!.text).toBe("incoming");
    expect(merged.conflicts).toEqual([{ pageKey: "pdf:1", id: "a" }]);
  });

  it("removed on one side, changed on the other: the change stays", () => {
    const stored = doc({ "pdf:1": [box("b")] }); // a removed there
    const incoming = doc({ "pdf:1": [box("a", { text: "edited" }), box("b")] });
    const merged = mergePageText(base, stored, incoming);
    expect(idsOf(merged.value)).toEqual(["a", "b"]);
    expect(merged.conflicts).toEqual([{ pageKey: "pdf:1", id: "a" }]);
    const reverse = mergePageText(base, incoming, stored);
    expect(idsOf(reverse.value)).toEqual(["a", "b"]);
  });

  it("removed on one side, untouched on the other: stays removed", () => {
    const merged = mergePageText(base, base, doc({ "pdf:1": [box("b")] }));
    expect(idsOf(merged.value)).toEqual(["b"]);
    expect(mergePageText(base, doc({ "pdf:1": [box("b")] }), base).conflicts).toEqual([]);
  });

  it("merges pages independently and tolerates an empty or unreadable base", () => {
    const stored = doc({ "pdf:2": [box("s")] });
    const incoming = doc({ "pdf:1": [box("i")] });
    for (const b of [null, "", "garbage"]) {
      const merged = mergePageText(b, stored, incoming);
      expect(idsOf(merged.value, "pdf:1")).toEqual(["i"]);
      expect(idsOf(merged.value, "pdf:2")).toEqual(["s"]);
    }
  });

  it("revert takes back only the conflicting box", () => {
    const stored = doc({ "pdf:1": [box("a", { text: "stored" }), box("b")] });
    const incoming = doc({ "pdf:1": [box("a", { text: "incoming" }), box("b"), box("n")] });
    const merged = mergePageText(base, stored, incoming);
    const reverted = revertPageTextConflicts(merged.value, stored, merged.conflicts);
    const boxes = decodePageText(reverted).pages["pdf:1"]!.boxes;
    expect(boxes.find((b) => b.id === "a")!.text).toBe("stored");
    expect(boxes.map((b) => b.id).sort()).toEqual(["a", "b", "n"]);
  });
});

describe("mergePageText (random edits)", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const edit = fc.record({
    kind: fc.constantFrom("add", "change", "remove"),
    id: fc.constantFrom(...ids),
    text: fc.constantFrom("x", "字 😀", "line\nbreak", ""),
  });
  const apply = (value: string, edits: Array<{ kind: string; id: string; text: string }>): string => {
    const d: PageTextDoc = decodePageText(value);
    const boxes = [...(d.pages["pdf:1"]?.boxes ?? [])];
    for (const e of edits) {
      const at = boxes.findIndex((b) => b.id === e.id);
      if (e.kind === "remove") { if (at >= 0) boxes.splice(at, 1); }
      else if (at >= 0) boxes[at] = { ...boxes[at]!, text: e.text, updated_at: `t${e.text.length}` };
      else boxes.push(box(e.id, { text: e.text }));
    }
    return encodePageText({ v: 1, pages: { "pdf:1": { boxes } } });
  };
  const opts = { seed: PROPS_SEED, numRuns: PROPS_RUNS };
  const base = doc({ "pdf:1": [box("a"), box("b")] });

  it("never loses a box either side kept, never duplicates one", () => {
    fc.assert(fc.property(fc.array(edit, { maxLength: 6 }), fc.array(edit, { maxLength: 6 }), (storedEdits, incomingEdits) => {
      const stored = apply(base, storedEdits);
      const incoming = apply(base, incomingEdits);
      const merged = idsOf(mergePageText(base, stored, incoming).value);
      expect(new Set(merged).size).toBe(merged.length);
      const baseIds = new Set(idsOf(base));
      const s = new Set(idsOf(stored)), i = new Set(idsOf(incoming));
      for (const id of ids) {
        // Added on a side (not in base): present. Kept by both: present.
        if ((s.has(id) && !baseIds.has(id)) || (i.has(id) && !baseIds.has(id)) || (s.has(id) && i.has(id))) {
          expect(merged).toContain(id);
        }
        // Gone from both: gone.
        if (!s.has(id) && !i.has(id)) expect(merged).not.toContain(id);
      }
    }), opts);
  });

  it("merging a save into an unchanged store is the save", () => {
    fc.assert(fc.property(fc.array(edit, { maxLength: 6 }), (edits) => {
      const incoming = apply(base, edits);
      expect(mergePageText(base, base, incoming).value).toBe(incoming);
      expect(mergePageText(base, incoming, incoming).value).toBe(incoming);
    }), opts);
  });

  it("encoding round-trips any text", () => {
    fc.assert(fc.property(fc.string({ unit: "grapheme", maxLength: 50 }), (text) => {
      const value = doc({ "pdf:1": [box("a", { text })] });
      expect(decodePageText(value).pages["pdf:1"]!.boxes[0]!.text).toBe(text);
      expect(encodePageText(decodePageText(value))).toBe(value);
    }), opts);
  });
});
