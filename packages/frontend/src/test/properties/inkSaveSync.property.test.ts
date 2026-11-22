// 手寫存檔量（2026-11-15，docs/research/scan-2026-11-14/09-ink-pdf.md S1／M2／M3／M4）：兩台裝置各自畫、擦、復原，
// 中間有被拒絕的存檔與「回到這個版本」，存檔走真的 InkSaver（lib/ink/surfaceSaver）、伺服器端用真的 mergeInk。
// 不變條件：最後兩台裝置與伺服器上的筆跡都等於模型 —— 畫了、沒擦、沒復原的一筆都在，擦掉或復原掉的都不在。
//
// 模型（只動自己畫的筆，所以結果沒有歧義）：每一筆有擁有的裝置與「意圖」（看得見／擦掉了／沒了）；
// 還原版本把意圖重設成那個版本的樣子。重新載入與還原只在安靜的時候發生（先存、等所有存檔結束）。
// 頁面（手寫）與 PDF 信封（三份存放）各跑一遍。
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import { decodeInk, mergeInk, type InkDocument, type InkStroke, encodeInk } from "@onden/markdown/ink";
import { InkSaver } from "../../lib/ink/surfaceSaver";
import type { InkSaveBase, InkSaveDoc } from "../../lib/data";
import { emptyMultiPageDoc, type InkMultiPageDoc } from "../../lib/pdf/pdfAdapter";
import { emptyPageDoc, pdfPageDoc, readPdfInk, setPdfPageDoc } from "../../lib/pdf/pageUnits";

const NODE = "note-1";
type Kind = "page" | "pdf";
type Device = "A" | "B";

/** The server: one stored text, saves merged into it by their base exactly as services/attributeWrites.ts does. */
type InkSend = NonNullable<ConstructorParameters<typeof InkSaver>[1]>;

class FakeServer {
  stored = "";
  history: string[] = [];
  refuseNext = new Set<Device>();
  /** Every save's base that named text the server could not give back (a second request would follow in the app). */
  unknownBases = 0;
  refused = 0;
  lastRefused: Record<Device, boolean> = { A: false, B: false };
  private known = new Set<string>([""]);
  send(device: Device): InkSend {
    return (_node: string, doc: InkSaveBase, base: InkSaveBase | null | undefined) => {
      const incoming = typeof doc === "string" ? doc : encodeInk(doc);
      const refused = this.refuseNext.delete(device);
      if (refused) this.refused++;
      this.lastRefused[device] = refused;
      // Arrival order is call order (the write lane); the answer comes later.
      let outcome = { saved: false, stored: null as string | null, sent: null as string | null };
      if (!refused) {
        let value = incoming;
        if (base !== undefined) {
          const baseText = base === null ? "" : typeof base === "string" ? base : encodeInk(base);
          if (!this.known.has(baseText)) this.unknownBases++;
          if (this.stored !== "" && this.stored !== baseText && this.stored !== incoming) value = mergeInk(baseText, this.stored, incoming).value;
        }
        this.stored = value;
        this.known.add(value);
        this.history.push(value);
        outcome = { saved: true, stored: value, sent: incoming };
      }
      return Promise.resolve().then(() => outcome);
    };
  }
}

// ── The two kinds of drawing the surface saves ──────────────────────────────
const point = (i: number): Array<[number, number]> => [[i, 1], [i + 1, 2], [i + 2, 3]];
const strokeOf = (id: string, i: number): InkStroke => ({ id, points: point(i), color: "#000000", size: 2, toolId: "pen" });
const erasedAll = (doc: InkDocument, id: string): boolean => {
  const stroke = doc.strokes.find((s) => s.id === id);
  const spans = doc.erased[id] ?? [];
  return !!stroke && spans.some(([from, to]) => from <= 0 && to >= stroke.points.length - 1);
};
const PAGES = [1, 2, 3];

interface Surface {
  empty(): InkSaveDoc;
  draw(doc: InkSaveDoc, id: string, n: number): InkSaveDoc;
  erase(doc: InkSaveDoc, id: string): InkSaveDoc;
  unerase(doc: InkSaveDoc, id: string): InkSaveDoc;
  remove(doc: InkSaveDoc, id: string): InkSaveDoc;
  /** The strokes a person sees, from stored text (or a document): id → visible. */
  strokes(doc: InkSaveDoc | string): Map<string, boolean>;
  decode(text: string): InkSaveDoc;
}
const pageSurface: Surface = {
  empty: () => emptyPageDoc(),
  draw: (d, id, n) => { const doc = d as InkDocument; return { ...doc, strokes: [...doc.strokes, strokeOf(id, n)] }; },
  erase: (d, id) => { const doc = d as InkDocument; return { ...doc, erased: { ...doc.erased, [id]: [[0, 2]] } }; },
  unerase: (d, id) => { const doc = d as InkDocument; const { [id]: _gone, ...rest } = doc.erased; return { ...doc, erased: rest }; },
  remove: (d, id) => { const doc = d as InkDocument; const { [id]: _gone, ...rest } = doc.erased; return { ...doc, strokes: doc.strokes.filter((s) => s.id !== id), erased: rest }; },
  strokes: (d) => {
    const doc = typeof d === "string" ? (() => { const decoded = decodeInk(d); return decoded.kind === "page" ? decoded.doc : emptyPageDoc(); })() : d as InkDocument;
    return new Map(doc.strokes.map((s) => [s.id, !erasedAll(doc, s.id)]));
  },
  decode: (text) => { const decoded = decodeInk(text); return decoded.kind === "page" ? decoded.doc : emptyPageDoc(); },
};
const pageOfId = (id: string) => PAGES[Number(id.replace(/\D/g, "")) % PAGES.length]!;
const pdfSurface: Surface = {
  empty: () => emptyMultiPageDoc(),
  draw: (d, id, n) => { const env = d as InkMultiPageDoc, page = pageOfId(id); const doc = pdfPageDoc(env, page) ?? emptyPageDoc(); return setPdfPageDoc(env, page, { ...doc, strokes: [...doc.strokes, strokeOf(id, n)] }, Math.SQRT2); },
  erase: (d, id) => { const env = d as InkMultiPageDoc, page = pageOfId(id); const doc = pdfPageDoc(env, page)!; return setPdfPageDoc(env, page, { ...doc, erased: { ...doc.erased, [id]: [[0, 2]] } }, Math.SQRT2); },
  unerase: (d, id) => { const env = d as InkMultiPageDoc, page = pageOfId(id); const doc = pdfPageDoc(env, page)!; const { [id]: _gone, ...rest } = doc.erased; return setPdfPageDoc(env, page, { ...doc, erased: rest }, Math.SQRT2); },
  remove: (d, id) => { const env = d as InkMultiPageDoc, page = pageOfId(id); const doc = pdfPageDoc(env, page)!; const { [id]: _gone, ...rest } = doc.erased; return setPdfPageDoc(env, page, { ...doc, strokes: doc.strokes.filter((s) => s.id !== id), erased: rest }, Math.SQRT2); },
  strokes: (d) => {
    const env = typeof d === "string" ? readPdfInk(d, null) : d as InkMultiPageDoc;
    const out = new Map<string, boolean>();
    for (const page of PAGES) { const doc = pdfPageDoc(env, page); if (doc) for (const s of doc.strokes) out.set(s.id, !erasedAll(doc, s.id)); }
    return out;
  },
  decode: (text) => readPdfInk(text, null),
};

// ── Operations ──────────────────────────────────────────────────────────────
type Op =
  | { op: "draw" | "erase" | "undo" | "save" | "refuse" | "sync"; dev: Device }
  | { op: "wait" }
  | { op: "restore"; pick: number };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ op: fc.constant("draw" as const), dev: fc.constantFrom<Device>("A", "B") }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("erase" as const), dev: fc.constantFrom<Device>("A", "B") }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("undo" as const), dev: fc.constantFrom<Device>("A", "B") }) },
  { weight: 5, arbitrary: fc.record({ op: fc.constant("save" as const), dev: fc.constantFrom<Device>("A", "B") }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("refuse" as const), dev: fc.constantFrom<Device>("A", "B") }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("sync" as const), dev: fc.constantFrom<Device>("A", "B") }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("wait" as const) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("restore" as const), pick: fc.nat(1000) }) },
);

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

type Intent = "visible" | "hidden" | "gone";
/** `finalSave: false` — nothing saves after the last operation (the saver alone must have repaired the server).
 *  `autosave` — every edit is followed by its save, as the ink engine's debounce does; the last save of a device is repeated
 *  only when the server refused it (the person retries what an error told them about). */
async function run(surface: Surface, ops: Op[], { finalSave = true, autosave = false } = {}): Promise<void> {
  const server = new FakeServer();
  const docs: Record<Device, InkSaveDoc> = { A: surface.empty(), B: surface.empty() };
  const savers: Record<Device, InkSaver> = { A: new InkSaver(undefined, server.send("A")), B: new InkSaver(undefined, server.send("B")) };
  // Both devices opened the (empty) note.
  for (const dev of ["A", "B"] as const) savers[dev].rebase(NODE, null);
  const intent = new Map<string, Intent>();
  const owner = new Map<string, Device>();
  const undo: Record<Device, Array<{ kind: "draw" | "erase"; id: string }>> = { A: [], B: [] };
  let n = 0;

  const save = (dev: Device) => savers[dev].save(NODE, docs[dev]);
  const reload = (dev: Device) => {
    docs[dev] = server.stored === "" ? surface.empty() : surface.decode(server.stored);
    savers[dev].rebase(NODE, server.stored === "" ? null : docs[dev]);
    undo[dev] = [];
  };
  const quiet = async () => { save("A"); save("B"); await settle(); };

  for (const step of ops) {
    if (step.op === "draw") {
      const id = `${step.dev}${++n}`;
      docs[step.dev] = surface.draw(docs[step.dev], id, n);
      intent.set(id, "visible"); owner.set(id, step.dev); undo[step.dev].push({ kind: "draw", id });
      if (autosave) save(step.dev);
    } else if (step.op === "erase") {
      const mine = [...intent].filter(([id, v]) => v === "visible" && owner.get(id) === step.dev && surface.strokes(docs[step.dev]).get(id) === true).map(([id]) => id);
      const id = mine[mine.length - 1];
      if (!id) continue;
      docs[step.dev] = surface.erase(docs[step.dev], id);
      intent.set(id, "hidden"); undo[step.dev].push({ kind: "erase", id });
      if (autosave) save(step.dev);
    } else if (step.op === "undo") {
      const last = undo[step.dev].pop();
      if (!last) continue;
      if (last.kind === "draw") { docs[step.dev] = surface.remove(docs[step.dev], last.id); intent.set(last.id, "gone"); }
      else { docs[step.dev] = surface.unerase(docs[step.dev], last.id); intent.set(last.id, "visible"); }
      if (autosave) save(step.dev);
    } else if (step.op === "save") save(step.dev);
    else if (step.op === "refuse") server.refuseNext.add(step.dev);
    else if (step.op === "sync") {
      const refusedBefore = server.refused;
      await quiet();
      // A refused save keeps what was drawn on screen (rejectPendingWrite): such a surface is not reloaded.
      if (server.refused === refusedBefore) reload(step.dev);
    }
    else if (step.op === "restore") {
      await quiet();
      if (server.history.length === 0) continue;
      // History's 「回到這個版本」: the server takes an older stored version whole; both surfaces reload it (M4).
      server.stored = server.history[step.pick % server.history.length]!;
      server.history.push(server.stored);
      const restored = surface.strokes(server.stored);
      for (const [id] of intent) intent.set(id, restored.has(id) ? (restored.get(id) ? "visible" : "hidden") : "gone");
      reload("A"); reload("B");
    }
    else if (step.op === "wait") await settle();
  }

  // Everyone saves what is on their screen, then both reload.
  server.refuseNext.clear();
  if (finalSave) { await quiet(); await quiet(); }
  else {
    await settle();
    for (const dev of ["A", "B"] as const) if (server.lastRefused[dev]) save(dev);
    await settle();
  }
  reload("A"); reload("B");

  const expected = new Set([...intent].filter(([, v]) => v === "visible").map(([id]) => id));
  const seen = (d: InkSaveDoc | string) => new Set([...surface.strokes(d)].filter(([, visible]) => visible).map(([id]) => id));
  const sorted = (s: Set<string>) => [...s].sort();
  expect(sorted(seen(server.stored)), "the server").toEqual(sorted(expected));
  expect(sorted(seen(docs.A)), "device A").toEqual(sorted(expected));
  expect(sorted(seen(docs.B)), "device B").toEqual(sorted(expected));
}

const KINDS: Array<[Kind, Surface]> = [["page", pageSurface], ["pdf", pdfSurface]];

describe.each(KINDS)("兩台裝置、被拒絕的存檔與還原版本之後，筆跡等於模型（%s）", (_kind, surface) => {
  it("隨機的畫／擦／復原／存檔／拒絕／同步／還原順序", async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 45 }), (ops) => run(surface, ops)), { seed: PROPS_SEED, numRuns: PROPS_RUNS });
  }, Math.max(20_000, PROPS_RUNS * 100));

  it("每次編輯都跟著一次存檔（引擎的 debounce），沒有額外的存檔：被拒絕的存檔之後的存檔也不弄丟那些筆", async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 45 }), (ops) => run(surface, ops.filter((o) => o.op !== "save"), { finalSave: false, autosave: true })), { seed: PROPS_SEED, numRuns: PROPS_RUNS });
  }, Math.max(20_000, PROPS_RUNS * 100));

  // 固定的最小反例（M3）：存檔 1 被拒絕，存檔 2 已經排在後面 —— 被拒絕那一筆不能被當成「對方刪掉的」。
  it("M3：前一次存檔被拒絕，後面那次被接受，被拒絕那次畫的一筆仍在", async () => {
    await run(surface, [
      { op: "refuse", dev: "A" }, { op: "draw", dev: "A" }, { op: "save", dev: "A" },
      { op: "draw", dev: "A" }, { op: "save", dev: "A" },
    ], { finalSave: false });
  });

  it("M3：另一台先存過，這台的存檔 1 被拒絕、存檔 2 被接受，兩台的筆都在", async () => {
    await run(surface, [
      { op: "draw", dev: "B" }, { op: "save", dev: "B" },
      { op: "draw", dev: "A" }, { op: "refuse", dev: "A" }, { op: "save", dev: "A" },
      { op: "draw", dev: "A" }, { op: "save", dev: "A" },
    ], { finalSave: false });
  });

  // M2：合併發生之後，下一次存檔的基底要是伺服器存的那份，不是自己上次送的那份。
  it("M2：另一台存過、這台合併後，下一次存檔的基底是伺服器有的版本（沒有第二個請求）", async () => {
    const server = new FakeServer();
    const a = new InkSaver(undefined, server.send("A")), b = new InkSaver(undefined, server.send("B"));
    a.rebase(NODE, null); b.rebase(NODE, null);
    let docA = surface.draw(surface.empty(), "A1", 1), docB = surface.draw(surface.empty(), "B1", 2);
    a.save(NODE, docA); await settle();
    b.save(NODE, docB); await settle();      // merged on the server: B's answer holds A1 too
    a.save(NODE, docA = surface.draw(docA, "A2", 3)); await settle(); // A merges B1 in
    docB = surface.draw(docB, "B2", 4);
    b.save(NODE, docB); await settle();
    a.save(NODE, surface.draw(docA, "A3", 5)); await settle();
    expect(server.unknownBases).toBe(0);
  });

  // M4：還原之後 rebase，下一筆是「還原的版本 + 新的一筆」。
  it("M4：回到較早的版本、重新載入之後再畫一筆，伺服器得到「那個版本 + 新的一筆」", async () => {
    await run(surface, [
      { op: "draw", dev: "A" }, { op: "save", dev: "A" }, { op: "draw", dev: "A" }, { op: "save", dev: "A" },
      { op: "restore", pick: 0 }, { op: "draw", dev: "B" }, { op: "save", dev: "B" },
    ]);
  });
});

