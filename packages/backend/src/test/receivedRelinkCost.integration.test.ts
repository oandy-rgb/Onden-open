// What the links INTO the notes a change bundle made cost the node that takes it (issue #2021; services/receivedDerivation.ts → services/wikilinkEdges.ts
// relinkTarget): the rows read must grow with the bundle and the notes that link to its names, never with the rest of the workspace. Counted as the database
// counts them (rows read: sequential and index fetches, by table), never as time.
// SAFETY: databases made from the migrated template (PGlite, or new databases on a `_test` server); nothing shared is touched.
// realPostgresAlso: a server's planner and its statistics, not PGlite's
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { dbDriver, q, withTransaction } from "../db.js";
import { withRequestDevice } from "../requestContext.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { stampTransaction } from "../spine/stamps.js";
import { indexMissingNoteLinks } from "../services/wikilinkEdges.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode, type SourceWorld } from "./helpers/stampedWorld.js";
import { admit, bundleFor, peerOf, take } from "./helpers/stampedBundleWorld.js";
import { awaitCountsOfEveryConnection } from "./helpers/statisticsOfEveryConnection.js";
import { receivedDerivation, setReceivedDerivation } from "../spine/receivedDerivation.js";
import { LONG_TITLE } from "./helpers/longTitle.js";
import { LINK_LOOKUP_TABLES, expectOverHalfAWholeRead, expectUnderHalfAWholeRead, largestRows, linkReadsCanTell, minusRows, readEachWhole, rowsReadByTable, showLinkRows, sumRows, wholeReads, type Rows } from "./helpers/rowsRead.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

/** Rows read so far on `node`, by table, every connection's counts in. */
const rowsOn = (node: RealNode): Promise<Rows> => onNode(node, async () => { await awaitCountsOfEveryConnection(); return rowsReadByTable(); });

/** One stamped transaction on the sender, as its owner. */
const onSender = (world: SourceWorld, write: () => Promise<void>) =>
  withRequestDevice(randomUUID(), () => withTransaction(() => withEventTransaction(world.ws, async () => { await stampTransaction(world.ws, world.owner.id); await write(); })));

/** Raw notes in the sender's first space, in one stamped transaction. */
async function insertNotes(world: SourceWorld, notes: ReadonlyArray<{ title: string; slug: string; markdown: string }>): Promise<void> {
  await onSender(world, async () => {
    await q(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id)
             SELECT gen_random_uuid(), $1, 'manual', 'content', x.title, x.slug, x.markdown, $2 FROM unnest($3::text[], $4::text[], $5::text[]) AS x(title, slug, markdown)`,
    [world.ws, world.spaceA, notes.map((n) => n.title), notes.map((n) => n.slug), notes.map((n) => n.markdown)]);
  });
}

/** Raw notes in the sender's first space: title `${prefix} ${i}`, slug `${prefix}-${i}`, `body(i)`, made `200` a transaction. */
async function makeNotes(world: SourceWorld, count: number, prefix: string, body: (i: number) => string): Promise<void> {
  for (let done = 0; done < count; done += 200) {
    await insertNotes(world, Array.from({ length: Math.min(200, count - done) }, (_, k) => ({ title: `${prefix} ${done + k}`, slug: `${prefix}-${done + k}`, markdown: body(done + k) })));
  }
}

/** `rows`: what taking the bundle read (the control's injected reads not in it); `derived`: what its derivation read; `control`: the derivation's window with
 *  the injected reads in (derivationRows); `whole`: one read of each link table whole on the receiver after (wholeReads). */
type Cost = { made: number; others: number; rows: Rows; derived: Rows; control: Rows; edges: number; whole: Rows };

/** The negative control's injection: one read of each link table whole for every this many notes of the bundle (at least one), the look-up the bounds forbid,
 *  in the shape a batch of relinkTarget of this many targets that read each table whole once a batch would have. */
const INJECTED_EVERY = 200;

/** The rows read by the derivation alone (services/receivedDerivation.ts, after the merge, in the bundle's transaction), by table, while `run` takes a bundle
 *  of `made` notes: this transaction's counts around the slot's `after` (the merge's own reads are not the derivation's). `control`: the same window, counted
 *  the same way, with the forbidden look-up run in it after the derivation (readEachWhole, ⌈made / INJECTED_EVERY⌉ times): the negative control's numbers,
 *  from the same bundle. */
async function derivationRows(workspaceId: string, made: number, run: () => Promise<unknown>): Promise<{ derived: Rows; control: Rows }> {
  const real = receivedDerivation()!;
  const xact = () => rowsReadByTable("pg_stat_xact_user_tables");
  let derived: Rows = new Map(), control: Rows = new Map();
  setReceivedDerivation({ before: real.before, after: async (prepared, bundle) => {
    const from = await xact();
    await real.after(prepared, bundle);
    derived = minusRows(await xact(), from);
    await readEachWhole(workspaceId, LINK_LOOKUP_TABLES, Math.ceil(made / INJECTED_EVERY));
    control = minusRows(await xact(), from);
  } });
  try { await run(); } finally { setReceivedDerivation(real); }
  return { derived, control };
}

/** Two nodes of one world: A, with `linkers` notes made by `beforeJoin` (made before B joins, so B has them: an indexed link index, as a server's start-up leaves
 *  it), and B, joined by snapshot and admitted. */
async function twoNodes(beforeJoin: (world: SourceWorld) => Promise<void>) {
  const na = await openNode("a"), nb = await openNode("b");
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  await onNode(na, () => beforeJoin(world));
  await fillFrom(nb, world, await capture(na, world, 1_000_000));
  await onNode(nb, () => indexMissingNoteLinks({ workspaceId: world.ws }));
  const a = peerOf("A", na, world), b = peerOf("B", nb, world);
  await admit(a, b);
  return { na, nb, world, a, b };
}

/** The receiver holds `others` notes no bundle note is named by, and `linkers` notes that link to two names each of the bundle's notes. Then a bundle that
 *  makes `made` notes, `target 0` …, is taken: the rows the receiver read while it took it, and the wikilink edges into the new notes after. */
async function takeBundle(made: number, others: number, linkers: number): Promise<Cost> {
  const { na, nb, world, a, b } = await twoNodes(async (w) => {
    await makeNotes(w, others, "other", (i) => `other note ${i}, no links`);
    await makeNotes(w, linkers, "linker", (i) => `see [[target ${(i * 7) % made}]] and [[target-${(i * 13 + 1) % made}]]`);
  });
  await onNode(na, () => makeNotes(world, made, "target", (i) => `target note ${i}`));
  await onNode(na, () => awaitCountsOfEveryConnection());
  await onNode(na, () => q(`ANALYZE`));
  const bundle = await bundleFor(a, b);
  await onNode(nb, () => q(`ANALYZE`));
  const start = await rowsOn(nb);
  const { derived, control } = await derivationRows(world.ws, made, () => take(b, bundle));
  const rows = minusRows(await rowsOn(nb), start, minusRows(control, derived));
  const edges = await onNode(nb, async () => Number((await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM node_edges e JOIN content_nodes t ON t.id = e.target_node_id
      WHERE e.workspace_id = $1 AND e.origin = 'wikilink' AND t.title LIKE 'target %'`, [world.ws])).rows[0]!.n));
  const whole = await onNode(nb, () => wholeReads(world.ws, LINK_LOOKUP_TABLES));
  console.log(`[received relink cost] ${dbDriver}: bundle of ${made} notes, ${others} other notes, ${linkers} linking: ${sumRows(rows)} rows (${largestRows(rows, 5)}), ${edges} edges into the new notes; the derivation ${sumRows(derived)} rows (${largestRows(derived, 5)}; ${showLinkRows(derived)}); with ${Math.ceil(made / INJECTED_EVERY)} reads of each whole inside its window (negative control): ${showLinkRows(control)}; one read of each whole: ${showLinkRows(whole)}`);
  return { made, others, rows, derived, control, edges, whole };
}

// The measurements, made once each (by whichever test runs first): a few minutes on PGlite.
let bySize: Promise<Cost> | undefined;
const measureBySize = () => (bySize ??= takeBundle(2000, 0, 200));
let byWorkspace: Promise<[Cost, Cost]> | undefined;
const measureByWorkspace = () => (byWorkspace ??= (async () => [await takeBundle(200, 500, 20), await takeBundle(200, 2000, 20)] as [Cost, Cost])());
let alone: Promise<Cost> | undefined;
const measureAlone = () => (alone ??= takeBundle(200, 0, 20));

/** How many times more the derivation may read each link table for ten times the bundle and the notes linking to it (200 → 2,000 notes, 20 → 200 linking):
 *  linear is 10, a fifth over it is allowed. Not tied to relinkTarget's batch (services/wikilinkEdges.ts RELINK_BATCH): a read of a table that grows with the
 *  bundle once a batch of B targets makes it about 100 times for B ≤ 200 and, on Postgres 18 after migration 241 (node_edges 201 → 2,001 rows, one read of it
 *  whole 41 → 401: public CI run 46134884873), still more than 12 while the bundle of 2,000 takes three batches or more: B = 50 (issue #2021's shape) 49 times,
 *  B = 200 24.8, B = 500 14.9, B = 667 13.2; B = 1,000 (two batches) 11.6 is not caught. Before migration 241 node_edges grew 312 → 17,580 rows, 56 times
 *  (public CI run 46134868353, before-fix branch check/relink-cost-before-fix). A whole read of content_nodes, even once a call, is the next test's. */
const MAX_GROWTH = 12;

/** For each link table: the rows the 200-note bundle's derivation read (`small`), the 2,000-note bundle's (`large`), and how many times more. */
const growthOf = (label: string, small: Rows, large: Rows) => LINK_LOOKUP_TABLES.map((t) => {
  const s = small.get(t) ?? 0, l = large.get(t) ?? 0;
  return { s, ratio: l / s, show: `${label}: ${t} read ${s} → ${l} rows, ${(l / s).toFixed(2)} times; the bound is ${MAX_GROWTH} times` };
});

// The bound of a bundle's size, per link table (a sum over tables was not a bound: on Postgres 18 before migration 241 the derivation of a bundle of 500 → 2,000
// notes read node_edges 1,354 → 17,772 rows, each batch of relinkTarget reading every wikilink edge, the square of the bundle, but node_attributes, read linearly
// (53,500 → 224,500), kept the sum at 3.85 times, under the 4.6 a ratio allowed: public CI run 46127423272, before-fix branch check/relink-cost-before-fix; the
// 10,314 → 49,991 once quoted was measured on a Postgres without pgroonga, not in CI). The smaller bundle is the one the workspace of 500 other notes takes:
// what its derivation reads does not grow with the other notes (the tests below; they link to nothing, so they add no edges and no links to the bundle).
describe.skipIf(!isTestDb)("the links into the notes of a bundle, on the node that takes it", () => {
  it("a bundle of 2,000 new notes, 200 notes linking to them: every link becomes an edge", async () => {
    expect((await measureBySize()).edges).toBe(400);
  }, 1_800_000);

  // Before migration 241 (issue #2021): the edges INTO a batch of targets had no index by target (node_edges_unique_origin_idx starts with the source), so each
  // batch read every wikilink edge of the workspace: node_edges 17,580 rows for the bundle of 2,000, one read of them whole for each of the 40 batches.
  // relinkTarget reads them once a call now (services/wikilinkEdges.ts edgesInto, node_edges_wikilink_target_idx).
  it("bundles of 200 and of 2,000 new notes, 20 and 200 notes linking to them: the derivation reads each link table at most 12 times more for 10 times the bundle", async () => {
    const [small] = await measureByWorkspace();
    const large = await measureBySize();
    for (const g of growthOf("the derivation, a bundle of 200 → 2,000 notes", small.derived, large.derived)) {
      expect(g.s, `${g.show}: the smaller bundle's reads are counted`).toBeGreaterThan(0);
      expect(g.ratio, g.show).toBeLessThanOrEqual(MAX_GROWTH);
    }
  }, 1_800_000);

  // The negative control of that bound (review of PR #2023, round 3): the same two bundles, with one read of each link table whole for every 200 notes of the
  // bundle run inside the derivation's window and counted by the same path (derivationRows): relinkTarget in batches of 200, each reading the tables whole.
  // It means something only on the fixed code: before migration 241 the smaller bundle's own reads are already high (content_nodes 6,608 with the injection,
  // public CI run 46149520494, before-fix branch), so the ratio stays under the bound (6.86 times) and this control is red there. On the fixed code, Postgres
  // 18 (public CI run 46149474858): node_edges 242 → 6,011 (24.8 times), content_nodes 2,094 → 35,751 (17.1), note_link_index 1,671 → 26,366 (15.8).
  it("negative control: the same bundles with one read of each link table whole for every 200 notes inside the derivation's window: that bound is broken for every table", async () => {
    const [small] = await measureByWorkspace();
    const large = await measureBySize();
    for (const g of growthOf("the derivation with the injected reads, a bundle of 200 → 2,000 notes", small.control, large.control)) {
      expect(g.s, `${g.show}: the smaller bundle's reads are counted`).toBeGreaterThan(0);
      expect(g.ratio, `${g.show}: negative control, the forbidden reads ran inside the window, so the bound must be broken`).toBeGreaterThan(MAX_GROWTH);
    }
  }, 1_800_000);

  // Before migration 241 (issue #2021): services/receivedDerivation.ts notesAsTheyAre (`workspace_id = … AND id IN (…)`, twice a bundle) was a sequential
  // read of the workspace's notes, which the planner costs below 200 look-ups by key at a few thousand notes. It now reads one look-up a note
  // (services/wikilinkEdges.ts notesWithIds). The bundle's own reads grow with the bundle, so what is bounded is what 2,000 other notes add to a workspace
  // that holds the bundle alone. Only content_nodes: the other notes link to nothing, so the edges do not grow; the link index is the FINDING below.
  // Not against a workspace of 500 (review of PR #2023, round 4): the planner reads that workspace's notes whole too, so the difference can stay under the
  // bound before the fix: Postgres 18, before-fix branch, 5,873 rows at 500 other notes and 5,827 at 2,000 (two reads of 2,235 rows whole, public CI run
  // 46149520494), where an earlier run of the same code read 5,871 → 8,048 (run 46134868353). Fixed: 1,359 at 500 and 1,353 at 2,000 (run 46149474858).
  // Against the bundle alone (PGlite): before the fix 4,477 → 8,044, 3,567 more, over the bound of 1,000; fixed 1,580 → 1,369, 211 fewer.
  it("the same bundle of 200 notes taken by a workspace that holds it alone and by one with 2,000 other notes: the derivation reads fewer than half a read of the 2,000 more notes more", async () => {
    const small = await measureAlone();
    const [, large] = await measureByWorkspace();
    expect([small.edges, large.edges]).toEqual([40, 40]);
    expectUnderHalfAWholeRead("the derivation, 2,000 other notes against none", { rows: large.derived, whole: large.whole, units: 1, tables: ["content_nodes"],
      baseline: { rows: small.derived, whole: small.whole } });
  }, 1_800_000);

  // The negative control of that bound (review of PR #2023, round 3): the same bundle with one read of content_nodes whole inside the derivation's window, in
  // both workspaces (derivationRows): one look-up of the whole workspace a call, which the bound must catch whatever relinkTarget's batch is.
  it("negative control: the same bundle of 200 notes with one read of content_nodes whole inside the derivation's window, alone and with 2,000 other notes: that bound is broken", async () => {
    const small = await measureAlone();
    const [, large] = await measureByWorkspace();
    expectOverHalfAWholeRead("the derivation with one read of content_nodes whole inside it, 2,000 other notes against none", { rows: large.control, whole: large.whole,
      units: 1, tables: ["content_nodes"], baseline: { rows: small.control, whole: small.whole } });
  }, 1_800_000);

  // Found by the same bound (review of PR #2023, round 2): the link index rows that name the bundle's notes (services/wikilinkEdges.ts indexRowsNaming, once a
  // call of relinkTarget) are one look-up with every key of the 200 notes (their titles, references, slugs: about 600). While the index holds a few thousand rows
  // the planner reads it whole instead of its GIN indexes, rightly by its costs, so the rows read grow with the workspace up to the size where the indexes win:
  // 936 → 2,436 (PGlite, and Postgres 18 in public CI run 46127420639). Recorded in docs/agents/mistakes.md (2026-11-23, issue #2001 point 4 list, item 1).
  it.fails("FINDING: the same bundle of 200 notes taken by a workspace of 500 and of 2,000 other notes: the derivation reads fewer than half a read of the 1,500 more notes' link index rows more (fails today: the look-up of the index rows naming the bundle's ~600 keys reads the whole link index while it holds a few thousand rows)", async () => {
    const [small, large] = await measureByWorkspace();
    const m = { rows: large.derived, whole: large.whole, units: 1, tables: ["note_link_index"], baseline: { rows: small.derived, whole: small.whole } };
    if (!linkReadsCanTell("the link index", m)) return; // a measurement that counts nothing passes this test, so the it.fails is red
    expectUnderHalfAWholeRead("the derivation's link index, 2,000 other notes against 500", m);
  }, 1_800_000);
});

// A title the database holds has no limit of its own (NODE_TITLE_MAX is the writers' cap, not checked on receive: migration 221); the title index keys its first
// 500 characters (migration 241), at most 2,000 bytes, under btree's limit of about 2,700 bytes a row. A received title over that limit is taken whole, and the
// links into its note are found. (A link BY such a title cannot be indexed: the FINDING in wikilinkRelinkIndex.integration.test.ts.)
describe.skipIf(!isTestDb)("a received note whose title is longer than an index row may be", () => {
  it("a bundle that makes a note titled with 700 four-byte characters (2,800 bytes): the note is taken with its whole title, and the note that links to it by its slug gets its edge", async () => {
    const s = randomUUID().slice(0, 8);
    const title = LONG_TITLE;
    expect(Buffer.byteLength(title)).toBe(2800);
    const { na, nb, world, a, b } = await twoNodes((w) => insertNotes(w, [{ title: `linker ${s}`, slug: `linker-${s}`, markdown: `see [[long-${s}]]` }]));
    await onNode(na, () => insertNotes(world, [{ title, slug: `long-${s}`, markdown: "a long title" }]));
    await take(b, await bundleFor(a, b));
    const got = await onNode(nb, async () => (await q<{ title: string; linked: number }>(
      `SELECT t.title, (SELECT count(*)::int FROM node_edges e JOIN content_nodes l ON l.id = e.source_node_id
                         WHERE e.target_node_id = t.id AND e.origin = 'wikilink' AND l.slug = $3) AS linked
         FROM content_nodes t WHERE t.workspace_id = $1 AND t.slug = $2`, [world.ws, `long-${s}`, `linker-${s}`])).rows);
    expect(got).toEqual([{ title, linked: 1 }]);
  }, 300_000);
});
