// A PDF note's `ink_data` envelope as the client writes it, grown one stroke at a time
// (frontend lib/pdf/pageUnits.ts setPdfPageDoc): every stroke is stored three times —
// in the older `pages[n]`, as an older drawing record in `annotations`, and in page units
// in `units` — and `unitsFrom` fingerprints the older fields. Seeded, so a run is repeatable.
import { legacyFingerprint, pdfPageRecord, type InkDocument, type InkEnvelope, type InkStroke } from "@onden/markdown/ink";

export type PdfInkSim = {
  /** Add one hand-drawn stroke (30 points, unrounded, pressure) to a page; returns the new stored value. */
  drawStroke(): string;
  /** The same without building the value (many strokes in a row); read `value()` after. */
  drawStrokes(n: number): void;
  /** The stored value now. */
  value(): string;
  /** Ids of every stroke drawn so far. */
  ids(): string[];
};

export function pdfInkSim(options: { seed?: number; pages?: number; pointsPerStroke?: number } = {}): PdfInkSim {
  let seed = options.seed ?? 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pageCount = options.pages ?? 30, points = options.pointsPerStroke ?? 30;
  const units = new Map<number, InkDocument>();
  const legacyStrokes = new Map<number, InkStroke[]>();
  const records: Array<Record<string, unknown>> = [];
  const all: string[] = [];
  let count = 0;
  const empty = (): InkDocument => ({ version: 1, strokes: [], erased: {}, page: { width: 1000 } });

  const build = (): InkEnvelope => {
    const pages: Record<number, InkDocument> = {};
    for (const [n, strokes] of legacyStrokes) pages[n] = { ...empty(), strokes };
    const legacy = { version: 1, pages, annotations: [...records] } as unknown as InkEnvelope;
    const unitPages: Record<string, ReturnType<typeof pdfPageRecord>> = {};
    for (const [n, doc] of units) unitPages[`pdf:${n}`] = pdfPageRecord(n, doc, Math.SQRT2);
    return { ...legacy, units: { version: 1, pages: unitPages }, unitsFrom: legacyFingerprint(legacy) } as unknown as InkEnvelope;
  };
  let current: string | null = null; // built when read: drawing many strokes in a row stays cheap
  const value = () => (current ??= JSON.stringify(build()));
  const add = () => {
      const n = 1 + Math.floor(rnd() * pageCount);
      let x = rnd() * 900, y = rnd() * 1300;
      const pts: Array<[number, number, number]> = [];
      for (let k = 0; k < points; k++) { x += rnd() * 6 - 3; y += rnd() * 6 - 3; pts.push([x, y, 0.2 + rnd() * 0.6]); }
      const id = `s${(count++).toString(36)}-${Math.floor(rnd() * 1e9).toString(36)}`;
      const stroke: InkStroke = { id, points: pts, color: "#1b1f24", size: 2.5, toolId: "pen" };
      const doc = units.get(n) ?? empty();
      units.set(n, { ...doc, strokes: [...doc.strokes, stroke] });
      legacyStrokes.set(n, [...(legacyStrokes.get(n) ?? []), stroke]);
      records.push({
        id, type: "drawing",
        content: { strokes: [{ points: pts.map(([px, py, p]) => ({ x: px, y: py, p })), color: stroke.color, width: stroke.size, toolId: "pen" }], frame: { w: 80, h: 80 } },
        position: { boundingRect: { x1: x, y1: y, x2: x + 80, y2: y + 80, width: 1000, height: 1414, pageNumber: n }, rects: [] },
      });
      all.push(id);
      current = null;
  };
  return {
    drawStroke() { add(); return value(); },
    drawStrokes(n) { for (let i = 0; i < n; i++) add(); },
    value,
    ids: () => all,
  };
}
