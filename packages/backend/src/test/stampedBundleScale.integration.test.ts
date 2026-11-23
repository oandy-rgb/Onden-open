// Taking a bundle costs time in proportion to its size (review of PR #1758, item 1; mixed across tables since batch 2b-2a). The first version took 17.5 s for 1,000 rows and 438 s for 10,000: every statement compared the row id as TEXT
// (`id::text = $1`), which keeps the primary key's index from being used, so each of the ~40 statements per row scanned the table; the rows of a bundle were also matched to their stamps with a filter per row.
// This fails when the cost per row grows with the size again: a bundle four times as large must not make the database read more than 4.6 times the rows (linear is 4; before batch 2b-2a fixed it, 15×). stampedBundle.guard.test.ts also forbids the text comparison itself, which this size alone shows only in part.
// SAFETY: databases made from the migrated template (PGlite, or new databases on a `_test` server); nothing shared is touched.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { withRequestDevice } from "../requestContext.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { stampTransaction } from "../spine/stamps.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, bundleFor, peerOf, take } from "./helpers/stampedBundleWorld.js";
import { refreshSenderStatistics } from "../spine/senderStatistics.js";
import { UNIT_SOURCES } from "../spine/stampedMerge/index.js";
import { awaitCountsOfEveryConnection } from "./helpers/statisticsOfEveryConnection.js";

/** The tables a bundle reads (spine/stampedBundle.ts BUNDLE_READ_TABLES). */
const BUNDLE_READ_TABLES = ["sync_stamps", "sync_stamp_heads", ...new Set(UNIT_SOURCES.map((s) => s.table))];
import { cpuMs } from "../../../markdown/src/linearTiming.testing.js";

import { rowsRead } from "./helpers/rowsRead.js";
const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? ""); // both engines: a node is a PGlite, or a database of the real server (helpers/distSim/postgresNodes.ts)
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });


/** `readRows` / `applyRows`: rows the database read while the bundle was read on A / taken on B (rowsRead). `applyCpuMs` is this thread's CPU time (PGlite runs in this thread, so it is the merge's and the database's work); a busy machine stretches only the wall clock (`applyMs`). */
type Cost = { stamps: number; readMs: number; readRows: number; applyMs: number; applyCpuMs: number; applyRows: number; peakMb: number };

/** A bundle of about `stamps` creation stamps, a third each of notes, attributes on them and tags applied to them (the tables of batch 2b-2a), read from A and taken by B. */
/** `senderAnalyzed`: the sender's statistics are current when it reads (ANALYZE just before, as autovacuum keeps a server); false: taken once, right after its world was made, never again. */
/** `withAnchors`: each note also has an anchor on its body, its anchors unit (note_anchor_places, made at commit) and a paragraph row (migration 215: they travel), so a sixth
 *  each of notes, attributes, tags, anchors, anchors units and paragraph rows. */
/** `"never"`: the sender has no statistics at all when it reads (every table it reads as if never analyzed: a desktop or browser node, which has no autovacuum). */
async function cost(stamps: number, senderAnalyzed: boolean | "never" = true, withAnchors = false): Promise<Cost> {
  const per = withAnchors ? 6 : 3;
  const notes = Math.ceil(stamps / per);
  const na = await openNode("a"), nb = await openNode("b");
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  // a node whose statistics were taken once, when it was small, and never again (a browser node without its own maintenance): the plans then are those of a small table
  if (senderAnalyzed === false) await onNode(na, () => q(`ANALYZE`));
  await fillFrom(nb, world, await capture(na, world, 1_000_000));
  const a = peerOf("A", na, world), b = peerOf("B", nb, world);
  await admit(a, b);
  const tag = randomUUID();
  await onNode(na, async () => {
    await withRequestDevice(randomUUID(), () => withTransaction(() => withEventTransaction(world.ws, async () => {
      await stampTransaction(world.ws, world.owner.id);
      await q(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, $2, 'manual', 'class_tag', 'scale tag', 'scale-tag', '')`, [tag, world.ws]);
    })));
    for (let done = 0; done < notes; done += 200) {
      await withRequestDevice(randomUUID(), () => withTransaction(() => withEventTransaction(world.ws, async () => {
        await stampTransaction(world.ws, world.owner.id);
        const ids = (await q<{ id: string }>(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id)
                 SELECT gen_random_uuid(), $1, 'manual', 'content', 'scale ' || g, 'scale-' || $3::int || '-' || g, 'body ' || g, $2 FROM generate_series(1, $4::int) g RETURNING id::text`,
        [world.ws, world.spaceA, done, Math.min(200, notes - done)])).rows.map((r) => r.id);
        await q(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) SELECT $1, x::uuid, 'scale', 'v', 'ui' FROM unnest($2::text[]) x`, [world.ws, ids]);
        await q(`INSERT INTO node_tags (node_id, tag_id) SELECT x::uuid, $2 FROM unnest($1::text[]) x`, [ids, tag]);
        if (withAnchors) {
          // an anchor on the whole body, measured on it (the hash guard of migration 215 checks it), and the paragraph row it names
          await q(`INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote)
                   SELECT $1, 'sc' || replace(c.id::text, '-', ''), c.id, 0, length(c.markdown), encode(sha256(convert_to(c.markdown, 'UTF8')), 'hex'), c.markdown FROM content_nodes c WHERE c.id = ANY($2::uuid[])`, [world.ws, ids]);
          await q(`INSERT INTO block_nodes (workspace_id, note_id, block_ref, anchor_id, kind, label, text_cache)
                   SELECT $1, c.id, 'sc' || replace(c.id::text, '-', ''), 'sc' || replace(c.id::text, '-', ''), 'paragraph', c.markdown, c.markdown FROM content_nodes c WHERE c.id = ANY($2::uuid[])`, [world.ws, ids]);
        }
      })));
    }
  });
  // every write's change count is in before the sender's statistics are set (helpers/statisticsOfEveryConnection.ts: one sent after an ANALYZE reads as changed since it)
  await onNode(na, () => awaitCountsOfEveryConnection());
  // the sender's statistics are current, as autovacuum keeps them on a server (PGlite has no autovacuum: PR, 需要決定). The receiver needs nothing: a merge brings its own up to date (dbRows.ts)
  if (senderAnalyzed === true) await onNode(na, () => q(`ANALYZE`));
  if (senderAnalyzed === "never") await onNode(na, () => forgetStatistics());
  const readStart = await rowsRead(na);
  let t = performance.now();
  const bundle = await bundleFor(a, b);
  const readMs = performance.now() - t;
  const readRows = (await rowsRead(na)) - readStart;
  const applyStart = await rowsRead(nb);
  let peak = process.memoryUsage().rss;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
  const base = process.memoryUsage().rss;
  t = performance.now();
  const cpu = cpuMs();
  const report = await take(b, bundle);
  const applyCpuMs = cpuMs() - cpu;
  const applyMs = performance.now() - t;
  clearInterval(sampler);
  const applyRows = (await rowsRead(nb)) - applyStart;
  expect(report.created).toBe(notes * per + 1);
  return { stamps: notes * per + 1, readMs, readRows, applyMs, applyCpuMs, applyRows, peakMb: Math.round((peak - base) / 1e6) };
}

/** The sender's tables as if never analyzed: no statistics rows, and the planner's row count unknown (`reltuples = -1`, what a new table has). The test role owns the catalog
 *  (PGlite is a superuser; the real Postgres of the tests is the database's owner and a superuser). */
async function forgetStatistics(): Promise<void> {
  await q(`DELETE FROM pg_statistic WHERE starelid = ANY(SELECT oid FROM pg_class WHERE relname = ANY($1::text[]) AND relnamespace = 'public'::regnamespace)`, [BUNDLE_READ_TABLES]);
  await q(`UPDATE pg_class SET reltuples = -1, relpages = 0 WHERE relname = ANY($1::text[]) AND relnamespace = 'public'::regnamespace AND relkind = 'r'`, [BUNDLE_READ_TABLES]);
}

// The bound: four times the stamps read at most 4 × 1.15 times the rows (linear, with room for the fixed part of a run). Time is printed, never asserted: on a shared
// machine the wall clock and even this thread's CPU time stretched under a parallel suite (the CPU ratio was 5.25 and 5.29 in two runs of five, alone 4.07), with the same work.
const MAX_ROWS_RATIO = 4 * 1.15;

describe.skipIf(!isTestDb)("the cost of reading and taking a bundle grows in proportion to its size", () => {
  it("four times the stamps, mixed across notes, attributes and tags, make the database read at most 4.6 times the rows, to read the bundle and to take it (ONDEN_BUNDLE_COST_REPORT=1 also prints 10,000)", async () => {
    const small = await cost(1000);
    const large = await cost(4000);
    const show = (c: Cost) => `${c.stamps} stamps: read ${c.readRows} rows / ${Math.round(c.readMs)} ms, apply ${c.applyRows} rows / ${Math.round(c.applyCpuMs)} ms CPU`;
    console.log(`[bundle cost] ${show(small)}; ${show(large)}`);
    expect(large.readRows / small.readRows, `reading: ${show(small)}; ${show(large)}`).toBeLessThanOrEqual(MAX_ROWS_RATIO);
    expect(large.applyRows / small.applyRows, `taking: ${show(small)}; ${show(large)}`).toBeLessThanOrEqual(MAX_ROWS_RATIO);
    if (process.env.ONDEN_BUNDLE_COST_REPORT === "1") {
      const big = await cost(10_000);
      console.log(`[bundle cost] ${show(big)}; per stamp ${(big.applyCpuMs / big.stamps).toFixed(2)} ms CPU`);
    }
  }, 900_000);

  // Notes with anchors and paragraph rows (migration 215): the same bound, the two new tables mixed in.
  it("four times the stamps, with anchors and paragraph rows mixed in, read at most 4.6 times the rows to read the bundle and to take it", async () => {
    const small = await cost(1000, true, true);
    const large = await cost(4000, true, true);
    const show = (c: Cost) => `${c.stamps} stamps: read ${c.readRows} rows, apply ${c.applyRows} rows / ${Math.round(c.applyCpuMs)} ms CPU`;
    console.log(`[bundle cost, with anchors] ${show(small)}; ${show(large)}`);
    expect(large.readRows / small.readRows, `reading: ${show(small)}; ${show(large)}`).toBeLessThanOrEqual(MAX_ROWS_RATIO);
    expect(large.applyRows / small.applyRows, `taking: ${show(small)}; ${show(large)}`).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 900_000);

  // The sender that READS a bundle needs statistics: a desktop or browser node (PGlite, no autovacuum) has none of its own. Before the sender made them current itself
  // (spine/senderStatistics.ts), a sender with NONE planned on chance: in 5 runs of the test below without that, three read 14.4 times the rows for four times the stamps
  // (node_tags through the tag's index: every key reads all rows of the same tag) and two read 0.5 times (PR #1778, round 2).
  it("a sender with no statistics at all: the read analyzes the tables it reads first, four times the stamps read at most 4.6 times the rows, and none is stale after", async () => {
    const small = await cost(1000, "never");
    const large = await cost(4000, "never");
    console.log(`[bundle cost, sender never analyzed] read ${small.readRows} → ${large.readRows} rows (${(large.readRows / small.readRows).toFixed(1)}×)`);
    expect(large.readRows / small.readRows).toBeLessThanOrEqual(MAX_ROWS_RATIO);
    expect(await onNode(open.at(-2)!, () => withTransaction(() => refreshSenderStatistics(BUNDLE_READ_TABLES)))).toEqual([]); // nothing left to analyze
  }, 900_000);

  // Taken ONCE, while the node was small, and never again: the rows changed since then pass autovacuum's line, so the read analyzes them again (the same bound).
  it("a sender whose statistics were taken once, while it was small, and never again: four times the stamps read at most 4.6 times the rows", async () => {
    const small = await cost(1000, false);
    const large = await cost(4000, false);
    console.log(`[bundle cost, sender analyzed once while small] read ${small.readRows} → ${large.readRows} rows (${(large.readRows / small.readRows).toFixed(1)}×)`);
    expect(large.readRows / small.readRows).toBeLessThanOrEqual(MAX_ROWS_RATIO);
  }, 900_000);

  // Statistics a server keeps current (autovacuum's line not passed): the read analyzes nothing, so a server's read costs what it did before.
  it("a sender whose statistics are current analyzes nothing before it reads", async () => {
    const na = await openNode("a");
    open.push(na);
    await buildSourceWorld(na);
    // current = analyzed after every change was counted: a count a connection sends after the ANALYZE (seconds after its write: helpers/statisticsOfEveryConnection.ts) would read as a change since it (#1991)
    await onNode(na, () => awaitCountsOfEveryConnection());
    await onNode(na, () => q(`ANALYZE`));
    expect(await onNode(na, () => withTransaction(() => refreshSenderStatistics(BUNDLE_READ_TABLES)))).toEqual([]);
  }, 900_000);

  // The other direction (review of PR #1996, point 2): statistics current, then far more than autovacuum's line written to some tables. Each of those, and
  // only those, is analyzed before the read, exactly once (the database's own count of analyses), and nothing is stale after.
  it("a sender whose statistics are stale analyzes each stale table exactly once before it reads, and no other", async () => {
    const na = await openNode("a");
    open.push(na);
    const world = await buildSourceWorld(na);
    await onNode(na, () => awaitCountsOfEveryConnection());
    await onNode(na, () => q(`ANALYZE`));
    await onNode(na, () => withRequestDevice(randomUUID(), () => withTransaction(() => withEventTransaction(world.ws, async () => {
      await stampTransaction(world.ws, world.owner.id);
      const ids = (await q<{ id: string }>(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
               SELECT $1, 'manual', 'content', 'stale ' || g, 'stale-' || g, 'body ' || g, $2 FROM generate_series(1, 3000) g RETURNING id::text`, [world.ws, world.spaceA])).rows.map((r) => r.id);
      await q(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) SELECT $1, x::uuid, 'stale', 'v', 'ui' FROM unnest($2::text[]) x`, [world.ws, ids]);
    }))));
    await onNode(na, () => awaitCountsOfEveryConnection());
    const analyses = () => onNode(na, async () => {
      await awaitCountsOfEveryConnection();
      const r = await q<{ t: string; n: string }>(`SELECT relname::text AS t, analyze_count::text AS n FROM pg_stat_user_tables WHERE relname = ANY($1::text[])`, [BUNDLE_READ_TABLES]);
      return new Map(r.rows.map((x) => [x.t, Number(x.n)]));
    });
    const before = await analyses();
    const analyzed = await onNode(na, () => withTransaction(() => refreshSenderStatistics(BUNDLE_READ_TABLES)));
    const after = await analyses();
    expect(analyzed).toEqual(["content_nodes", "node_attributes", "sync_stamps"]);
    for (const t of new Set(BUNDLE_READ_TABLES)) expect(after.get(t)! - before.get(t)!, t).toBe(analyzed.includes(t) ? 1 : 0);
    expect(await onNode(na, () => withTransaction(() => refreshSenderStatistics(BUNDLE_READ_TABLES)))).toEqual([]);
  }, 900_000);

  // Review of PR #1940, round 1, point 4: the change count is in the cumulative statistics, which PGlite drops on every reopen (measured: 5,100 changes before a clean close,
  // 0 after, and the same after a killed process) and PostgreSQL after an unclean shutdown. Analyzed once while small, then grown, then the counts lost (pg_stat_reset: what
  // a reopen leaves): the table's size against the pages of its last analysis still says it changed, and the read analyzes it.
  it("a sender analyzed while small that grew, after its change counts were lost (a reopen): the tables that grew are analyzed before the read", async () => {
    const na = await openNode("a");
    open.push(na);
    const world = await buildSourceWorld(na);
    await onNode(na, () => q(`ANALYZE`));
    await onNode(na, () => withRequestDevice(randomUUID(), () => withTransaction(() => withEventTransaction(world.ws, async () => {
      await stampTransaction(world.ws, world.owner.id);
      await q(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
               SELECT $1, 'manual', 'content', 'grown ' || g, 'grown-' || g, 'a body long enough to fill pages ' || repeat('x', 200) || g, $2 FROM generate_series(1, 3000) g`, [world.ws, world.spaceA]);
    }))));
    await onNode(na, async () => { await awaitCountsOfEveryConnection(); await q(`SELECT pg_stat_reset()`); await q(`SELECT pg_stat_clear_snapshot()`); }); // no count of the grown rows arrives after the reset
    const analyzed = await onNode(na, () => withTransaction(() => refreshSenderStatistics(BUNDLE_READ_TABLES)));
    expect(analyzed).toEqual(expect.arrayContaining(["content_nodes", "sync_stamps"]));
    expect(await onNode(na, () => withTransaction(() => refreshSenderStatistics(BUNDLE_READ_TABLES)))).toEqual([]); // and then nothing is stale
  }, 900_000);
  // Review of PR #1940, round 1, point 1: an offline import of 5,000 notes on a desktop node, some with long bodies, reaches the server as one bundle. The received checks
  // read it in parts (dbRows.ts inParts, at most 4 MB of JSON a statement) and find each row once (no search of the whole bundle per row): it is taken. Time printed.
  it("a bundle of 5,000 new notes, twenty of them with bodies of 400,000 characters: taken, every note made (time printed)", async () => {
    const na = await openNode("a"), nb = await openNode("b");
    open.push(na, nb);
    const world = await buildSourceWorld(na);
    await fillFrom(nb, world, await capture(na, world, 1_000_000));
    const a = peerOf("A", na, world), b = peerOf("B", nb, world);
    await admit(a, b);
    await onNode(na, () => withRequestDevice(randomUUID(), () => withTransaction(() => withEventTransaction(world.ws, async () => {
      await stampTransaction(world.ws, world.owner.id);
      await q(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
               SELECT $1, 'manual', 'content', 'imported ' || g, 'imported-' || g, CASE WHEN g <= 20 THEN repeat('a long imported body ', 19048) ELSE 'an imported body ' || repeat('words ', 300) || g END, $2
                 FROM generate_series(1, 5000) g`, [world.ws, world.spaceA]);
    }))));
    const bundle = await bundleFor(a, b);
    const t = performance.now();
    const report = await take(b, bundle);
    console.log(`[bundle cost, import of 5,000 notes] ${Math.round(JSON.stringify(bundle).length / 1e6)} MB taken in ${Math.round(performance.now() - t)} ms`);
    expect(report.created).toBe(5000);
  }, 900_000);
});
