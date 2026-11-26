// The ink surfaces' saver (lib/ink/surfaceSaver) keeps strokes on this device from pen-up (keepAdded), for every surface
// (PDF pages, handwriting notes, the 「手寫」 tab, the whiteboard's pen layer): only the strokes just added, as a save made
// from nothing, in one queue row per change under the key the surface's next save uses; the save (at the surface's pause,
// as before) takes that row. Rule: docs/architecture/note-writes.md「筆跡：抬筆就記下」. Survival of a killed page:
// inkStrokeSurvivesKill.test.ts; the merge of such a save: inkAdditionsMerge.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { decodeInk, encodeInk, type InkDocument, type InkStroke } from "@onden/markdown/ink";
import { InkSaver, pageWithOnly } from "../lib/ink";
import { pdfWithOnly, setPdfPageDoc } from "../lib/pdf";
import { emptyMultiPageDoc, type InkMultiPageDoc } from "../lib/pdf/pdfAdapter";
import type { InkSaveBase, InkSaveOptions, KeptWrite } from "../lib/data";

const NODE = "n1";
const PAGE = { width: 1000 };
const stroke = (id: string, i: number): InkStroke => ({ id, points: [[i, 1], [i + 4, 6], [i + 9, 2]], color: "#000000", size: 2, toolId: "pen" });
const page = (...ids: string[]): InkDocument => ({ version: 1, strokes: ids.map((id, i) => stroke(id, i * 10)), erased: {}, page: PAGE } as InkDocument);
const only = (...ids: string[]) => pageWithOnly(PAGE, { strokes: ids.map((id, i) => stroke(id, 100 + i)), shapes: [] });
const text = (doc: InkSaveBase | null | undefined) => (doc == null ? "" : typeof doc === "string" ? doc : encodeInk(doc));
const idsIn = (doc: InkSaveBase) => (decodeInk(text(doc)) as { doc: InkDocument }).doc.strokes.map((s) => s.id).sort();

/** The kept rows (one key per change) and each write into them, whose durability the test controls. */
type Row = KeptWrite & { dropped: boolean };
type Write = { value: InkSaveBase; base: InkSaveBase | null | undefined; record: (ok: boolean) => void; row: Row };
let keys = 0;
function keeper() {
  const writes: Write[] = [];
  const rows: Row[] = [];
  const holds: InkSaveBase[] = [];
  const keep = vi.fn((_node: string, value: InkSaveBase, base: InkSaveBase | null | undefined, options: { into?: KeptWrite; holdOnly?: boolean }) => {
    if (options.holdOnly) { holds.push(value); return { kept: options.into!, written: Promise.resolve(true) }; }
    let record!: (ok: boolean) => void;
    const written = new Promise<boolean>((resolve) => { record = resolve; });
    let row = options.into as Row | undefined;
    if (!row) {
      const made: Row = { idemKey: `k${++keys}`, recorded: written, dropped: false, rewrite: async () => true, hold: () => {}, answered: () => {}, release: () => {}, drop: async () => { made.dropped = true; } };
      rows.push(made);
      row = made;
    }
    writes.push({ value, base, record, row });
    return { kept: row, written };
  });
  return { writes, rows, keep, holds };
}
type Send = NonNullable<ConstructorParameters<typeof InkSaver>[1]>;
type Outcome = Awaited<ReturnType<Send>>;
function sender() {
  const sent: Array<{ value: InkSaveBase; base: InkSaveBase | null | undefined; options?: InkSaveOptions }> = [];
  const send: Send = vi.fn(async (_node, value, base, options) => {
    sent.push({ value, base, options });
    return { saved: true, stored: text(value), sent: text(value) } as Outcome;
  });
  return { sent, send };
}
const flushPromises = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("InkSaver.keepAdded: the strokes of a pen-up, kept at once; the surface's save takes them", () => {
  it("a stroke is kept at once as a save made from nothing holding only it; the save is made under that row's key", async () => {
    const { writes, rows, keep } = keeper();
    const { sent, send } = sender();
    const saver = new InkSaver(undefined, send, keep);
    saver.rebase(NODE, page("a"));
    saver.keepAdded(NODE, only("b"));
    expect(writes).toHaveLength(1);
    expect(idsIn(writes[0]!.value)).toEqual(["b"]);
    expect(writes[0]!.base, "made from nothing: the server adds it and takes nothing away").toBeNull();
    expect(sent).toHaveLength(0);
    writes[0]!.record(true);
    saver.save(NODE, page("a", "b")); // the surface's settled save, as before
    expect(sent).toHaveLength(1);
    expect(idsIn(sent[0]!.value)).toEqual(["a", "b"]);
    expect(sent[0]!.options?.kept, "one write to the server: the save goes under the kept row's key").toBe(rows[0]);
  });

  it("two strokes in quick succession: one row, written one at a time, the second holding both", async () => {
    const { writes, rows, keep, holds } = keeper();
    const { sent, send } = sender();
    const saver = new InkSaver(undefined, send, keep);
    saver.rebase(NODE, null);
    saver.keepAdded(NODE, only("a"));
    saver.keepAdded(NODE, only("b"));
    expect(writes, "the second waits for the first write to be durable").toHaveLength(1);
    expect(holds.map(idsIn), "…but both strokes are copied at once, before the handler returns").toEqual([["a", "b"]]);
    writes[0]!.record(true);
    await flushPromises();
    expect(writes).toHaveLength(2);
    expect(idsIn(writes[1]!.value)).toEqual(["a", "b"]);
    expect(rows).toHaveLength(1);
    expect(writes[1]!.row).toBe(rows[0]);
    saver.save(NODE, page("a", "b"));
    expect(sent[0]!.options?.kept).toBe(rows[0]);
  });

  it("after a save took the row, the next strokes keep a row of their own (another key), holding only them", async () => {
    const { writes, rows, keep } = keeper();
    const { sent, send } = sender();
    const saver = new InkSaver(undefined, send, keep);
    saver.rebase(NODE, page("a"));
    saver.keepAdded(NODE, only("b"));
    writes[0]!.record(true);
    saver.save(NODE, page("a", "b"));
    saver.keepAdded(NODE, only("c"));
    expect(rows).toHaveLength(2);
    expect(rows[1]!.idemKey).not.toBe(rows[0]!.idemKey);
    expect(idsIn(writes[1]!.value)).toEqual(["c"]);
    await flushPromises();
    saver.save(NODE, page("a", "b", "c"));
    expect(sent[1]!.options?.kept).toBe(rows[1]);
  });

  it("strokes taken back before the surface's pause (no save follows) let their row go", async () => {
    const { writes, rows, keep } = keeper();
    const { send } = sender();
    const saver = new InkSaver(undefined, send, keep);
    saver.rebase(NODE, page("a"));
    saver.keepAdded(NODE, only("b"));
    writes[0]!.record(true);
    await act(async () => { vi.advanceTimersByTime(5_000); });
    expect(rows[0]!.dropped).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("a save without kept strokes (an erase, an undo) has no kept row; the re-save after a refusal never takes one", async () => {
    const { keep } = keeper();
    const { sent, send } = sender();
    const saver = new InkSaver(undefined, send, keep);
    saver.rebase(NODE, page("a", "b"));
    saver.save(NODE, { ...page("a", "b"), erased: { a: [[0, 2]] } });
    expect(sent[0]!.options?.kept).toBeUndefined();
  });
});

describe("the space a long run of strokes keeps on the device is bounded", () => {
  // Review of PR #1958 (property 2): writing on without the surface's pause must not grow what one row (and one record of
  // the local journal) holds. Rows are sealed at a fixed size; the save takes the last one and the sealed ones go once it
  // has an outcome.
  it("300 strokes without a pause: every write stays under the cap; all strokes are in some row; the save clears them", async () => {
    const { writes, rows, keep } = keeper();
    const { send } = sender();
    const saver = new InkSaver(undefined, send, keep);
    saver.rebase(NODE, null);
    const all: string[] = [];
    for (let i = 0; i < 300; i++) {
      const id = `s${i}`;
      all.push(id);
      saver.keepAdded(NODE, pageWithOnly(PAGE, { strokes: [{ ...stroke(id, i), points: Array.from({ length: 30 }, (_, k) => [i + k, k, 0.5] as [number, number, number]) }], shapes: [] }));
      writes.at(-1)!.record(true);
      await flushPromises();
    }
    const longest = Math.max(...writes.map((w) => text(w.value).length));
    expect(longest).toBeLessThan(34_000);
    const kept = new Set(rows.flatMap((row) => idsIn(writes.filter((w) => w.row === row).at(-1)!.value)));
    expect([...kept].sort()).toEqual([...all].sort());
    expect(rows.length).toBeGreaterThan(2);
    saver.save(NODE, page(...all));
    await flushPromises();
    expect(rows.slice(0, -1).every((r) => r.dropped), "the sealed rows go with the save's outcome").toBe(true);
    expect(rows.at(-1)!.dropped, "the last row is the save's own row").toBe(false);
  });
});

describe("the work at pen-up is the size of the strokes added, not of the drawing", () => {
  // Review of PR #1958 (property 1): what pen-up encodes and writes must not grow with the drawing. Before, every pen-up
  // encoded and wrote the whole drawing (a PDF envelope of all pages); now only the new stroke, in the surface's format.
  for (const size of [200, 2000]) {
    it(`PDF with ${size} strokes: one new stroke writes the same few bytes`, () => {
      const { writes, keep } = keeper();
      const saver = new InkSaver(undefined, sender().send, keep);
      let env: InkMultiPageDoc = emptyMultiPageDoc();
      const perPage = size / 10;
      for (let p = 1; p <= 10; p++) env = setPdfPageDoc(env, p, page(...Array.from({ length: perPage }, (_, i) => `p${p}s${i}`)), 1.414);
      saver.rebase(NODE, env);
      saver.keepAdded(NODE, pdfWithOnly(env, "pdf:3", { strokes: [stroke("new", 5)], shapes: [] }, 1.414)!);
      const bytes = text(writes[0]!.value).length;
      // One stroke and its older-format record: under 2 KB whatever the drawing holds (the whole envelope is > 100 KB at 200).
      expect(bytes).toBeLessThan(2_000);
      expect(encodeInk(env).length).toBeGreaterThan(bytes * 50);
    });
  }
});
