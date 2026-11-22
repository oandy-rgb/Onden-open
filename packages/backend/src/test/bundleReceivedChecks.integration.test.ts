// The declared checks of received anchor and paragraph rows (review of PR #1853, point 6; spine/stampedMerge/dbUnits.ts `check`): a bundle whose anchor or paragraph row
// is not one a writer makes is refused whole (`bundle_malformed`) before anything is written, and a value the database will not hold is refused the same way, never as a
// raw database error. Each case changes one thing in a real bundle between the sender and the receiver. Both engines.
import { afterEach, describe, expect, it } from "vitest";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { q } from "../db.js";
import type { ChangeBundle } from "../spine/snapshotSql.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { ALL_TABLES, admit, bundleFor, exchange, makeRng, peerOf, take, writeEachRowKind, writeFor, type Peer } from "./helpers/stampedBundleWorld.js";
import { UNIT_SOURCES } from "../spine/stampedMerge/index.js";
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
type Stamp = Row["stamps"][number];
/** Another head on the unit `field` of `row`, written by a number the sender used for another write (no clash). */
function withHead(row: Row, field: string, value: string | null): void {
  const star = row.stamps.find((s) => s.field === "*")!;
  const newest = row.stamps.reduce((m, s) => (s.seq > m.seq ? s : m), star);
  const own = row.stamps.find((s) => s.field === field);
  // a number the sender used, and not the unit's own winner's (one write with two contents is another refusal)
  const head = { origin: newest.origin, seq: (own?.seq ?? newest.seq) - 1, contentHash: "", wall: newest.wall - 1, counter: 0, author: newest.author, device: newest.device, deleted: false, saw: {}, meta: null, value };
  if (own) own.heads = [...own.heads, head as never];
  else row.stamps.push({ ...star, field, saw: {}, meta: null, heads: [head as never] } as Stamp);
}
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

// Every carried table, through the one mechanism (proposal own-node-transport-2026-11-22 §4.2 item 3; dbUnits.ts RowSource.check, now declared by every source): a value the
// column cannot hold, a value a writer never writes, or carried values that are not the units the bundle says, in the winner OR in another head, refuse the bundle whole, with
// a code and a plain reason, and nothing is written. Before, only the anchors' tables were checked; a head of any other table was stored unchecked (it reaches the column
// only when it wins, and then the bundle that made it win is refused for ever: two nodes stall).
describe.skipIf(!isTestDb)("a received value of any carried table is checked, every head of it too", () => {
  /** A and B hold note N; A then writes N again (title, order key, hidden) and turns a module off, so the bundle carries rows of content_nodes and workspaces that B holds. */
  async function updated(): Promise<{ a: Peer; b: Peer; bundle: ChangeBundle; note: string }> {
    const [na, nb] = [await openNode("a"), await openNode("b")];
    open.push(na, nb);
    const world = await buildSourceWorld(na);
    await fillFrom(nb, world, await capture(na, world, 1_000_000));
    const a = peerOf("A", na, world), b = peerOf("B", nb, world);
    await admit(a, b);
    const note = await onNode(a.node, async () => (await a.call("POST", "/api/nodes", { title: "Checked", markdown: "", space_id: a.space })).id as string);
    await exchange(a, b);
    await onNode(a.node, () => a.call("PATCH", `/api/nodes/${note}`, { title: "Checked again" }));
    await onNode(a.node, () => q(`UPDATE workspaces SET modules_off = '["calendar"]'::jsonb WHERE id = $1`, [a.ws]).catch(() => undefined));
    return { a, b, bundle: await bundleFor(a, b), note };
  }
  const noteRow = (x: ChangeBundle, id: string) => rowsOf(x, "content_nodes").find((r) => r.stamps.some((s) => s.rowKey === id))!;
  const notesOn = (b: Peer) => onNode(b.node, async () => (await q<{ r: string }>(`SELECT string_agg(id::text || ' ' || title || ' ' || order_key || ' ' || hidden::text, ', ' ORDER BY id) AS r FROM content_nodes WHERE workspace_id = $1`, [b.ws])).rows[0]!.r);
  const headsOn = (b: Peer) => onNode(b.node, async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_stamp_heads WHERE workspace_id = $1`, [b.ws])).rows[0]!.n));

  const HEADS: Array<{ name: string; field: string; value: string | null; says: string }> = [
    { name: "a title with a NUL in it", field: "title", value: "a\u0000b", says: "not text a database can keep" },
    { name: "an empty title (the column is never empty)", field: "title", value: null, says: "never empty" },
    { name: "a hidden state that is not a boolean", field: "hidden", value: "perhaps", says: "not of its column's type" },
    { name: "a deleted state that is neither true nor false", field: "deleted", value: "2026-11-22", says: "neither true nor false" },
    { name: "a parent that is not an id", field: "parent", value: "not-an-id", says: "not of its column's type" },
    // review of PR #1940, round 2, point 2: an order key keyBetween refuses breaks every later insert under that parent; no honest node holds one
    { name: "an order key keyBetween does not accept (\"~\")", field: "sort", value: "~", says: "not one keyBetween accepts" },
    { name: "an order key keyBetween does not accept (\"a00\": the fraction ends in 0)", field: "sort", value: "a00", says: "not one keyBetween accepts" },
  ];
  for (const c of HEADS) {
    it(`another head of a note's ${c.field}: ${c.name}: bundle_malformed, nothing written`, async () => {
      const { b, bundle, note } = await updated();
      withHead(noteRow(bundle, note), c.field, c.value);
      const before = [await notesOn(b), await headsOn(b)];
      const r = await refusalOf(b, bundle);
      expect(r?.code).toBe("bundle_malformed");
      expect(r?.message).toContain(c.says);
      expect([await notesOn(b), await headsOn(b)]).toEqual(before);
    }, 600_000);
  }

  // Review of PR #1940, round 1, point 2: a received check is never stricter than what an honest node may hold. A writer's cap the database does not hold (a title of 500
  // characters) may be exceeded by a row from before the cap reached every write path: such a value is taken, winner or head. Not an order key (round 2, point 2: below).
  it("a value beyond a writer's cap that the database holds (a title of 501 characters), winner or head: taken, and taking it again stores nothing", async () => {
    const { b, bundle, note } = await updated();
    const row = noteRow(bundle, note);
    row.texts.title = "w".repeat(501); row.values.title = row.texts.title;
    withHead(row, "title", "t".repeat(501));
    expect(await refusalOf(b, bundle)).toBeNull();
    // the long title is on B, as the column or as a head
    const long = await onNode(b.node, async () => Number((await q<{ n: string }>(
      `SELECT ((SELECT count(*) FROM content_nodes WHERE id = $1 AND length(title) = 501) + (SELECT count(*) FROM sync_stamp_heads WHERE row_key = $1::text AND field = 'title' AND length(value) = 501))::text AS n`, [note])).rows[0]!.n));
    expect(long).toBeGreaterThan(0);
    expect((await take(b, bundle)).stored).toBe(0);
  }, 600_000);

  // Review of PR #1940, round 2, point 2: every writer of order_key keeps keyBetween's rule (assertOrderKey, isValidOrderKey) and migration 200 filled the column with
  // valid keys, so no honest node holds another; one taken would make keyBetween throw at the next note put after it under that parent (appendOrderKey), for good.
  it("a note's order key that keyBetween does not accept (\"a00\"), as the winner: bundle_malformed, nothing written", async () => {
    const { b, bundle, note } = await updated();
    const row = noteRow(bundle, note);
    row.texts.sort = "a00"; row.values.order_key = "a00";
    const before = [await notesOn(b), await headsOn(b)];
    const r = await refusalOf(b, bundle);
    expect(r?.code).toBe("bundle_malformed");
    expect(r?.message).toContain("not one keyBetween accepts");
    expect([await notesOn(b), await headsOn(b)]).toEqual(before);
  }, 600_000);

  it("a new pointer whose order key keyBetween does not accept (\"~\"): bundle_malformed, no pointer written", async () => {
    const { a, b } = await updated();
    await take(b, await bundleFor(a, b));
    const pointer = await onNode(a.node, async () => {
      const parent = (await a.call("POST", "/api/nodes", { title: "Pointer parent", markdown: "", space_id: a.space })).id as string;
      const target = (await a.call("POST", "/api/nodes", { title: "Pointer target", markdown: "", space_id: a.space })).id as string;
      return (await a.call("POST", "/api/pointers", { target_id: target, parent_id: parent, display_prefix: "see" })).id as string;
    });
    const bundle = await bundleFor(a, b);
    const row = rowsOf(bundle, "note_pointers").find((r) => r.stamps.some((s) => s.rowKey === pointer));
    expect(row, "the bundle carries the new pointer").toBeTruthy();
    row!.texts.sort = "~"; row!.values.order_key = "~";
    const r = await refusalOf(b, bundle);
    expect(r?.code).toBe("bundle_malformed");
    expect(r?.message).toContain("not one keyBetween accepts");
    expect(await onNode(b.node, async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM note_pointers WHERE id = $1`, [pointer])).rows[0]!.n))).toBe(0);
  }, 600_000);

  it("a new note whose carried values are not the units the bundle says: bundle_malformed (before, only the anchors' tables compared them)", async () => {
    const { a, b } = await updated();
    await take(b, await bundleFor(a, b));
    await onNode(a.node, () => a.call("POST", "/api/nodes", { title: "Brand new", markdown: "", space_id: a.space }));
    const bundle = await bundleFor(a, b);
    const row = rowsOf(bundle, "content_nodes").find((r) => r.texts.title === "Brand new")!;
    row.values.title = "Something else";
    const before = await notesOn(b);
    const r = await refusalOf(b, bundle);
    expect(r?.code).toBe("bundle_malformed");
    expect(r?.message).toContain("not the units the bundle says");
    expect(await notesOn(b)).toBe(before);
  }, 600_000);

  it("a new attribute row whose carried source is not one that travels (a `derived` value): bundle_malformed, no value written; a value the text gave (`markdown`, migration 223) is taken", async () => {
    const { a, b } = await updated();
    await take(b, await bundleFor(a, b));
    const host = await onNode(a.node, async () => (await a.call("POST", "/api/nodes", { title: "Valued", markdown: "", space_id: a.space })).id as string);
    await onNode(a.node, () => withEventTransaction(a.ws, () => q(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, 'mood', 'calm', 'text', 'markdown')`, [a.ws, host])));
    const bundle = await bundleFor(a, b);
    const row = rowsOf(bundle, "node_attributes").find((r) => r.stamps.some((st) => st.rowKey === `${host}/mood`));
    expect(row, "the bundle carries the text's value").toBeTruthy();
    const honest = structuredClone(bundle);
    row!.values.source = "derived";
    const r = await refusalOf(b, bundle);
    expect(r?.code).toBe("bundle_malformed");
    expect(r?.message).toContain("source is not one that travels");
    const held = () => onNode(b.node, async () => (await q<{ source: string }>(`SELECT source FROM node_attributes WHERE node_id = $1 AND key = 'mood'`, [host])).rows);
    expect(await held()).toEqual([]);
    await take(b, honest);
    expect(await held()).toEqual([{ source: "markdown" }]);
  }, 600_000);

  it("an element of a set (the module switches) whose value is not the element it names, as a head: bundle_malformed", async () => {
    const { b, bundle } = await updated();
    const row = rowsOf(bundle, "workspaces")[0];
    expect(row, "the bundle carries the workspace's switches").toBeTruthy();
    const off = row!.stamps.find((s) => s.label === "workspaces.modules_off")!;
    off.heads = [...off.heads, { origin: off.origin, seq: off.seq, contentHash: "", wall: off.wall - 1, counter: 0, author: off.author, device: off.device, deleted: false, saw: {}, meta: null, value: `"tasks"` } as never];
    const r = await refusalOf(b, bundle);
    expect(r?.code).toBe("bundle_malformed");
    expect(r?.message).toContain("not the element it names");
  }, 600_000);

  it("a head of the workspace's day start that the table's own CHECK refuses (0 to 6): bundle_malformed, the CHECK read from the database", async () => {
    const { b, bundle } = await updated();
    const row = rowsOf(bundle, "workspaces")[0]!;
    withHead(row, "day_start", "9");
    const r = await refusalOf(b, bundle);
    expect(r?.code).toBe("bundle_malformed");
    expect(r?.message).toContain("a check of the table refuses");
  }, 600_000);

  it("the same bundle unspoiled is taken, and taking it again stores nothing (the checks refuse nothing an honest writer wrote)", async () => {
    const { b, bundle } = await updated();
    expect((await take(b, bundle)).stored).toBeGreaterThan(0);
    expect((await take(b, bundle)).stored).toBe(0);
  }, 600_000);
});

// Review of PR #1940, round 1, point 3: a value of the right form that no column of its type can hold (a date that is no day, an integer out of range, a text too large
// for an index row…) is refused with a code like every other refusal, never with the database's own error. Not listed one by one: every unit of every carried table
// the bundle brings is given the impossible value of its column's type, in each of the three places a value is checked (round 2: the first sweep took only the first):
// the winner of a row B holds (columnProblems), another head of that row (columnProblems, as the head's unit), and a row B does not hold yet, its carried values and its
// unit texts both (carriedValuesDiffer, which casts them: the same 25P02 when a failed cast was caught outside a savepoint). Taken or refused with a `bundle_` code.
describe.skipIf(!isTestDb)("a value no column of its type can hold, for every unit of every carried table: a coded refusal, never a raw database error", () => {
  it("each type: a date that is no day, a number out of range, a boolean that is none, an id that is none, an incompressible text of 300,000 characters; as a winner, a head and a new row", async () => {
    const [na, nb, nc] = [await openNode("a"), await openNode("b"), await openNode("c")];
    open.push(na, nb, nc);
    const world = await buildSourceWorld(na);
    const snapshot = await capture(na, world, 1_000_000);
    await fillFrom(nb, world, snapshot);
    await fillFrom(nc, world, snapshot);
    // B takes A's writes and is given values for rows it holds; C never takes any, so A's new rows stay new to it
    const a = peerOf("A", na, world), b = peerOf("B", nb, world), c = peerOf("C", nc, world);
    await admit(a, b); await admit(a, c);
    const rng = makeRng(31);
    await writeFor(a, rng, 20, { weights: ALL_TABLES });
    expect(await writeEachRowKind(a, rng)).toEqual([]);
    // the bundle to C carries rows C does not hold (new rows: carriedValuesDiffer); which ones, C's own stamps say
    const first = await bundleFor(a, c);
    const held = await onNode(c.node, async () => new Set((await q<{ k: string }>(
      `SELECT split_part(table_name, '.', 1) || ' ' || row_key AS k FROM sync_stamps WHERE workspace_id = $1 AND field = '*'`, [c.ws])).rows.map((r) => r.k)));
    const rowKeyOf = (r: Row) => r.stamps.find((s) => s.field === "*")?.rowKey ?? r.stamps[0]!.rowKey;
    await exchange(a, b);
    // the same rows written again on A, so the bundle carries rows B holds (the winner of an existing row is written into its column)
    await writeFor(a, rng, 20, { weights: ALL_TABLES });
    expect(await writeEachRowKind(a, rng)).toEqual([]);
    const bundle = await bundleFor(a, b);
    const types = await onNode(b.node, async () => new Map((await q<{ t: string; c: string; ty: string }>(
      `SELECT c.relname::text AS t, a.attname::text AS c, format_type(a.atttypid, a.atttypmod) AS ty FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped`)).rows.map((r) => [`${r.t}.${r.c}`, r.ty] as const)));
    const noise = Array.from({ length: 300_000 }, (_, i) => String.fromCharCode(0x4e00 + ((i * 7919 + i * i) % 20000))).join("");
    const impossible = (ty: string): string | null =>
      /^timestamp|^date/.test(ty) ? "2026-02-30T00:00:00Z" : /^(integer|smallint|bigint)/.test(ty) ? "99999999999999999999" : /^(double|real|numeric)/.test(ty) ? "1e999"
        : ty === "boolean" ? "maybe" : ty === "uuid" ? "00000000-0000-4000-8000-00000000000g" : ty === "jsonb" ? null : noise;
    const tried: Record<"winner" | "head" | "new row", string[]> = { winner: [], head: [], "new row": [] };
    const raw: string[] = [];
    for (const src of UNIT_SOURCES) {
      const existing = bundle.items.find((i): i is Row => i.kind === "row" && i.table === src.table);
      const fresh = first.items.find((i): i is Row => i.kind === "row" && i.table === src.table && !held.has(`${src.table} ${rowKeyOf(i)}`) && Object.keys(i.values ?? {}).length > 0);
      for (const [field, column] of Object.entries(src.fields)) {
        if (field === "deleted") continue;
        const columns = column.split("+");
        const values = columns.map((c) => impossible(types.get(`${src.table}.${c}`) ?? "text"));
        if (values.every((v) => v === null)) continue;
        const text = columns.length > 1 ? JSON.stringify(Object.fromEntries(columns.map((c, k) => [c, values[k] ?? null]))) : values[0]!;
        const places: Array<["winner" | "head" | "new row", ChangeBundle, Row | undefined, (r: Row) => void]> = [
          ["winner", bundle, existing, (r) => {
            r.texts[field] = text;
            columns.forEach((c, k) => { if (values[k] !== null) r.values[c] = values[k]; });
            if (!r.stamps.some((s) => s.field === field)) { const star = r.stamps.find((s) => s.field === "*")!; r.stamps.push({ ...star, field, saw: {}, meta: null, heads: [] }); }
          }],
          ["head", bundle, existing, (r) => withHead(r, field, text)],
          // a new row: its carried values and the unit text the bundle says, both the impossible value (so only the cast can refuse it)
          ["new row", first, fresh, (r) => { r.texts[field] = text; columns.forEach((c, k) => { if (values[k] !== null) r.values[c] = values[k]; }); }],
        ];
        for (const [place, from, row, spoil] of places) {
          if (!row) continue;
          // on a new row only a value whose cast fails (C must take nothing, or A's rows would no longer be new to it): a text that is merely large is a winner's and a head's case
          if (place === "new row" && values.some((v) => v === noise)) continue;
          const copy = JSON.parse(JSON.stringify(from)) as ChangeBundle;
          spoil(copy.items.find((i): i is Row => i.kind === "row" && i.table === src.table && rowKeyOf(i) === rowKeyOf(row))!);
          tried[place].push(`${src.label}.${field}`);
          const code = await take(place === "new row" ? c : b, copy).then(() => "taken", (e: { code?: string; message?: string }) => e.code ?? `no code: ${String(e.message).slice(0, 120)}`);
          if (place === "new row" ? code !== "bundle_malformed" : code !== "taken" && !code.startsWith("bundle_")) raw.push(`${place} ${src.label}.${field}: ${code}`);
        }
      }
    }
    console.log(`[impossible values] ${Object.entries(tried).map(([p, u]) => `${p}: ${u.length} units`).join("; ")}`);
    expect(tried.winner.length).toBeGreaterThan(15);
    expect(tried.head.length).toBeGreaterThan(15);
    expect(tried["new row"].length).toBeGreaterThan(5);
    expect(raw).toEqual([]);
  }, 1_800_000);
});
