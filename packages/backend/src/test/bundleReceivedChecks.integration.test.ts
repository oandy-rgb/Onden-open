// The declared checks of received anchor and paragraph rows (review of PR #1853, point 6; spine/stampedMerge/dbUnits.ts `check`): a bundle whose anchor or paragraph row
// is not one a writer makes is refused whole (`bundle_malformed`) before anything is written, and a value the database will not hold is refused the same way, never as a
// raw database error. Each case changes one thing in a real bundle between the sender and the receiver. Both engines.
import { afterEach, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { NODE_MARKDOWN_MAX } from "@onden/markdown";
import type { ChangeBundle } from "../spine/snapshotSql.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, bundleFor, exchange, peerOf, take, type Peer } from "./helpers/stampedBundleWorld.js";
import { anchorUnitJson } from "./helpers/anchorUnitText.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

const BODY = "First paragraph of the probe {probe}\n\nSecond paragraph, a little longer than the first {probe}\n";

/** A and B hold the same world; A then writes a note with two tagged paragraphs (two anchors, two paragraph rows) and B has not taken it yet. */
async function pending(): Promise<{ a: Peer; b: Peer; bundle: ChangeBundle }> {
  const [na, nb] = [await openNode("a"), await openNode("b")];
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  await fillFrom(nb, world, await capture(na, world, 1_000_000));
  const a = peerOf("A", na, world), b = peerOf("B", nb, world);
  await admit(a, b);
  await onNode(a.node, () => a.call("POST", "/api/nodes", { title: "Probe", markdown: BODY, space_id: a.space }));
  return { a, b, bundle: await bundleFor(a, b) };
}
type Row = Extract<ChangeBundle["items"][number], { kind: "row" }>;
const rowsOf = (bundle: ChangeBundle, table: string): Row[] => bundle.items.filter((i): i is Row => i.kind === "row" && i.table === table);
/** Change the note's anchors unit: its first anchor's entry, or the unit itself (its text and its column value together, so only the named rule can catch it). */
type Entry = unknown[];
function spoilUnit(bundle: ChangeBundle, change: (u: { h: string; a: Record<string, Entry> }, first: Entry) => void): void {
  const row = rowsOf(bundle, "note_anchor_places")[0]!;
  const unit = JSON.parse(row.texts.places as string) as { h: string; a: Record<string, Entry> };
  change(unit, unit.a[Object.keys(unit.a).sort()[0]!]!);
  row.texts.places = anchorUnitJson(unit);
  row.values.places = unit;
}
const refusal = (b: Peer, bundle: ChangeBundle) => take(b, bundle).then(() => null, (e: { code?: string }) => e.code ?? String(e));
const refusalOf = (b: Peer, bundle: ChangeBundle) => take(b, bundle).then(() => null, (e: { code?: string; message?: string }) => ({ code: e.code, message: String(e.message) }));
const anchorsOn = (b: Peer) => onNode(b.node, async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM block_anchors WHERE workspace_id = $1`, [b.ws])).rows[0]!.n));

const CASES: Array<{ name: string; says: string; spoil: (bundle: ChangeBundle) => void }> = [
  { name: "an anchor that stands past the end of the body it names", says: "past the end", spoil: (x) => spoilUnit(x, (_u, e) => { e[1] = BODY.length + 10; }) },
  { name: "an anchor whose candidate ends before it starts", says: "(candidate)", spoil: (x) => spoilUnit(x, (_u, e) => { e[2] = "maybe"; e[0] = 0; e[1] = 0; e[3] = 9; e[4] = 3; }) },
  { name: "a note's anchors whose body hash is not a sha-256", says: "(body hash)", spoil: (x) => spoilUnit(x, (u) => { u.h = "not-a-hash"; }) },
  { name: "an anchor whose quote is longer than a note may be", says: "longer than a note", spoil: (x) => spoilUnit(x, (_u, e) => { e[6] = "x".repeat(NODE_MARKDOWN_MAX + 1); }) },
  { name: "an anchor whose status is not one of valid / maybe / lost", says: "(status)", spoil: (x) => spoilUnit(x, (_u, e) => { e[2] = "found"; }) },
  { name: "a paragraph row whose label is longer than a writer writes", says: "label is not a text", spoil: (x) => { rowsOf(x, "block_nodes")[0]!.values.label = "y".repeat(5000); } },
  { name: "a paragraph row whose anchor is not an anchor id", says: "anchor is not an anchor id", spoil: (x) => { const r = rowsOf(x, "block_nodes")[0]!; r.texts.anchor = "no spaces allowed"; r.values.anchor_id = "no spaces allowed"; } },
  { name: "a new row whose carried values are not the units the bundle says", says: "not the units the bundle says", spoil: (x) => { const r = rowsOf(x, "note_anchor_places")[0]!; r.values.places = { ...(r.values.places as object), h: "f".repeat(64) }; } },
  { name: "a value the database does not hold (an anchor kind its CHECK refuses)", says: "a value this database does not hold", spoil: (x) => { rowsOf(x, "block_anchors")[0]!.values.kind = "sideways"; } },
];

/** A and B hold the same note with its two anchors; A then edits the body, so the bundle carries the note's anchors unit as a write to a row B already holds (the usual case). */
async function pendingUpdate(): Promise<{ a: Peer; b: Peer; bundle: ChangeBundle }> {
  const { a, b, bundle } = await pending();
  await take(b, bundle);
  const note = (rowsOf(bundle, "note_anchor_places")[0]!.stamps[0]!.rowKey);
  await onNode(a.node, () => a.call("PATCH", `/api/nodes/${note}`, { markdown: BODY.replace("First paragraph", "First edited paragraph") }));
  const next = await bundleFor(a, b);
  expect(rowsOf(next, "note_anchor_places")).toHaveLength(1);
  return { a, b, bundle: next };
}
/** Change the text of the anchors unit a bundle writes into B's row (a change of the text alone: the rule about the text's form is what catches it, or the one named). */
function spoilText(bundle: ChangeBundle, change: (text: string) => string): void {
  const row = rowsOf(bundle, "note_anchor_places")[0]!;
  row.texts.places = change(row.texts.places as string);
  try { row.values.places = JSON.parse(row.texts.places); } catch { /* the text is not JSON: the values stay as they were */ }
}
const reshaped = (change: (u: { h: string; a: Record<string, Entry> }, first: Entry, firstId: string) => void) => (text: string) => {
  const u = JSON.parse(text) as { h: string; a: Record<string, Entry> };
  const id = Object.keys(u.a).sort()[0]!;
  change(u, u.a[id]!, id);
  return anchorUnitJson(u);
};
const unitOn = (b: Peer) => onNode(b.node, async () => (await q<{ t: string }>(`SELECT places::text AS t FROM note_anchor_places WHERE workspace_id = $1`, [b.ws])).rows.map((r) => r.t));

// round 3, points 3, 4 and 11: what a node takes for a unit row it already holds is checked as for a new one, and the text must be the database's own text of it
const UPDATES: Array<{ name: string; says: string; spoil: (bundle: ChangeBundle) => void }> = [
  { name: "a position written 0.0", says: "not written as the database writes it", spoil: (x) => spoilText(x, (t) => t.replace("[0, ", "[0.0, ")) },
  { name: "a quote with a NUL", says: "a text the database cannot hold", spoil: (x) => spoilText(x, reshaped((_u, e) => { e[6] = `${String(e[6])}\u0000`; })) },
  { name: "its keys in another order", says: "not written as the database writes it", spoil: (x) => spoilText(x, (t) => { const u = JSON.parse(t) as { h: string; a: unknown }; return `{"h": ${JSON.stringify(u.h)}, "a": ${t.slice(t.indexOf("{", 1), t.lastIndexOf(', "h"'))}}`; }) },
  { name: "more space between its parts", says: "not written as the database writes it", spoil: (x) => spoilText(x, (t) => t.replace(", ", ",  ")) },
  { name: "a key besides h and a", says: "(keys)", spoil: (x) => spoilText(x, (t) => `${t.slice(0, -1)}, "x": 1}`) },
  { name: "an entry of 8 elements", says: "an anchor's entry", spoil: (x) => spoilText(x, reshaped((_u, e) => { e.length = 8; })) },
  { name: "an entry of 11 elements", says: "an anchor's entry", spoil: (x) => spoilText(x, reshaped((u, e) => { e.push("e".repeat(64), u.h); })) },
  { name: "an own body hash that is the unit's", says: "an anchor's own body hash", spoil: (x) => spoilText(x, reshaped((u, e) => { e.push(u.h); })) },
  { name: "an anchor id that is not one", says: "(anchor id)", spoil: (x) => spoilText(x, reshaped((u, e, id) => { delete u.a[id]; u.a["no spaces here"] = e; })) },
  { name: "an entry with its own body hash standing past any note (round 4, point 1)", says: "(position)", spoil: (x) => spoilText(x, reshaped((u, e) => { e[0] = 0; e[1] = 3_000_000_000; e.push("e".repeat(64)); })) },
  { name: "a head not chosen, holding an entry with its own body hash past any note (refused when it arrives, not when it is chosen later)", says: "anchors are not usable", spoil: (x) => {
    const s = rowsOf(x, "note_anchor_places")[0]!.stamps.find((w) => w.label === "note_anchor_places" && w.field === "places")!;
    const u = JSON.parse(rowsOf(x, "note_anchor_places")[0]!.texts.places as string) as { h: string; a: Record<string, Entry> };
    const later = { h: "d".repeat(64), a: { [Object.keys(u.a).sort()[0]!]: [0, 3_000_000_000, "valid", null, null, false, "q", "", "", "e".repeat(64)] } };
    s.heads.push({ origin: s.origin, seq: s.seq - 1, contentHash: "0".repeat(64), wall: s.wall - 1, counter: 0, author: s.author, device: s.device, deleted: false, saw: {}, meta: null, value: anchorUnitJson(later) });
  } },
  { name: "a head that is not chosen and is not usable", says: "anchors are not usable", spoil: (x) => {
    const s = rowsOf(x, "note_anchor_places")[0]!.stamps.find((w) => w.label === "note_anchor_places" && w.field === "places")!;
    s.heads.push({ origin: s.origin, seq: s.seq - 1, contentHash: "0".repeat(64), wall: s.wall - 1, counter: 0, author: s.author, device: s.device, deleted: false, saw: {}, meta: null, value: "not a unit" });
  } },
];

describe.skipIf(!isTestDb)("received anchors and paragraph rows are checked before anything is written", () => {
  it("the bundle as it was sent is taken (so each case below is refused for its one change)", async () => {
    const { a, b, bundle } = await pending();
    expect(rowsOf(bundle, "block_anchors")).toHaveLength(2);
    expect(rowsOf(bundle, "note_anchor_places")).toHaveLength(1);
    expect(rowsOf(bundle, "block_nodes")).toHaveLength(2);
    expect(await refusal(b, bundle)).toBeNull();
    await exchange(a, b);
    expect(await anchorsOn(b)).toBe(await anchorsOn(a));
  }, 600_000);
  for (const c of CASES) {
    it(`${c.name}: bundle_malformed, nothing written`, async () => {
      const { b, bundle } = await pending();
      const before = await anchorsOn(b);
      c.spoil(bundle);
      const r = await refusalOf(b, bundle);
      expect(r?.code).toBe("bundle_malformed");
      expect(r?.message).toContain(c.says); // refused by the rule the case is about
      expect(await anchorsOn(b)).toBe(before);
    }, 600_000);
  }
  it("an update of a unit row B holds, as it was sent, is taken (so each case below is refused for its one change)", async () => {
    const { b, bundle } = await pendingUpdate();
    expect(await refusal(b, bundle)).toBeNull();
  }, 600_000);
  // round 4, point 1: a value the database refuses while the rows are written from the unit (after every received check) refuses the bundle with a code, never a raw
  // database error. No received value reaches it any more (the checks above refuse them first), so the database is made to refuse one here: a CHECK added to this test's
  // node only, on a quote the honest unit carries.
  it("a value the database refuses while the anchor rows are written from the unit: bundle_malformed, nothing written", async () => {
    const { b, bundle } = await pendingUpdate();
    const before = await unitOn(b);
    await onNode(b.node, () => q(`ALTER TABLE block_anchors ADD CONSTRAINT test_no_edited_quote CHECK (quote NOT LIKE 'First edited%')`));
    const r = await refusalOf(b, bundle);
    expect(r?.code).toBe("bundle_malformed");
    expect(r?.message).toContain("cannot be written into what follows from it");
    expect(await unitOn(b)).toEqual(before);
  }, 600_000);
  // round 6, point 1: a row item is a row its sender holds, with its values and the text of its units. A row the sender does not hold travels as its stamps (tombstone
  // items), the one form the receiver's checks skip; a row item without values (or with values that are not an object) and texts the checks would refuse is not that
  // form: refused whole before anything is checked or written (stampedImport.ts checkBundleShape). One row of each table, newer stamps than B holds, and B holds the row.
  for (const table of ["block_nodes", "block_anchors", "note_anchor_places"] as const) {
    it(`a row item of ${table} without values, its texts never checked, on a row B holds: bundle_malformed, nothing written`, async () => {
      const { a, b, bundle: first } = await pending();
      const held = structuredClone(rowsOf(first, table)[0]!);
      await take(b, first);
      const note = rowsOf(first, "note_anchor_places")[0]!.stamps[0]!.rowKey;
      await onNode(a.node, () => a.call("PATCH", `/api/nodes/${note}`, { markdown: BODY.replace("First paragraph", "First edited paragraph") }));
      const next = await bundleFor(a, b);
      const newer = rowsOf(next, "note_anchor_places")[0]!.stamps[0]!; // a stamp of A's that B does not hold yet
      const garbage: Record<string, string> = table === "block_nodes" ? { anchor: "no spaces allowed", note: "not a note" } : table === "block_anchors" ? { note: "not a note" } : { places: "{\"not\": \"a unit\"}" };
      const before = { unit: await unitOn(b), anchors: await anchorsOn(b) };
      for (const values of [undefined, null, "a text"] as const) {
        const spoilt = structuredClone(next);
        const item = { kind: "row", table, texts: garbage, stamps: held.stamps.map((st) => ({ ...st, ...(st.field === "*" ? {} : { origin: newer.origin, seq: newer.seq, wall: newer.wall, counter: newer.counter }) })) } as Record<string, unknown>;
        if (values !== undefined) item.values = values;
        spoilt.items.push(item as unknown as Row);
        const r = await refusalOf(b, spoilt);
        expect(r?.code, String(values)).toBe("bundle_malformed");
        expect(r?.message, String(values)).toContain("carries its values and the text of its units");
        expect({ unit: await unitOn(b), anchors: await anchorsOn(b) }, String(values)).toEqual(before);
      }
      expect(await refusal(b, next)).toBeNull(); // the bundle as it was sent is taken
    }, 600_000);
  }
  // round 7, point 1 of the shape (and point 5): a row item's texts must be an object of texts, its values an object; tested apart from the values above
  it("a row item whose texts are missing or not an object, a text that is not a text, values that are a list: bundle_malformed, nothing written", async () => {
    const { b, bundle } = await pendingUpdate();
    const before = await unitOn(b);
    const spoilers: Array<[string, (r: Record<string, unknown>) => void]> = [
      ["texts missing", (r) => { delete r.texts; }],
      ["texts a list", (r) => { r.texts = ["x"]; }],
      ["a text that is a number", (r) => { (r.texts as Record<string, unknown>).places = 7; }],
      ["values a list", (r) => { r.values = [1, 2]; }],
    ];
    for (const [name, spoil] of spoilers) {
      const spoilt = structuredClone(bundle);
      spoil(rowsOf(spoilt, "note_anchor_places")[0] as unknown as Record<string, unknown>);
      const r = await refusalOf(b, spoilt);
      expect(r?.code, name).toBe("bundle_malformed");
      expect(r?.message, name).toContain("carries its values and the text of its units");
      expect(await unitOn(b), name).toEqual(before);
    }
  }, 600_000);

  // round 7, point 2: an item that is not a row with its stamps or a tombstone with its stamp, a stamp without its list of heads, a head whose value is not a text: refused
  // with the code before anything reads them (a TypeError before)
  it("an item of another kind, stamps that are not a list, a head whose value is not a text: bundle_malformed, nothing written", async () => {
    const { b, bundle } = await pendingUpdate();
    const before = await unitOn(b);
    const spoilers: Array<[string, (x: ChangeBundle) => void]> = [
      ["an item of another kind", (x) => { (x.items as unknown[]).push({ kind: "column", table: "block_nodes" }); }],
      ["a row whose stamps are not a list", (x) => { (rowsOf(x, "note_anchor_places")[0] as unknown as Record<string, unknown>).stamps = { a: 1 }; }],
      ["a stamp without heads", (x) => { delete (rowsOf(x, "note_anchor_places")[0]!.stamps[0] as unknown as Record<string, unknown>).heads; }],
      ["a tombstone without its stamp", (x) => { (x.items as unknown[]).push({ kind: "tombstone", table: "block_nodes" }); }],
      ["a head whose value is a number", (x) => { const st = rowsOf(x, "note_anchor_places")[0]!.stamps[0]!; st.heads = [{ ...st, value: 5 } as never]; }],
      // round 8, point 4: what a write had seen is an object of whole numbers (Object.values let a list, a number and a boolean through, stored as they came), the
      // same test as a snapshot's (checkSaw); a stamp names its row and unit by text; a head marked without a value has none; a kept value is a text or null
      ["a saw that is a list", (x) => { (rowsOf(x, "note_anchor_places")[0]!.stamps[0] as unknown as Record<string, unknown>).saw = [1, 2]; }],
      ["a saw that is a number", (x) => { (rowsOf(x, "note_anchor_places")[0]!.stamps[0] as unknown as Record<string, unknown>).saw = 7; }],
      ["a saw whose number is a boolean", (x) => { (rowsOf(x, "note_anchor_places")[0]!.stamps[0] as unknown as Record<string, unknown>).saw = { A: true }; }],
      ["a saw with an empty origin", (x) => { (rowsOf(x, "note_anchor_places")[0]!.stamps[0] as unknown as Record<string, unknown>).saw = { "": 1 }; }],
      ["a head whose saw is a list", (x) => { const st = rowsOf(x, "note_anchor_places")[0]!.stamps[0]!; st.heads = [{ ...st, heads: undefined, saw: [3] } as never]; }],
      ["a row key that is a number", (x) => { (rowsOf(x, "note_anchor_places")[0]!.stamps[0] as unknown as Record<string, unknown>).rowKey = 5; }],
      ["a field that is not a text", (x) => { (rowsOf(x, "note_anchor_places")[0]!.stamps[0] as unknown as Record<string, unknown>).field = null; }],
      ["a head marked without a value that has one", (x) => { const st = rowsOf(x, "note_anchor_places")[0]!.stamps[0]!; st.heads = [{ ...st, heads: undefined, value: "x", valueless: true } as never]; }],
      ["a kept value that is not a text", (x) => { (rowsOf(x, "note_anchor_places")[0]!.stamps[0] as unknown as Record<string, unknown>).kept = { text: 5 }; }],
      // round 10, point 2: an emptied id kept on a unit that has no check of its own, and a value kept where none may be kept
      ["a note's kept parent that is not an id", (x) => { const st = rowsOf(x, "note_anchor_places")[0]!.stamps[0]!; (x.items as unknown[]).push({ kind: "tombstone", table: "content_nodes", stamp: { ...st, label: "content_nodes", field: "parent", deleted: false, heads: [], kept: { text: "x" } } }); }],
      ["a space's kept owner that is not an id", (x) => { const st = rowsOf(x, "note_anchor_places")[0]!.stamps[0]!; (x.items as unknown[]).push({ kind: "tombstone", table: "spaces", stamp: { ...st, label: "spaces", field: "owner", deleted: false, heads: [], kept: { text: "x" } } }); }],
      ["a value kept on a table that keeps none", (x) => { const st = rowsOf(x, "note_anchor_places")[0]!.stamps[0]!; (x.items as unknown[]).push({ kind: "tombstone", table: "content_nodes", stamp: { ...st, label: "content_nodes", field: "title", deleted: false, heads: [], kept: { text: "a title" } } }); }],
    ];
    for (const [name, spoil] of spoilers) {
      const spoilt = structuredClone(bundle);
      spoil(spoilt);
      const r = await refusalOf(b, spoilt);
      expect(r?.code, name).toBe("bundle_malformed");
      expect(r?.message, name).toMatch(/has its list of heads|a value a stamp kept is not one it may keep/);
      expect(await unitOn(b), name).toEqual(before);
    }
  }, 600_000);

  // round 8, point 4: a key the table cannot hold (not a uuid for a paragraph row) failed the read with the database's own 22P02, and a field's write that is a tombstone
  // failed the write-back with a plain Error: both refused with the code now, before anything is written
  it("a paragraph row's key that is not a uuid, a two-column key in one part, a field's write that is a tombstone: bundle_malformed, nothing written", async () => {
    const { b, bundle } = await pending();
    const before = { unit: await unitOn(b), anchors: await anchorsOn(b) };
    const spoilers: Array<[string, (x: ChangeBundle) => void]> = [
      ["a key that is not a uuid", (x) => { for (const st of rowsOf(x, "block_nodes")[0]!.stamps) st.rowKey = "not-a-uuid"; }],
      // round 9, point 5 a: a key of a table keyed by two columns that is not two parts (splitRowKey threw a plain Error before)
      ["a two-column key that is one part", (x) => { const st = rowsOf(x, "block_nodes")[0]!.stamps[0]!; (x.items as unknown[]).push({ kind: "tombstone", table: "node_tags", stamp: { ...st, label: "node_tags", rowKey: "only-one-part", field: "*", deleted: true, heads: [] } }); }],
      ["a field's tombstone", (x) => { const st = rowsOf(x, "block_nodes")[0]!.stamps.find((w) => w.field !== "*") ?? rowsOf(x, "block_nodes")[0]!.stamps[0]!;
        rowsOf(x, "block_nodes")[0]!.stamps.push({ ...st, field: "task", deleted: true, heads: [] }); }],
    ];
    for (const [name, spoil] of spoilers) {
      const spoilt = structuredClone(bundle);
      spoil(spoilt);
      const r = await refusalOf(b, spoilt);
      expect(r?.code, name).toBe("bundle_malformed");
      expect({ unit: await unitOn(b), anchors: await anchorsOn(b) }, name).toEqual(before);
    }
    expect(await refusal(b, bundle)).toBeNull(); // the bundle itself is taken
  }, 600_000);

  // round 7, point 2: every value a unit may take is checked, the heads too (a head that wins reaches the column). An old stamp of a field B holds, with a NEWER head whose
  // value no writer gives, for each field of a paragraph row and an anchor that has a check; as a tombstone item and inside the row item: refused whole, nothing written.
  const HEADS: Array<{ table: "block_nodes" | "block_anchors"; field: string; value: string; says: string }> = [
    { table: "block_nodes", field: "anchor", value: "no spaces allowed", says: "anchor is not an anchor id" },
    { table: "block_nodes", field: "ref", value: "no spaces allowed", says: "ref is not an anchor id" },
    { table: "block_nodes", field: "note", value: "not a note", says: "note is not an id" },
    { table: "block_nodes", field: "task", value: "not a task", says: "task is not an id" },
    { table: "block_nodes", field: "detached", value: `{"detached_tags": [""], "detached_note_id": null}`, says: "detached state is a tag that is not a name" },
    { table: "block_nodes", field: "detached", value: `{"detached_tags": null, "detached_note_id": "not-a-note"}`, says: "detached state is a child that is not a note id" },
    { table: "block_nodes", field: "detached", value: `{"evil": 1}`, says: "detached state is a key it does not have" },
    { table: "block_anchors", field: "note", value: "not a note", says: "note is not a note id" },
  ];
  for (const c of HEADS) for (const carrier of ["tombstone", "row"] as const) {
    it(`a ${c.table} ${c.field} head no writer gives (in a ${carrier} item), newer than what B holds: bundle_malformed, nothing written`, async () => {
      const { a, b, bundle: first } = await pending();
      const held = structuredClone(rowsOf(first, c.table)[0]!);
      await take(b, first);
      const note = rowsOf(first, "note_anchor_places")[0]!.stamps[0]!.rowKey;
      await onNode(a.node, () => a.call("PATCH", `/api/nodes/${note}`, { markdown: BODY.replace("First paragraph", "First edited paragraph") }));
      const next = await bundleFor(a, b);
      const newer = rowsOf(next, "note_anchor_places")[0]!.stamps[0]!;
      const star = held.stamps.find((st) => st.field === "*")!;
      const head = { origin: newer.origin, seq: newer.seq, contentHash: "", wall: newer.wall, counter: newer.counter, author: newer.author, device: newer.device, deleted: false, saw: {}, meta: null, value: c.value };
      const fieldStamp = { ...star, field: c.field, saw: {}, meta: null, heads: [head] };
      if (carrier === "tombstone") next.items.push({ kind: "tombstone", table: c.table, stamp: star } as never, { kind: "tombstone", table: c.table, stamp: fieldStamp } as never);
      else next.items.push({ ...held, stamps: [...held.stamps.filter((st) => st.field !== c.field), fieldStamp] } as never);
      const before = { unit: await unitOn(b), anchors: await anchorsOn(b) };
      const r = await refusalOf(b, next);
      expect(r?.code).toBe("bundle_malformed");
      expect(r?.message).toContain(c.says);
      expect({ unit: await unitOn(b), anchors: await anchorsOn(b) }).toEqual(before);
    }, 600_000);
  }

  for (const c of UPDATES) {
    it(`an update of a unit row B holds, ${c.name}: bundle_malformed, nothing written`, async () => {
      const { b, bundle } = await pendingUpdate();
      const before = await unitOn(b);
      c.spoil(bundle);
      const r = await refusalOf(b, bundle);
      expect(r?.code).toBe("bundle_malformed");
      expect(r?.message).toContain(c.says);
      expect(await unitOn(b)).toEqual(before);
    }, 600_000);
  }
});
