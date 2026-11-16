// 手寫存檔量（2026-11-15，docs/research/scan-2026-11-14/09-ink-pdf.md S1）：PDF 筆記每畫一筆就存一次，一筆在信封裡存三份
// （舊的 pages[n]、舊的 annotations 紀錄、頁面單位的 units），分散在文字的前、中、後。以前 makePatch 只切共同開頭與結尾，
// 一筆的 patch 就是「那一頁之後的全部」（1000 筆時約 4.8 MB，整份 6 MB；5000 筆時 30 MB，超過 20 MB 上限就存不進去）。
// 現在一筆的請求只和那一筆成正比。這裡一筆一筆存 1000 筆，量每次存檔送出的位元組。
//
// 量測表（同一個模擬、同一台機器，PR 說明有完整表格）：
//   PDF，第 1000 筆：存檔前 4,793,746 B，存檔後 6,561 B；5000 筆：存檔前 30,483,020 B，存檔後 6,589 B。
//   手寫本（十頁）與白板筆層本來就只有一處變動：約 2.0 KB，不變。
import { describe, expect, it } from "vitest";
import { applyPatch, makePatch } from "@onden/markdown";
import { noteDoc, notePages, withPageAppended, withPageDoc, type InkDocument, type InkStroke } from "@onden/markdown/ink";
import { encodeInk } from "../lib/ink/store";
import { emptyMultiPageDoc, type InkMultiPageDoc } from "../lib/pdf/pdfAdapter";
import { pdfPageDoc, setPdfPageDoc, emptyPageDoc } from "../lib/pdf/pageUnits";
import { patchedBody, wholeBody } from "../lib/data/patchedBody";

const NODE = "00000000-0000-4000-8000-000000000001";
const STROKES = 1000;
// What one stroke needs on the wire, with the room a request's envelope and a longer stroke may take. Measured: 6.6 KB
// (a 30-point stroke with pressure, written three times); a whole value at this size is 6 MB.
const PDF_BYTES_PER_SAVE = 12_000;
// One place changes per stroke: 2.0 KB measured.
const SINGLE_PLACE_BYTES_PER_SAVE = 4_000;

let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
/** A hand stroke as the engine stores it: page units, unrounded, with pressure. */
function stroke(i: number): InkStroke {
  let x = rnd() * 900, y = rnd() * 1300;
  const points: Array<[number, number, number]> = [];
  for (let k = 0; k < 30; k++) { x += rnd() * 6 - 3; y += rnd() * 6 - 3; points.push([x, y, 0.2 + rnd() * 0.6]); }
  return { id: `s${i.toString(36)}-${Math.floor(rnd() * 1e9).toString(36)}`, points, color: "#1b1f24", size: 2.5, toolId: "pen" };
}

/** The request the app sends for a save of `value` made from `base`, as bytes. Also proves the patch gives the value back. */
function wireBytes(attr: string, value: string, base: string): number {
  const path = `/api/nodes/${NODE}/attributes/${attr}`;
  const body = JSON.stringify({ value, value_type: "text", is_inheritable: false, base_value: base });
  const patched = patchedBody("PUT", path, body);
  if (patched !== null) {
    const { value_patch } = JSON.parse(patched) as { value_patch: Parameters<typeof applyPatch>[1] };
    expect(applyPatch(base, value_patch)).toBe(value);
  }
  return Buffer.byteLength(patched ?? (wholeBody("PUT", path, body) as string));
}

describe("what one stroke costs to save", () => {
  it(`PDF: ${STROKES} strokes saved one by one, none sends more than ${PDF_BYTES_PER_SAVE} bytes`, () => {
    let env: InkMultiPageDoc = emptyMultiPageDoc();
    const sizes: number[] = [];
    for (let i = 0; i < STROKES; i++) {
      const page = 1 + Math.floor(rnd() * 30);
      const doc = structuredClone(pdfPageDoc(env, page) ?? emptyPageDoc());
      doc.strokes.push(stroke(i));
      const base = env;
      env = setPdfPageDoc(env, page, doc, Math.SQRT2);
      // Every save of the last 10, and one in a hundred before them: encoding a 6 MB value is what makes the test long.
      if (i >= STROKES - 10 || i % 100 === 0) sizes.push(wireBytes("ink_data", encodeInk(env), encodeInk(base)));
    }
    expect(encodeInk(env).length).toBeGreaterThan(5_000_000); // a whole copy per save would be this much
    expect(Math.max(...sizes), `largest save (bytes), all: ${sizes.join(",")}`).toBeLessThan(PDF_BYTES_PER_SAVE);
  }, 180_000);

  it("handwriting notes (ten pages) and a whiteboard's pen layer stay one stroke per save", () => {
    for (const kind of ["note_ink", "board_ink"] as const) {
      let doc: InkDocument = emptyPageDoc();
      if (kind === "note_ink") for (let p = 1; p < 10; p++) doc = noteDoc(withPageAppended(notePages(doc), `page-${p}`))!;
      const sizes: number[] = [];
      for (let i = 0; i < STROKES; i++) {
        const base = doc;
        if (kind === "board_ink") doc = { ...doc, strokes: [...doc.strokes, stroke(i)] };
        else {
          const pages = notePages(doc);
          const keys = Object.keys(pages.pages);
          const key = keys[Math.floor(rnd() * keys.length)]!;
          const page = pages.pages[key]!.doc;
          doc = noteDoc(withPageDoc(pages, key, { ...page, strokes: [...page.strokes, stroke(i)] }))!;
        }
        if (i >= STROKES - 40 || i % 100 === 0) sizes.push(wireBytes(kind, encodeInk(doc), encodeInk(base)));
      }
      expect(Math.max(...sizes), kind).toBeLessThan(SINGLE_PLACE_BYTES_PER_SAVE);
    }
  }, 120_000);

  it("a stroke in several places of one-line JSON is several small hunks (the fixed counterexample of the PDF save)", () => {
    const one = (id: number) => `{"id":"s${id}","points":[[1.234567890123,2.345678901234,0.5],[3.1,4.1,0.5]],"size":2.5}`;
    const run = (from: number, n: number) => Array.from({ length: n }, (_, i) => one(from + i)).join(",");
    const env = (a: string, b: string, c: string) => `{"pages":{"1":[${a}],"2":[${b}]},"annotations":[${c}],"unitsFrom":"x"}`;
    const base = env(run(0, 60), run(100, 200), run(300, 60));
    const next = env(`${run(0, 60)},${one(900)}`, run(100, 200), `${run(300, 60)},${one(901)}`);
    const patch = makePatch(base, next);
    expect(applyPatch(base, patch)).toBe(next);
    expect(patch.hunks.reduce((n, h) => n + h.ins.length, 0)).toBeLessThan(2 * one(900).length + 100);
  });
});
