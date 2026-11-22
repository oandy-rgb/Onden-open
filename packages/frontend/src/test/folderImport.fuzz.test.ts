// Fuzz: the browser side of a folder import: the Excalidraw note decoder
// (modules/importers/excalidraw.ts, a decompressor over a user's file) and the batch
// planner (modules/importers/folderImport.ts). Invariants: never throw, bounded time,
// a drawing converts to an inert SVG, and no file silently disappears from
// the upload plan. Replay: FUZZ_SEED=<seed> npm run test:fuzz.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { compressToBase64 } from "lz-string";
import { decodeExcalidraw, isExcalidrawFile } from "../modules/importers/excalidraw";
import { inkToSvg, encodeInk } from "@onden/markdown/ink";
import { convertDrawings } from "../modules/importers/drawingImport";
import { planImportBatches, type FolderImportFile } from "../modules/importers/folderImport";
import { anyString, expectWithinBudget, fuzzParams, soup } from "./fuzzSupport";

// A copy of markdown/src/test/htmlHazards.ts svgHazards is not needed here: the ink SVG's own
// guarantees are checked in packages/markdown (blocksAndCodecs.fuzz.test.ts); this file checks the
// decoder in front of it and that its output stays one of those documents.
const svgIsInert = (svg: string) => !/<script|<foreignObject|\son\w+\s*=|javascript:|<!DOCTYPE|<!ENTITY|href\s*=/i.test(svg);

const hostile = fc.oneof(soup, anyString, fc.constantFrom("red", "#fff", '" onload="x', "url(https://tracker.invalid/a)", "javascript:x", "</svg><script>x</script>"));
const num = fc.oneof(fc.double(), fc.integer(), fc.constantFrom(NaN, Infinity, -Infinity, 1e308, 0, -0));
const element = fc.record({
  id: fc.option(hostile, { nil: undefined }), type: fc.oneof(fc.constantFrom("freedraw", "line", "arrow", "rectangle", "ellipse", "diamond", "text", "image", "frame"), hostile),
  x: fc.option(num, { nil: undefined }), y: fc.option(num, { nil: undefined }), width: fc.option(num, { nil: undefined }), height: fc.option(num, { nil: undefined }),
  angle: fc.option(num, { nil: undefined }), strokeColor: fc.option(hostile, { nil: undefined }), strokeWidth: fc.option(num, { nil: undefined }),
  opacity: fc.option(num, { nil: undefined }), isDeleted: fc.option(fc.boolean(), { nil: undefined }),
  points: fc.option(fc.array(fc.oneof(fc.tuple(num, num), fc.constant(null), fc.constant("x"), fc.array(num, { maxLength: 4 })), { maxLength: 30 }), { nil: undefined }),
  pressures: fc.option(fc.array(num, { maxLength: 10 }), { nil: undefined }), text: fc.option(hostile, { nil: undefined }),
});

function drawingFile(json: string, compressed: boolean, banner: string) {
  const block = compressed ? "```compressed-json\n" + (compressToBase64(json).match(/.{1,256}/g) ?? []).join("\n") + "\n```" : "```json\n" + json + "\n```";
  return `---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---\n${banner}\n\n# Excalidraw Data\n## Text Elements\n${block}\n`;
}

describe("Excalidraw note decoder fuzz", () => {
  it("any text as a file: never throws; a result is a well-formed drawing", () => {
    fc.assert(fc.property(anyString, fc.constantFrom("a.excalidraw.md", "b.md", "../c.excalidraw.md", "d"), (content, path) => {
      expectWithinBudget("decodeExcalidraw", content, 100, () => {
        isExcalidrawFile(path, content);
        const result = decodeExcalidraw(path, content);
        if (result === null) return;
        expect(typeof result.title).toBe("string");
        expect(typeof result.body).toBe("string");
        for (const skip of result.skipped) expect(typeof skip.reason).toBe("string");
      });
    }), fuzzParams(1000));
  });

  it("hostile drawings (compressed or plain JSON, any element values) convert to an inert page", () => {
    fc.assert(fc.property(fc.array(element, { maxLength: 8 }), fc.boolean(), soup, (elements, compressed, banner) => {
      const file = drawingFile(JSON.stringify({ type: "excalidraw", version: 2, elements }), compressed, banner);
      const result = decodeExcalidraw("note.excalidraw.md", file);
      if (result === null) return;
      const stored = encodeInk(result.doc);
      const svg = inkToSvg(stored);
      if (svg !== null) expect(svgIsInert(svg), svg.slice(0, 200)).toBe(true);
      const converted = convertDrawings([{ path: "note.excalidraw.md", content: file }, { path: "n.md", content: banner }]);
      expect(converted.files).toHaveLength(2);
    }), fuzzParams(300));
  });

  it("truncated and corrupted compressed blocks are unreadable (null), not a crash", () => {
    const valid = drawingFile(JSON.stringify({ type: "excalidraw", elements: [{ id: "a", type: "freedraw", x: 0, y: 0, points: [[0, 0], [5, 5]], strokeColor: "#000" }] }), true, "");
    fc.assert(fc.property(fc.nat(valid.length), fc.nat(40), soup, (cut, drop, junk) => {
      const broken = valid.slice(0, cut) + junk + valid.slice(cut + drop);
      expectWithinBudget("decodeExcalidraw corrupted", broken, 100, () => { decodeExcalidraw("a.excalidraw.md", broken); });
    }), fuzzParams(1500));
  });
});

describe("import batch planner fuzz", () => {
  const encoder = new TextEncoder();
  const bytes = (f: FolderImportFile) => ("base64" in f ? f.base64.length + encoder.encode(f.path).length + 48 : encoder.encode(JSON.stringify(f)).length);
  const path = fc.oneof(fc.constantFrom("a.md", "x/b.md", "db.csv", "db_all.csv", "DB.CSV", "db/page.md", "db/sub/p.md", "db/sub.csv", "img.png"), anyString);
  const file: fc.Arbitrary<FolderImportFile> = fc.oneof(
    fc.record({ path, content: fc.string({ maxLength: 300 }) }),
    fc.record({ path, base64: fc.string({ maxLength: 300 }), kind: fc.constantFrom("image" as const, "pdf" as const, "media" as const) }),
  );

  it("every file is sent once or reported too large; no batch exceeds the request limit", () => {
    fc.assert(fc.property(fc.uniqueArray(file, { selector: (f) => f.path, maxLength: 14 }), fc.integer({ min: 50, max: 4000 }), fc.double({ min: 0.05, max: 1, noNaN: true }), (files, max, ratio) => {
      const target = Math.max(1, Math.floor(max * ratio)); // production: 8 MB target under the proxy cap
      const { batches, tooLarge } = planImportBatches(files, target, max);
      const sent = batches.flat();
      expect(new Set(sent.map((f) => f.path)).size).toBe(sent.length); // once, at most
      const reported = new Set(tooLarge.map((t) => t.path));
      for (const f of files) {
        const inBatch = sent.some((s) => s.path === f.path);
        if (inBatch) continue;
        // Dropped: reported itself, or part of a database whose CSV is reported.
        const csvOwner = tooLarge.some((t) => t.kind === "collection" && (f.path.toLowerCase().startsWith(`${t.path.toLowerCase().replace(/(?:_all)?\.csv$/, "")}/`) || t.path === f.path));
        expect(reported.has(f.path) || csvOwner, f.path).toBe(true);
      }
      for (const batch of batches) expect(batch.reduce((n, f) => n + bytes(f), 0)).toBeLessThanOrEqual(max);
    }), fuzzParams(1000));
  });
});
