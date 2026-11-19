// What one body write costs a change bundle once anchors travel (anchors proposal 2026-11-16 §3.1, item 8 of steps 2-3; migration 215): a note with 50 or 200 anchors,
// one paragraph edited. All the anchors' places of a note are ONE unit (`note_anchor_places`, review of PR #1853 round 2 point 2): a body write writes that one row, and
// the block_anchors rows (which carry only `note`) do not travel at all. Sizes are printed (JSON as on the wire, and gzip); the item counts are asserted. Both engines.
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, bundleFor, exchange, peerOf } from "./helpers/stampedBundleWorld.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

const WORDS = "the of and to in is was for on with as by at from that this which be are have it an or not but".split(" ");
const para = (i: number) => `Paragraph ${i}: ` + Array.from({ length: 14 }, (_, k) => WORDS[(i * 7 + k * 3) % WORDS.length]).join(" ") + ` number ${i} {sized}`;

async function measure(n: number): Promise<{ anchorRows: number; unitRows: number; rows: number; bytes: number; gzip: number; anchorBytes: number; anchorGzip: number }> {
  const [na, nb] = [await openNode("a"), await openNode("b")];
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  await fillFrom(nb, world, await capture(na, world, 1_000_000));
  const a = peerOf("A", na, world), b = peerOf("B", nb, world);
  await admit(a, b);
  await onNode(a.node, () => a.call("POST", "/api/tags", { name: "sized" }));
  const ps = Array.from({ length: n }, (_, i) => para(i));
  const note = await onNode(a.node, async () => (await a.call("POST", "/api/nodes", { title: `Sized ${n}`, markdown: ps.join("\n\n"), space_id: a.space })).id as string);
  await exchange(a, b);
  const edited = ps.map((p, i) => (i === Math.floor(n / 2) ? p.replace("Paragraph", "One edited paragraph") : p));
  await onNode(a.node, () => a.call("PATCH", `/api/nodes/${note}`, { markdown: edited.join("\n\n") }));
  const bundle = await bundleFor(a, b);
  const wire = JSON.stringify(bundle);
  const items = bundle.items;
  const anchorItems = items.filter((i) => i.kind === "row" && i.table === "block_anchors");
  const unitItems = items.filter((i) => i.kind === "row" && i.table === "note_anchor_places");
  const anchorWire = JSON.stringify(unitItems);
  return { anchorRows: anchorItems.length, unitRows: unitItems.length, rows: items.length, bytes: wire.length, gzip: gzipSync(wire).length, anchorBytes: anchorWire.length, anchorGzip: gzipSync(anchorWire).length };
}

describe.skipIf(!isTestDb)("the bundle of one body write on a note with anchors", () => {
  for (const n of [50, 200]) {
    it(`a note with ${n} anchors, one paragraph edited: the bundle carries the note's one anchors unit and no anchor row (sizes printed)`, async () => {
      const m = await measure(n);
      console.log(`[anchor bundle] ${n} anchors, one paragraph edited: ${m.rows} rows, ${(m.bytes / 1024).toFixed(1)} KB JSON / ${(m.gzip / 1024).toFixed(1)} KB gzip; `
        + `the anchors unit alone ${(m.anchorBytes / 1024).toFixed(1)} KB / ${(m.anchorGzip / 1024).toFixed(1)} KB gzip`);
      expect(m.anchorRows).toBe(0);
      expect(m.unitRows).toBe(1);
    }, 600_000);
  }
});
