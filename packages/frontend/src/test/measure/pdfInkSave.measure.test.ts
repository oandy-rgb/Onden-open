// Measurement, not a budget (the budget is ../pdfInkSaveBudget.test.ts): what one stroke costs on the wire for each kind of
// drawing, printed as one line. Default 100 strokes; for the table of docs/research/pdf-ink-save-measure-2026-11-15.md:
//   MEASURE_N=1000 MEASURE_EVERY=10 MEASURE_KIND=pdf|handwriting|board npx vitest run src/test/measure
// (MEASURE_EVERY: only every n-th save is encoded; the state is still built stroke by stroke. 5000 strokes takes ~10 minutes.)
// The server side of the same table is backend src/test/pdfInkStorage.measure.integration.test.ts.
import { describe, it } from "vitest";
import { noteDoc, notePages, withPageAppended, withPageDoc, type InkDocument, type InkStroke, encodeInk } from "@onden/markdown/ink";
import { emptyMultiPageDoc, type InkMultiPageDoc } from "../../lib/pdf/pdfAdapter";
import { pdfPageDoc, setPdfPageDoc, emptyPageDoc } from "../../lib/pdf/pageUnits";
import { patchedBody, wholeBody } from "../../lib/data/patchedBody";

const NODE = "00000000-0000-4000-8000-000000000001";
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
function stroke(i: number): InkStroke {
  let x = rnd() * 900, y = rnd() * 1300;
  const points: Array<[number, number, number]> = [];
  for (let k = 0; k < 30; k++) { x += rnd() * 6 - 3; y += rnd() * 6 - 3; points.push([x, y, 0.2 + rnd() * 0.6]); }
  return { id: `s${i.toString(36)}-${Math.floor(rnd() * 1e9).toString(36)}`, points, color: "#1b1f24", size: 2.5, toolId: "pen" };
}
type Row = { n: number; wire: number; value: number };
const wire = (attr: string, value: string, base: string): number => {
  const path = `/api/nodes/${NODE}/attributes/${attr}`;
  const body = JSON.stringify({ value, value_type: "text", is_inheritable: false, base_value: base });
  return Buffer.byteLength(patchedBody("PUT", path, body) ?? (wholeBody("PUT", path, body) as string));
};

function simulate(kind: "pdf" | "handwriting" | "board", strokes: number, every: number): Row[] {
  const rows: Row[] = [];
  let env: InkMultiPageDoc = emptyMultiPageDoc();
  let doc: InkDocument = emptyPageDoc();
  if (kind === "handwriting") for (let p = 1; p < 10; p++) doc = noteDoc(withPageAppended(notePages(doc), `page-${p}`))!;
  for (let i = 0; i < strokes; i++) {
    const [baseEnv, baseDoc] = [env, doc];
    if (kind === "pdf") {
      const page = 1 + Math.floor(rnd() * 30);
      const pageDoc = structuredClone(pdfPageDoc(env, page) ?? emptyPageDoc());
      pageDoc.strokes.push(stroke(i));
      env = setPdfPageDoc(env, page, pageDoc, Math.SQRT2);
    } else if (kind === "board") doc = { ...doc, strokes: [...doc.strokes, stroke(i)] };
    else {
      const pages = notePages(doc);
      const keys = Object.keys(pages.pages);
      const key = keys[Math.floor(rnd() * keys.length)]!;
      doc = noteDoc(withPageDoc(pages, key, { ...pages.pages[key]!.doc, strokes: [...pages.pages[key]!.doc.strokes, stroke(i)] }))!;
    }
    if ((i + 1) % every !== 0 && i + 1 !== strokes) continue;
    const [value, base] = kind === "pdf" ? [encodeInk(env), encodeInk(baseEnv)] : [encodeInk(doc), encodeInk(baseDoc)];
    rows.push({ n: i + 1, wire: wire(kind === "pdf" ? "ink_data" : kind === "board" ? "board_ink" : "note_ink", value, base), value: Buffer.byteLength(value) });
  }
  return rows;
}

describe("measure (prints)", () => {
  it("bytes on the wire per save", () => {
    const kind = (process.env.MEASURE_KIND ?? "pdf") as "pdf" | "handwriting" | "board";
    const n = Number(process.env.MEASURE_N ?? 100), every = Number(process.env.MEASURE_EVERY ?? 1);
    const t = Date.now();
    const rows = simulate(kind, n, every);
    // A sampled save stands for the `every` saves around it (trapezoid over the sampled points).
    let wireTotal = 0, valueTotal = 0, prev: Row = { n: 0, wire: 0, value: 0 };
    for (const r of rows) { wireTotal += ((prev.wire + r.wire) / 2) * (r.n - prev.n); valueTotal += ((prev.value + r.value) / 2) * (r.n - prev.n); prev = r; }
    const last = rows[rows.length - 1]!;
    console.log(`${kind} N=${n} avgWire=${Math.round(wireTotal / n)} lastWire=${last.wire} finalValue=${last.value} totalWire=${Math.round(wireTotal)} totalIfWholeValueEverySave=${Math.round(valueTotal)} ms=${Date.now() - t}`);
  }, 3_600_000);
});
