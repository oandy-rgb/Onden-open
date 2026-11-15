// The chunker of a big drawing value (services/inkChunks.ts chunkInk): chunks join back to the value exactly, none is
// over the limit, a lone surrogate never ends up at a cut, and a stroke appended to the text changes only the chunks
// around the change — which is what keeps a save's storage proportional to what it changed.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { chunkInk } from "../../services/inkChunker.js";
import { pdfInkSim } from "../helpers/pdfInkEnvelope.js";
import { check, PROPS_RUNS } from "../helpers/propsConfig.js";

const MAX = 64 * 1024;
const SIM_SEED = 5;
const objectsText = fc.array(fc.string({ maxLength: 400 }), { maxLength: 300 }).map((parts) => `[${parts.map((p) => `{"a":${JSON.stringify(p)}}`).join(",")}]`);
const hostile = fc.oneof(
  objectsText,
  fc.string({ unit: "binary", maxLength: 3000 }),
  fc.string({ maxLength: 5 }).map((s) => s.repeat(40_000)),            // no object boundary at all, over the chunk limit
  fc.constant("😀".repeat(MAX)),                                      // surrogate pairs where a hard cut would land
  fc.constant(`{"a":"${"x".repeat(MAX * 2)}"},{"b":1},`),
);

describe("chunkInk", () => {
  it("joins back to the text, with no empty chunk and none over the limit", () => {
    check(fc.property(hostile, (text) => {
      const chunks = chunkInk(text);
      expect(chunks.join("")).toBe(text);
      for (const chunk of chunks) { expect(chunk.length).toBeGreaterThan(0); expect(chunk.length).toBeLessThanOrEqual(MAX); }
    }), 100);
  });

  it("never cuts between the halves of a surrogate pair", () => {
    const chunks = chunkInk("😀".repeat(MAX));
    for (const chunk of chunks) expect(chunk).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it("is deterministic and an empty text has no chunks", () => {
    expect(chunkInk("")).toEqual([]);
    const text = pdfInkSim({ seed: SIM_SEED }).value() + "{},".repeat(10_000);
    expect(chunkInk(text)).toEqual(chunkInk(text));
  });

  it("a stroke added to a big drawing changes few chunks (the storage a save adds)", () => {
    check(fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 150, max: 260 }), (seed, strokes) => {
      const sim = pdfInkSim({ seed });
      sim.drawStrokes(strokes);
      const before = chunkInk(sim.value());
      const after = chunkInk(sim.drawStroke());
      const known = new Set(before);
      const changed = after.filter((chunk) => !known.has(chunk));
      // The new stroke lands in four places of the value (the older page, the older record, the page units, the fingerprint).
      expect(changed.length).toBeLessThanOrEqual(8);
      expect(changed.reduce((n, chunk) => n + chunk.length, 0)).toBeLessThan(sim.value().length / 3);
    }), Math.min(PROPS_RUNS, 25));
  });
});
