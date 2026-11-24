// Taking a change bundle in segments (spine/stampedImport.ts receiveChangeBundle, spine/stampedInbox.ts; proposal own-node-transport-2026-11-22.md §2.10, batch 6).
// The properties of §2.10, on two databases that exchange as the other bundle tests do (no transport yet):
//   - the receiving process killed after ANY segment (or after the plan, or half way through the pages), the sender never heard from again: at the next start it
//     ends by itself in a state bit-identical to taking the bundle in one piece (rows, stamps, heads, slugs, derived spaces, what it holds, its clock, its structure log);
//   - a slug handed from one note to another across what would be two segments resolves as in one piece;
//   - while the inbox is not empty, a bundle offered or asked for is answered `peer_busy` and changes nothing; once it is taken, both work again;
//   - a bundle the checks refuse is refused before anything of it is taken, as in one piece, and leaves the inbox empty.
// The seeds are new every run (printed with a failure): a red from a new seed is a finding (README 「接上傳輸前必須完成」).
// SAFETY: databases made from the migrated template (PGlite, or new databases on a `_test` server); nothing shared is touched.
import { randomInt, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { readChangeBundle } from "../services/stampedBundle.js";
import { bundleOf, readHave } from "../spine/stampedBundle.js";
import { applyChangeBundle, receiveChangeBundle, resumeChangeBundles } from "../spine/stampedImport.js";
import { putInboxPage } from "../spine/stampedInbox.js";
import { receivedDerivation, setReceivedDerivation } from "../spine/receivedDerivation.js";
import { unitsAndStamps } from "./helpers/unitsAndStamps.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import type { ChangeBundle, ChangeBundlePage } from "../spine/snapshotSql.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { ALL_TABLES, admit, expectSame, makeRng, markWorld, peerOf, resetRowTurns, writeFor, UPDATED_AT_OF_ATTRIBUTES, type Peer } from "./helpers/stampedBundleWorld.js";
import type { Rng } from "./helpers/distSim/rng.js";
import { stampTransaction } from "../spine/stamps.js";
import { setModulesOn } from "./helpers/setModulesOn.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

class Killed extends Error {}

/** `Date.now()` stands still while `fn` runs: the clock a node takes from a bundle is max(its own, the bundle's highest, now), and "now" must be the same for the two
 *  ways of taking it that are compared. */
async function withNowAt<T>(at: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => at;
  try { return await fn(); } finally { Date.now = real; }
}

/** A source A and a receiver B that joined from A's snapshot and admits A; every module on. */
async function twoPeers(): Promise<{ a: Peer; b: Peer; world: Awaited<ReturnType<typeof buildSourceWorld>> }> {
  const na = await openNode("a"), nb = await openNode("b");
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  const a = peerOf("A", na, world);
  await markWorld(a);
  await fillFrom(nb, world, await capture(na, world, 12_000));
  const b = peerOf("B", nb, world);
  await admit(b, a);
  for (const p of [a, b]) await onNode(p.node, () => setModulesOn(p.ws, null));
  return { a, b, world };
}

/** The pages of A's bundle for B, through JSON as on the wire. */
async function pagesFor(from: Peer, to: Peer, pageBytes?: number): Promise<ChangeBundlePage[]> {
  const have = await onNode(to.node, () => readHave(to.ws));
  return JSON.parse(JSON.stringify(await onNode(from.node, () => readChangeBundle(from.owner, from.ws, have, pageBytes ? { pageBytes } : {})))) as ChangeBundlePage[];
}

/** A copy of `p`'s database right now (the same node: what it would be had it taken the bundle the other way). */
async function copyOf(p: Peer, name: string): Promise<Peer> {
  const node = await RealNode.open(name, p.node!);
  open.push(node);
  return { ...p, name, node };
}

/** What only this node keeps and a bundle moves: what it holds of each origin, its clock, its structure log (per row, in order), its inbox (an outcome row of a bundle
 *  given up is no bundle: `outcome` below), and what a received change derives. NOT compared, and why that is harmless: sync_clock.merge_batches counts the
 *  transactions in which the stamp triggers stood aside (one per segment and one for the plan's checks, against one for a whole bundle): this node's own statistic,
 *  read by nothing that decides; the membership epoch moves once per segment that changed a space or its notes' spaces (not once per bundle): a mirror client
 *  reconciles once more, the readable set it gets is the same. */
async function nodeLocalOf(p: Peer) {
  return onNode(p.node, async () => ({
    origins: (await q(`SELECT origin, vouched_by, have FROM sync_origins WHERE workspace_id = $1 ORDER BY origin`, [p.ws])).rows,
    clock: (await q(`SELECT next_seq::text, hlc_wall::text, hlc_counter FROM sync_clock WHERE workspace_id = $1`, [p.ws])).rows,
    log: (await q(`SELECT row_key, field, old_value, new_value, origin, seq::text, hlc_wall::text, hlc_counter, author, device::text FROM structure_log WHERE workspace_id = $1 ORDER BY row_key, id`, [p.ws])).rows,
    inbox: (await q(`SELECT kind, n FROM sync_inbox WHERE workspace_id = $1 AND kind <> 'outcome'`, [p.ws])).rows,
    // what a received change derives (batch 4a, services/receivedDerivation.ts): no stamp watches these, so the bundle's checks above do not see them
    derived: {
      edges: (await q(`SELECT source_node_id::text, target_node_id::text, status FROM node_edges WHERE workspace_id = $1 AND origin = 'wikilink' ORDER BY 1, 2`, [p.ws])).rows,
      linkIndex: (await q(`SELECT note_id::text, link_lc, link_slug, stale FROM note_link_index WHERE workspace_id = $1 ORDER BY 1, 2, 3`, [p.ws])).rows,
      blockRefs: (await q(`SELECT note_id::text, block_ref FROM note_block_refs WHERE workspace_id = $1 ORDER BY 1, 2`, [p.ws])).rows,
      blockDisplay: (await q(`SELECT id::text, block_ref, kind, label, text_cache, parent_block_id::text, hidden_at IS NOT NULL AS hidden FROM block_nodes WHERE workspace_id = $1 ORDER BY 1`, [p.ws])).rows,
      // this node's own work a received change queues (the backup of a changed text, the hooks), each once
      outbox: (await q(`SELECT effect_kind, dedup_key, payload::text FROM outbox WHERE workspace_id = $1 ORDER BY 1, 2, 3`, [p.ws])).rows,
      // the type of every attribute value (what retypeGoverned writes for the rows whose type is no unit), the tasks of task lines, the versions (a received change mints none)
      attributes: (await q(`SELECT node_id::text, key, value, value_type, source FROM node_attributes WHERE workspace_id = $1 ORDER BY 1, 2`, [p.ws])).rows,
      tasks: (await q(`SELECT b.id::text, b.task_id::text, t.title FROM block_nodes b LEFT JOIN content_nodes t ON t.id = b.task_id WHERE b.workspace_id = $1 ORDER BY 1`, [p.ws])).rows,
      versions: (await q(`SELECT note_id::text, unit, version_key FROM note_versions WHERE workspace_id = $1 ORDER BY 1, 2, 3`, [p.ws])).rows,
    },
  }));
}

/** The bundle this node gave up on, as the person will be told (sync_inbox kind 'outcome'), or null. */
const outcomeOf = (p: Peer) => onNode(p.node, async () => (await q<{ content: unknown }>(`SELECT content FROM sync_inbox WHERE workspace_id = $1 AND kind = 'outcome'`, [p.ws])).rows[0]?.content ?? null);

/** The two nodes hold exactly the same: every carried row, stamp and head (expectSame), and what each keeps of its own (nodeLocalOf). */
async function expectBitIdentical(segmented: Peer, whole: Peer, label: string): Promise<void> {
  await expectSame(segmented, whole, label, [UPDATED_AT_OF_ATTRIBUTES]);
  expect(await nodeLocalOf(segmented), label).toEqual(await nodeLocalOf(whole));
}

/** Take `pages` in segments of `rows` items at most on `p`, the process dying right after segment `killAt` (0: after the plan; null: never), then start again. */
async function takeKilled(p: Peer, pages: ChangeBundlePage[], rows: number, killAt: number | null): Promise<number> {
  let segments = 0;
  await onNode(p.node, () => receiveChangeBundle(p.ws, pages, {
    limits: { rows, bytes: 4 * 1024 * 1024 },
    afterSegment: async (n) => { segments = Math.max(segments, n); if (n === killAt) throw new Killed(`killed after segment ${n}`); },
  })).catch((e: unknown) => { if (!(e instanceof Killed)) throw e; });
  if (killAt !== null) {
    await p.node!.restart();
    const resumed = await onNode(p.node, () => resumeChangeBundles());
    expect(resumed.map((r) => r.outcome)).toEqual(["taken"]);
  }
  return segments;
}

describe.runIf(isTestDb)("a change bundle taken in segments ends as taking it in one piece", () => {
  it("killed after every segment in turn (and after the plan), never hearing from the sender again: each run ends by itself bit-identical to one piece", async () => {
    const seed = randomInt(2 ** 31);
    resetRowTurns();
    const { a, b } = await twoPeers();
    await writeFor(a, makeRng(seed), 30, { weights: ALL_TABLES });
    // enough rows for several segments whatever the seed drew
    await onNode(a.node, async () => { for (let i = 0; i < 12; i++) await a.call("POST", "/api/nodes", { id: randomUUID(), title: `filler ${i}`, markdown: "", space_id: a.space }); });
    const pages = await pagesFor(a, b, 6_000);
    const now = Date.now();
    const whole = await copyOf(b, "b-whole");
    await withNowAt(now, () => onNode(whole.node, () => applyChangeBundle(whole.ws, bundleOf(pages))));
    // how many segments of 6 items at most: one run without a kill
    const probe = await copyOf(b, "b-probe");
    const segments = await withNowAt(now, () => takeKilled(probe, pages, 6, null));
    await expectBitIdentical(probe, whole, `seed ${seed}, not killed`);
    expect(segments, `seed ${seed}: the bundle is taken in more than one segment`).toBeGreaterThan(2);
    console.log(`[inbox] seed ${seed}: ${segments} segments, killed after each of 0..${segments}`);
    for (let k = 0; k <= segments; k++) {
      const run = await copyOf(b, `b-${k}`);
      await withNowAt(now, () => takeKilled(run, pages, 6, k));
      await expectBitIdentical(run, whole, `seed ${seed}, killed after segment ${k} of ${segments}`);
      await run.node!.close();
    }
  }, 600_000);

  it("a random bundle, a random segment size, killed after a random segment: the same as one piece", async () => {
    const seed = randomInt(2 ** 31);
    const rng = makeRng(seed);
    resetRowTurns();
    const { a, b } = await twoPeers();
    await writeFor(a, rng, 60, { weights: ALL_TABLES });
    const pages = await pagesFor(a, b, 1 + Math.floor(rng.next() * 20_000));
    const rows = 1 + Math.floor(rng.next() * 25);
    const now = Date.now();
    const whole = await copyOf(b, "b-whole");
    await withNowAt(now, () => onNode(whole.node, () => applyChangeBundle(whole.ws, bundleOf(pages))));
    // how many segments the real plan makes (with this node's slugs): a run without a kill on a copy
    const probe = await copyOf(b, "b-probe");
    const segments = await withNowAt(now, () => takeKilled(probe, pages, rows, null));
    await probe.node!.close();
    const killAt = Math.floor(rng.next() * (segments + 1));
    await withNowAt(now, () => takeKilled(b, pages, rows, killAt));
    await expectBitIdentical(b, whole, `seed ${seed}, segments of ${rows}, killed after ${killAt}`);
  }, 600_000);

  it("a bundle whose pages did not all arrive when the process died is given up at the next start: nothing of it was taken, and the whole bundle is taken after", async () => {
    const { a, b } = await twoPeers();
    await writeFor(a, makeRng(randomInt(2 ** 31)), 20, { weights: ALL_TABLES });
    const pages = await pagesFor(a, b, 3_000);
    expect(pages.length).toBeGreaterThan(1);
    const before = await copyOf(b, "b-before");
    await onNode(b.node, async () => { for (const page of pages.slice(0, -1)) await withEventTransaction(b.ws, () => putInboxPage(b.ws, page)); });
    await b.node!.restart();
    expect((await onNode(b.node, () => resumeChangeBundles())).map((r) => [r.outcome, r.code])).toEqual([["given up", "bundle_page_missing"]]);
    expect(await outcomeOf(b)).toMatchObject({ code: "bundle_page_missing", sentence: expect.stringMatching(/[\u4e00-\u9fff]/) });
    await expectBitIdentical(b, before, "given up");
    const now = Date.now();
    await withNowAt(now, () => onNode(before.node, () => applyChangeBundle(before.ws, bundleOf(pages))));
    await withNowAt(now, () => takeKilled(b, pages, 5, null));
    await expectBitIdentical(b, before, "taken after");
  }, 300_000);
});

describe.runIf(isTestDb)("a slug handed across segments", () => {
  /** X (a larger id) holds a slug on both nodes; on A it goes to the trash and Y (a smaller id) is made with the same title, so the same slug. Taken in one piece, the trash
   *  frees the slug and Y takes it, X keeps its slug in the trash. Were X and Y in two segments, Y (first in bundle order) would find X still holding it, rename X
   *  (spine/noteSlugs.ts settleSlugs: one of the two gives way) and X would go to the trash with the other slug. */
  it("a note going to the trash and a smaller id taking its slug, with notes between them: the same slugs as in one piece, whatever the segment size", async () => {
    const { a, b } = await twoPeers();
    const x = "f0000000-0000-4000-8000-00000000000f", y = "10000000-0000-4000-8000-000000000001";
    await onNode(a.node, () => a.call("POST", "/api/nodes", { id: x, title: "Handed Slug", markdown: "x", space_id: a.space }));
    const first = await pagesFor(a, b);
    await onNode(b.node, () => applyChangeBundle(b.ws, bundleOf(first)));
    await onNode(a.node, async () => {
      await a.call("DELETE", `/api/nodes/${x}`);
      for (let i = 0; i < 6; i++) await a.call("POST", "/api/nodes", { id: `5000000${i}-0000-4000-8000-000000000000`, title: `between ${i}`, markdown: "", space_id: a.space });
      await a.call("POST", "/api/nodes", { id: y, title: "Handed Slug", markdown: "y", space_id: a.space });
    });
    const pages = await pagesFor(a, b);
    const now = Date.now();
    const whole = await copyOf(b, "b-whole");
    await withNowAt(now, () => onNode(whole.node, () => applyChangeBundle(whole.ws, bundleOf(pages))));
    const slugs = (p: Peer) => onNode(p.node, async () => (await q<{ id: string; slug: string }>(`SELECT id::text, slug FROM content_nodes WHERE id = ANY($1::uuid[]) ORDER BY id`, [[x, y]])).rows);
    expect(await slugs(whole)).toEqual(await onNode(a.node, async () => (await q(`SELECT id::text, slug FROM content_nodes WHERE id = ANY($1::uuid[]) ORDER BY id`, [[x, y]])).rows));
    for (const rows of [1, 2, 3]) {
      const run = await copyOf(b, `b-${rows}`);
      expect(await withNowAt(now, () => takeKilled(run, pages, rows, null))).toBeGreaterThan(1);
      expect(await slugs(run), `segments of ${rows}`).toEqual(await slugs(whole));
      await expectBitIdentical(run, whole, `segments of ${rows}`);
    }
  }, 300_000);
});

describe.runIf(isTestDb)("while the inbox is not empty", () => {
  it("another bundle offered (whole or in pages) or asked for is peer_busy and changes nothing; once the inbox is taken, both go on", async () => {
    const { a, b } = await twoPeers();
    await writeFor(a, makeRng(randomInt(2 ** 31)), 20, { weights: ALL_TABLES });
    const pages = await pagesFor(a, b);
    await onNode(b.node, () => receiveChangeBundle(b.ws, pages, { limits: { rows: 4, bytes: 4 * 1024 * 1024 }, afterSegment: async (n) => { if (n === 1) throw new Killed("killed"); } }))
      .catch((e: unknown) => { if (!(e instanceof Killed)) throw e; });
    const held = await copyOf(b, "b-held");
    // another bundle from A: a write more there
    await onNode(a.node, () => a.call("POST", "/api/nodes", { id: randomUUID(), title: "later", markdown: "", space_id: a.space }));
    const later: ChangeBundle = bundleOf(await pagesFor(a, b));
    const code = (p: Promise<unknown>) => p.then(() => "taken", (e: unknown) => (e as { code?: string }).code);
    expect(await code(onNode(b.node, () => applyChangeBundle(b.ws, later)))).toBe("peer_busy");
    expect(await code(onNode(b.node, () => receiveChangeBundle(b.ws, [{ ...later, page: 1, pages: 1 }])))).toBe("peer_busy");
    expect(await code(onNode(b.node, () => readChangeBundle(b.owner, b.ws, {})))).toBe("peer_busy");
    await expectBitIdentical(b, held, "refused while busy");
    // once taken (as a start would), both go on
    expect((await onNode(b.node, () => resumeChangeBundles())).map((r) => r.outcome)).toEqual(["taken"]);
    expect(await onNode(b.node, () => readChangeBundle(b.owner, b.ws, {}))).not.toHaveLength(0);
    const after = await pagesFor(a, b);
    await onNode(b.node, () => receiveChangeBundle(b.ws, after));
    expect((await nodeLocalOf(b)).inbox).toEqual([]);
  }, 300_000);
});

describe.runIf(isTestDb)("a bundle the checks refuse", () => {
  it("is refused with the code of one piece before any segment is taken, and leaves the inbox empty", async () => {
    const { a, b } = await twoPeers();
    await writeFor(a, makeRng(randomInt(2 ** 31)), 15, { weights: ALL_TABLES });
    // a note of its own, last in bundle order (its id), whatever the seed drew
    const spoilt = "ffffffff-0000-4000-8000-000000000000";
    await onNode(a.node, () => a.call("POST", "/api/nodes", { id: spoilt, title: "to be spoilt", markdown: "", space_id: a.space }));
    const pages = await pagesFor(a, b);
    // that note's title made something its column cannot hold (a value checkReceived refuses), in the last segment
    const bad: ChangeBundlePage[] = JSON.parse(JSON.stringify(pages));
    const row = bad.flatMap((p) => p.items).find((i) => i.kind === "row" && i.table === "content_nodes" && i.stamps.some((s) => s.rowKey === spoilt));
    expect(row).toBeDefined();
    if (row?.kind === "row") row.texts = { ...row.texts, title: null };
    const whole = await copyOf(b, "b-whole");
    const code = (p: Promise<unknown>) => p.then(() => "taken", (e: unknown) => (e as { code?: string }).code);
    const one = await code(onNode(whole.node, () => applyChangeBundle(whole.ws, bundleOf(bad))));
    expect(one).not.toBe("taken");
    expect(await code(onNode(b.node, () => receiveChangeBundle(b.ws, bad, { limits: { rows: 3, bytes: 4 * 1024 * 1024 } })))).toBe(one);
    await expectBitIdentical(b, whole, "refused");
  }, 300_000);
});

describe.runIf(isTestDb)("a refusal while a segment is taken", () => {
  /** What the plan cannot see: something this node writes after it (here a stamp with the same number as one of a later segment's, other content: what a restored copy
   *  would hold). That segment is refused and rolled back; the segments before it stay (each a merge of whole rows), `have` does not move, the inbox is given up; the next
   *  bundle from the sender brings the rest, and the node ends as taking the bundle in one piece. */
  it("rolls that segment back, keeps the ones before, moves no `have`, empties the inbox; the next bundle ends as one piece", async () => {
    const { a, b } = await twoPeers();
    const fillers = Array.from({ length: 12 }, () => randomUUID()).sort();
    await onNode(a.node, async () => { for (const [i, id] of fillers.entries()) await a.call("POST", "/api/nodes", { id, title: `filler ${i}`, markdown: "", space_id: a.space }); });
    const pages = await pagesFor(a, b);
    const last = bundleOf(pages).items.find((i) => i.kind === "row" && i.table === "content_nodes" && i.stamps.some((s) => s.rowKey === fillers.at(-1)))!;
    const star = (last.kind === "row" ? last.stamps : []).find((s) => s.field === "*")!;
    const now = Date.now();
    const whole = await copyOf(b, "b-whole");
    await withNowAt(now, () => onNode(whole.node, () => applyChangeBundle(whole.ws, bundleOf(pages))));
    const before = await nodeLocalOf(b);
    const notes = (p: Peer) => onNode(p.node, async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes WHERE workspace_id = $1`, [p.ws])).rows[0]!.n));
    const notesBefore = await notes(b);
    const plant = (sql: string) => withTransaction(() => q(sql, [b.ws, star.rowKey, star.origin, star.seq, star.wall + 1, star.counter]));
    const refused = await withNowAt(now, () => onNode(b.node, () => receiveChangeBundle(b.ws, pages, {
      limits: { rows: 3, bytes: 4 * 1024 * 1024 },
      afterSegment: async (n) => { if (n === 1) await plant(`INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter) VALUES ($1, 'content_nodes', $2, '*', $3, $4, $5, $6)`); },
    }))).then(() => "taken", (e: unknown) => (e as { code?: string }).code);
    expect(refused).toBe("bundle_stamp_clash");
    const after = await nodeLocalOf(b);
    expect(after.inbox).toEqual([]);
    expect(after.origins).toEqual(before.origins);
    expect(await notes(b)).toBeGreaterThan(notesBefore);
    // the planted stamp gone again (what the node's owner would do), the sender's next bundle brings the rest
    await onNode(b.node, () => withTransaction(() => q(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = '*'`, [b.ws, star.rowKey])));
    const again = await pagesFor(a, b);
    await withNowAt(now, () => takeKilled(b, again, 3, null));
    // the same, but for the clock: the refused try had caught up with the bundle's clock before its later segment was refused (NOT SETTLED, point 1 of round 1: a
    // refused try leaves what it took), and the retry catches up once more; the wall is the same, the counter one higher
    await expectSame(b, whole, "after the refusal, the next bundle", [UPDATED_AT_OF_ATTRIBUTES]);
    const [got, want] = [await nodeLocalOf(b), await nodeLocalOf(whole)];
    expect({ ...got, clock: undefined }).toEqual({ ...want, clock: undefined });
    expect((got.clock[0] as { hlc_wall: string }).hlc_wall).toBe((want.clock[0] as { hlc_wall: string }).hlc_wall);
  }, 300_000);
});

describe.runIf(isTestDb)("what a received change derives (batch 4a), taken in segments", () => {
  /** A note whose `[[link]]` names a note made later in the bundle, so in a later segment: the first segment derives the link to nothing, the later one makes the
   *  target and relinks what names it (wikilinkEdges.ts relinkTarget, the write path's own), as one piece ends. P1 holds in every segment: the derivation of a segment
   *  writes no unit (every unit, stamp and head, and the clock's next number, the same just before it and just after it). */
  it("a link to a note of a later segment ends resolved as in one piece; every segment's derivation writes no unit", async () => {
    const { a, b } = await twoPeers();
    const source = "10000000-0000-4000-8000-00000000000a", target = "f0000000-0000-4000-8000-00000000000b";
    await onNode(a.node, async () => {
      await a.call("POST", "/api/nodes", { id: source, title: "Links Early", markdown: "see [[Late Target]] and {probe-tag} here", space_id: a.space });
      for (let i = 0; i < 6; i++) await a.call("POST", "/api/nodes", { id: `5000000${i}-0000-4000-8000-00000000000c`, title: `between ${i}`, markdown: "", space_id: a.space });
      await a.call("POST", "/api/nodes", { id: target, title: "Late Target", markdown: "the target", space_id: a.space });
    });
    const pages = await pagesFor(a, b);
    const now = Date.now();
    const whole = await copyOf(b, "b-whole");
    await withNowAt(now, () => onNode(whole.node, () => applyChangeBundle(whole.ws, bundleOf(pages))));
    expect((await nodeLocalOf(whole)).derived.edges).toContainEqual({ source_node_id: source, target_node_id: target, status: expect.anything() });
    const real = receivedDerivation()!;
    const pairs: Array<[unknown, unknown]> = [];
    setReceivedDerivation({ before: real.before, after: async (prepared, bundle) => { const was = await unitsAndStamps(bundle.workspaceId); await real.after(prepared, bundle); pairs.push([was, await unitsAndStamps(bundle.workspaceId)]); } });
    try {
      await withNowAt(now, () => takeKilled(b, pages, 2, 1)); // killed after the first segment, the rest taken at the next start
    } finally { setReceivedDerivation(real); }
    expect(pairs.length, "one derivation per segment taken").toBeGreaterThan(2);
    for (const [i, [was, is]] of pairs.entries()) expect(is, `P1: segment ${i + 1}`).toEqual(was);
    await expectBitIdentical(b, whole, "a link across segments");
  }, 300_000);
});

describe.runIf(isTestDb)("a tag a block save made, taken in segments", () => {
  /** A paragraph's `{tag}` that the save made: the tag's mark (`_block_autotag`, derived) is worked out when the tag is taken, from the membership the same write made.
   *  One row per segment and notes between them: the two must still be taken together (seed 2144791958 of the linked-texts test, shrunk). */
  it("ends with the tag's mark as one piece, one row per segment, killed after every segment", async () => {
    const { a, b } = await twoPeers();
    await onNode(a.node, async () => {
      for (let i = 0; i < 3; i++) await a.call("POST", "/api/nodes", { id: `2000000${i}-0000-4000-8000-00000000000d`, title: `before ${i}`, markdown: "", space_id: a.space });
      await a.call("POST", "/api/nodes", { id: "30000000-0000-4000-8000-00000000000e", title: "Tagged", markdown: "a line {made-here}\n\nmore", space_id: a.space });
    });
    const pages = await pagesFor(a, b);
    const now = Date.now();
    const whole = await copyOf(b, "b-whole");
    await withNowAt(now, () => onNode(whole.node, () => applyChangeBundle(whole.ws, bundleOf(pages))));
    expect((await nodeLocalOf(whole)).derived.attributes.filter((r) => (r as { key: string }).key === "_block_autotag"), "the one-piece copy marks the tag").toHaveLength(1);
    const probe = await copyOf(b, "b-probe");
    const segments = await withNowAt(now, () => takeKilled(probe, pages, 1, null));
    await expectBitIdentical(probe, whole, "one row per segment, not killed");
    await probe.node!.close();
    for (let k = 1; k < segments; k++) {
      const run = await copyOf(b, `b-${k}`);
      await withNowAt(now, () => takeKilled(run, pages, 1, k));
      await expectBitIdentical(run, whole, `one row per segment, killed after segment ${k} of ${segments}`);
      await run.node!.close();
    }
  }, 600_000);
});

/** Random writes on `p` whose texts link to each other by title (`[[…]]`, also to a title made only later), carry a tag (`{…}`, made by the block save) and a task line,
 *  and that rename, trash and restore notes: what the derivation of a received change works on (batch 4a). Through the routes, as the owner. */
async function writeLinked(p: Peer, rng: Rng, count: number): Promise<void> {
  const notes: { id: string; title: string; live: boolean }[] = [];
  const title = () => `Linked ${rng.int(12)}`;
  const body = () => `see [[${title()}]] and [[${title()}]] {lk-${rng.int(3)}}\n\n- [ ] item ${rng.int(1000)} {task}\n\nmore`;
  await onNode(p.node, async () => {
    for (let i = 0; i < count; i++) {
      const live = notes.filter((n) => n.live), dead = notes.filter((n) => !n.live);
      const op = live.length === 0 ? 0 : rng.int(10);
      try {
        if (op <= 3) { const n = { id: randomUUID(), title: title(), live: true }; await p.call("POST", "/api/nodes", { id: n.id, title: n.title, markdown: body(), space_id: p.space }); notes.push(n); }
        else if (op <= 5) { const n = rng.pick(live); await p.call("PATCH", `/api/nodes/${n.id}`, { markdown: body() }); }
        else if (op === 6) { const n = rng.pick(live); n.title = title(); await p.call("PATCH", `/api/nodes/${n.id}`, { title: n.title }); }
        else if (op <= 8) { const n = rng.pick(live); await p.call("DELETE", `/api/nodes/${n.id}`); n.live = false; }
        else if (dead.length) { const n = rng.pick(dead); await p.call("POST", `/api/nodes/${n.id}/undelete`); n.live = true; }
      } catch { /* a write the route refuses (a slug taken, a title in use) is part of the run */ }
    }
  });
}

describe.runIf(isTestDb)("what is derived from texts that link to each other, taken in segments", () => {
  it("random texts with links (to notes made, renamed, trashed and restored in the same bundle), tags and task lines; killed after every segment: the same links, tasks, types and rows as one piece", async () => {
    const seed = randomInt(2 ** 31);
    const { a, b } = await twoPeers();
    const rng = makeRng(seed);
    await writeLinked(a, rng, 12);
    const first = await pagesFor(a, b);
    await onNode(b.node, () => applyChangeBundle(b.ws, bundleOf(first)));
    await writeLinked(a, rng, 30);
    const pages = await pagesFor(a, b);
    const now = Date.now();
    const whole = await copyOf(b, "b-whole");
    await withNowAt(now, () => onNode(whole.node, () => applyChangeBundle(whole.ws, bundleOf(pages))));
    const probe = await copyOf(b, "b-probe");
    const segments = await withNowAt(now, () => takeKilled(probe, pages, 3, null));
    await expectBitIdentical(probe, whole, `seed ${seed}, not killed`);
    await probe.node!.close();
    for (let k = 0; k <= segments; k += Math.max(1, Math.floor(segments / 6))) {
      const run = await copyOf(b, `b-${k}`);
      await withNowAt(now, () => takeKilled(run, pages, 3, k));
      await expectBitIdentical(run, whole, `seed ${seed}, killed after segment ${k} of ${segments}`);
      await run.node!.close();
    }
  }, 900_000);
});

describe.runIf(isTestDb)("killed while planning, or saving between segments", () => {
  it("killed after a part of the plan was written, then planned again at the next start with larger segments: the old plan's extra segments go, and it ends as one piece", async () => {
    const { a, b } = await twoPeers();
    await writeFor(a, makeRng(randomInt(2 ** 31)), 25, { weights: ALL_TABLES });
    await onNode(a.node, async () => { for (let i = 0; i < 12; i++) await a.call("POST", "/api/nodes", { id: randomUUID(), title: `filler ${i}`, markdown: "", space_id: a.space }); });
    const pages = await pagesFor(a, b);
    const now = Date.now();
    const whole = await copyOf(b, "b-whole");
    await withNowAt(now, () => onNode(whole.node, () => applyChangeBundle(whole.ws, bundleOf(pages))));
    await withNowAt(now, () => onNode(b.node, () => receiveChangeBundle(b.ws, pages, {
      limits: { rows: 1, bytes: 4 * 1024 * 1024 }, afterPlanStep: async (step) => { if (step === "segment 5") throw new Killed("killed while planning"); },
    })).catch((e: unknown) => { if (!(e instanceof Killed)) throw e; }));
    expect((await nodeLocalOf(b)).inbox.filter((r) => (r as { kind: string }).kind === "segment")).toHaveLength(5);
    await b.node!.restart();
    expect((await withNowAt(now, () => onNode(b.node, () => resumeChangeBundles()))).map((r) => r.outcome)).toEqual(["taken"]);
    await expectBitIdentical(b, whole, "planned again");
  }, 300_000);

  it("a save between two segments (the person renames a note the bundle renames too): it is stamped after every write of the bundle, wins on this node, and both nodes end the same", async () => {
    const { a, b } = await twoPeers();
    const shared = randomUUID();
    await onNode(a.node, () => a.call("POST", "/api/nodes", { id: shared, title: "Shared", markdown: "", space_id: a.space }));
    const first = await pagesFor(a, b);
    await onNode(b.node, () => applyChangeBundle(b.ws, bundleOf(first)));
    await onNode(a.node, async () => {
      await a.call("PATCH", `/api/nodes/${shared}`, { title: "Renamed on A" });
      for (let i = 0; i < 12; i++) await a.call("POST", "/api/nodes", { id: randomUUID(), title: `filler ${i}`, markdown: "", space_id: a.space });
    });
    const pages = await pagesFor(a, b);
    const highest = Math.max(...bundleOf(pages).items.flatMap((i) => (i.kind === "row" ? i.stamps : [i.stamp]).map((s) => s.wall)));
    await onNode(b.node, () => receiveChangeBundle(b.ws, pages, { limits: { rows: 2, bytes: 4 * 1024 * 1024 }, afterSegment: async (n) => {
      if (n === 1) await b.call("PATCH", `/api/nodes/${shared}`, { title: "Renamed on B between segments" });
    } }));
    const wall = await onNode(b.node, async () => Number((await q<{ w: string }>(`SELECT hlc_wall::text AS w FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = 'title'`, [b.ws, shared])).rows[0]!.w));
    expect(wall).toBeGreaterThanOrEqual(highest);
    await admit(a, b);
    const back = await pagesFor(b, a);
    await onNode(a.node, () => applyChangeBundle(a.ws, bundleOf(back)));
    const forth = await pagesFor(a, b);
    await onNode(b.node, () => applyChangeBundle(b.ws, bundleOf(forth)));
    const titles = await Promise.all([a, b].map((p) => onNode(p.node, async () => (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [shared])).rows[0]!.title)));
    expect(titles).toEqual(["Renamed on B between segments", "Renamed on B between segments"]);
    await expectSame(a, b, "after the save between segments", [UPDATED_AT_OF_ATTRIBUTES]);
  }, 300_000);
});

describe.runIf(isTestDb)("an inbox that does not get through, and what it takes", () => {
  it("a segment that fails without a refusal is tried again by every runner; after five failures the inbox is given up, the person has one plain sentence, and the node takes and sends bundles again", async () => {
    const { a, b } = await twoPeers();
    await onNode(a.node, async () => { for (let i = 0; i < 8; i++) await a.call("POST", "/api/nodes", { id: randomUUID(), title: `stuck ${i}`, markdown: "", space_id: a.space }); });
    const pages = await pagesFor(a, b);
    const real = receivedDerivation()!;
    // a failure of the database that may pass (a serialization failure: SQLSTATE 40001), every time a segment after the first is taken (not rehearsed): the first
    // segment is in when the inbox is given up (what the rehearsal cannot see: README of spine/stampedMerge)
    let segment = 0, rehearsing = false;
    setReceivedDerivation({ before: async (ws, items) => { if (!rehearsing) segment++; if (segment >= 2) throw Object.assign(new Error("could not serialize access"), { code: "40001" }); return real.before(ws, items); }, after: real.after });
    const notes = async () => Number((await onNode(b.node, () => q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes WHERE workspace_id = $1`, [b.ws]))).rows[0]!.n);
    const notesBefore = await notes();
    try {
      const first = await onNode(b.node, () => receiveChangeBundle(b.ws, pages, { limits: { rows: 3, bytes: 4 * 1024 * 1024 }, rehearsal: { around: async (when) => { rehearsing = when === "start"; } } }))
        .then(() => "taken", (e: unknown) => (e as { code?: string }).code);
      expect(first).toBe("40001");
      for (let i = 0; i < 3; i++) await onNode(b.node, () => resumeChangeBundles()).catch(() => undefined);
      expect((await nodeLocalOf(b)).inbox.length, "still waiting after four failures").toBeGreaterThan(0);
      await onNode(b.node, () => resumeChangeBundles()).catch(() => undefined);
    } finally { setReceivedDerivation(real); }
    expect((await nodeLocalOf(b)).inbox).toEqual([]);
    expect(await outcomeOf(b)).toMatchObject({ code: "inbox_attempts_spent", sentence: expect.stringContaining("只收進了其中一部分") });
    expect(await notes(), "the first segment stays").toBeGreaterThan(notesBefore);
    // not busy any more: it reads a bundle for another node, and takes the next one
    expect(await onNode(b.node, () => readChangeBundle(b.owner, b.ws, {}))).not.toHaveLength(0);
    const again = await pagesFor(a, b);
    await onNode(b.node, () => receiveChangeBundle(b.ws, again));
    expect((await nodeLocalOf(b)).inbox).toEqual([]);
  }, 300_000);

  it("a page or a bundle larger than the inbox takes is refused (bundle_too_large) and nothing of it is kept", async () => {
    const { a, b } = await twoPeers();
    await onNode(a.node, () => a.call("POST", "/api/nodes", { id: randomUUID(), title: "padded", markdown: "", space_id: a.space }));
    const [page] = await pagesFor(a, b);
    // a page of more than INBOX_LIMITS.pageBytes: one item padded with a long text
    const big = JSON.parse(JSON.stringify(page!.items[0])) as { texts?: Record<string, string> };
    big.texts = { ...big.texts, pad: "x".repeat(9 * 1024 * 1024) };
    const huge: ChangeBundlePage = { ...page!, items: [...page!.items, big as never] };
    const code = await onNode(b.node, () => receiveChangeBundle(b.ws, [huge])).then(() => "taken", (e: unknown) => (e as { code?: string }).code);
    expect(code).toBe("bundle_too_large");
    expect((await nodeLocalOf(b)).inbox).toEqual([]);
  }, 300_000);

  it("an inbox planned under another node id (the database was restored and took a new one) is given up at the next start, not taken", async () => {
    const { a, b } = await twoPeers();
    await onNode(a.node, async () => { for (let i = 0; i < 6; i++) await a.call("POST", "/api/nodes", { id: randomUUID(), title: `restored ${i}`, markdown: "", space_id: a.space }); });
    const pages = await pagesFor(a, b);
    await onNode(b.node, () => receiveChangeBundle(b.ws, pages, { limits: { rows: 2, bytes: 4 * 1024 * 1024 }, afterSegment: async (n) => { if (n === 0) throw new Killed("killed"); } }))
      .catch((e: unknown) => { if (!(e instanceof Killed)) throw e; });
    // what a restore under a new id leaves: the header names the old id
    await onNode(b.node, () => withTransaction(() => q(`UPDATE sync_inbox SET content = jsonb_set(content, '{node}', to_jsonb($2::text)) WHERE workspace_id = $1 AND kind = 'header'`, [b.ws, randomUUID()])));
    expect((await onNode(b.node, () => resumeChangeBundles())).map((r) => [r.outcome, r.code])).toEqual([["given up", "inbox_node_changed"]]);
    expect((await nodeLocalOf(b)).inbox).toEqual([]);
  }, 300_000);
});

describe.runIf(isTestDb)("each segment rehearsed before the first one writes (review of PR #1987, round 1, point 1, option A)", () => {
  /** What the trust line asks (docs/decisions/sync-trust-line.md: a refused bundle changes nothing) for what only writing finds: a unique key the sources do not declare,
   *  a derivation that fails. Each segment is taken once alone and rolled back before the first one writes: a refusal there refuses the whole bundle, as in one piece. */
  it("a unique key no source declares, hit by a row of a later segment and a row here: refused with the code of one piece, and nothing of the bundle is kept", async () => {
    const { a, b } = await twoPeers();
    const note = randomUUID();
    await onNode(a.node, () => a.call("POST", "/api/nodes", { id: note, title: "Keyed", markdown: "", space_id: a.space }));
    const first = await pagesFor(a, b);
    await onNode(b.node, () => applyChangeBundle(b.ws, bundleOf(first)));
    await onNode(b.node, () => q(`CREATE UNIQUE INDEX test_inbox_label_uq ON block_nodes (note_id, label)`));
    const row = (p: Peer, ref: string) => onNode(p.node, () => withTransaction(() => withEventTransaction(p.ws, async () => {
      await stampTransaction(p.ws, p.owner.id);
      await q(`INSERT INTO block_nodes (id, workspace_id, note_id, block_ref, anchor_id, kind, label, text_cache) VALUES ($1, $2, $3, $4, NULL, 'paragraph', 'p', 'p')`, [randomUUID(), p.ws, note, ref]);
    })));
    await row(b, "u-b");
    await onNode(a.node, async () => { for (let i = 0; i < 8; i++) await a.call("POST", "/api/nodes", { id: randomUUID(), title: `before ${i}`, markdown: "", space_id: a.space }); });
    await row(a, "u-a");
    const pages = await pagesFor(a, b);
    const whole = await copyOf(b, "b-whole");
    const one = await onNode(whole.node, () => applyChangeBundle(whole.ws, bundleOf(pages))).then(() => "taken", (e: unknown) => (e as { code?: string }).code);
    expect(one).toBe("bundle_unique_clash");
    const seg = await onNode(b.node, () => receiveChangeBundle(b.ws, pages, { limits: { rows: 2, bytes: 4 * 1024 * 1024 } })).then(() => "taken", (e: unknown) => (e as { code?: string }).code);
    expect(seg).toBe(one);
    await expectBitIdentical(b, whole, "refused in a later segment");
  }, 300_000);

  it("a derivation that fails for a note of a later segment: refused with the code of one piece, and nothing of the bundle is kept", async () => {
    const { a, b } = await twoPeers();
    const failing = "ffffffff-0000-4000-8000-0000000000ff";
    await onNode(a.node, async () => {
      for (let i = 0; i < 8; i++) await a.call("POST", "/api/nodes", { id: randomUUID(), title: `before ${i}`, markdown: "", space_id: a.space });
      await a.call("POST", "/api/nodes", { id: failing, title: "fails to derive", markdown: "x", space_id: a.space });
    });
    const pages = await pagesFor(a, b);
    const real = receivedDerivation()!;
    setReceivedDerivation({ before: real.before, after: async (prepared, bundle) => {
      if (bundle.units.some((u) => u.address.row === failing)) throw new Error("this note's links cannot be worked out");
      return real.after(prepared, bundle);
    } });
    try {
      const whole = await copyOf(b, "b-whole");
      const one = await onNode(whole.node, () => applyChangeBundle(whole.ws, bundleOf(pages))).then(() => "taken", (e: unknown) => (e as { code?: string }).code);
      expect(one).toBe("bundle_derivation_failed");
      const seg = await onNode(b.node, () => receiveChangeBundle(b.ws, pages, { limits: { rows: 2, bytes: 4 * 1024 * 1024 } })).then(() => "taken", (e: unknown) => (e as { code?: string }).code);
      expect(seg).toBe(one);
      await expectBitIdentical(b, whole, "refused in a later segment");
    } finally { setReceivedDerivation(real); }
  }, 300_000);
});

/** Every row of the workspace in every table that has a workspace_id, outbox and domain events included: in the caller's node context (a hook of the take runs there). */
async function everyRowOf(ws: string): Promise<Record<string, string[]>> {
  const tables = (await q<{ t: string }>(`SELECT DISTINCT c.table_name AS t FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((r) => r.t);
  const out: Record<string, string[]> = {};
  for (const t of tables) out[t] = (await q<{ r: string }>(`SELECT to_jsonb(x)::text AS r FROM "${t}" x WHERE x.workspace_id = $1 ORDER BY 1`, [ws])).rows.map((r) => r.r);
  return out;
}

describe.runIf(isTestDb)("what a rehearsal does and does not do", () => {
  /** A rehearsal is the segment's take rolled back: the merge, every write-time check and the derivation run, and nothing of them stays: not a row of any table of the
   *  workspace (the outbox and the events among them), not a commit hook (the outbox's drain runs on commit only: spine/txHooks.ts). The real take then queues what it
   *  queues, once. */
  it("leaves every row of the workspace, the outbox and the events as they were; the take after it writes them once", async () => {
    const { a, b } = await twoPeers();
    await onNode(a.node, async () => { for (let i = 0; i < 6; i++) await a.call("POST", "/api/nodes", { id: randomUUID(), title: `rehearsed ${i}`, markdown: `text ${i} {rh-tag}\n\n- [ ] a task ${i}`, space_id: a.space }); });
    const pages = await pagesFor(a, b);
    const at: Partial<Record<"start" | "end", Record<string, string[]>>> = {};
    let rehearsed = 0;
    await onNode(b.node, () => receiveChangeBundle(b.ws, pages, { limits: { rows: 2, bytes: 4 * 1024 * 1024 }, rehearsal: {
      around: async (when) => { at[when] = await everyRowOf(b.ws); },
      before: async () => { rehearsed++; },
    } }));
    expect(rehearsed, "every segment was rehearsed").toBeGreaterThan(2);
    expect(at.end, "the rehearsals left no row anywhere").toEqual(at.start);
    const after = await onNode(b.node, () => everyRowOf(b.ws));
    expect(after.content_nodes!.length, "the take wrote the notes").toBeGreaterThan(at.start!.content_nodes!.length);
  }, 300_000);

  /** A segment that names a row an earlier segment makes runs, rehearsed alone, without that row: its rehearsal may be refused and proves nothing. The merge itself
   *  keeps a row whose parent is not here yet (it hangs until the parent comes), so what fails here is a derivation that reads the parent (this test's own, wrapped
   *  around the real one). The bundle is not refused for it: it is taken, as in one piece. */
  it("does not refuse a bundle for the rehearsal of a segment that leans on an earlier one (new notes under a new parent, one row per segment)", async () => {
    const { a, b } = await twoPeers();
    const parent = "90000000-0000-4000-8000-0000000000a1";
    await onNode(a.node, async () => {
      await a.call("POST", "/api/nodes", { id: parent, title: "A new parent", markdown: "", space_id: a.space });
      for (let i = 0; i < 4; i++) {
        const child = `9000000${i + 1}-0000-4000-8000-0000000000b2`;
        await a.call("POST", "/api/nodes", { id: child, title: `child ${i}`, markdown: `child text ${i} {lean-tag}`, parent_id: parent });
        // an attribute of a new note: a row of its own, in a later segment than the note, and nothing without it
        await a.call("PUT", `/api/nodes/${child}/attributes/status`, { value: `s${i}` });
      }
    });
    const pages = await pagesFor(a, b);
    const now = Date.now();
    const whole = await copyOf(b, "b-whole");
    await withNowAt(now, () => onNode(whole.node, () => applyChangeBundle(whole.ws, bundleOf(pages))));
    const refusedRehearsals: Array<{ n: number; leans: boolean; code?: string }> = [];
    const real = receivedDerivation()!;
    setReceivedDerivation({ before: real.before, after: async (prepared, bundle) => {
      for (const u of bundle.units) {
        if (u.address.table !== "content_nodes" || !u.address.row.startsWith("9000000")) continue;
        const has = (await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [parent])).rows.length;
        if (!has) throw new Error("a child's derivation reads its parent");
      }
      return real.after(prepared, bundle);
    } });
    try {
      await withNowAt(now, () => onNode(b.node, () => receiveChangeBundle(b.ws, pages, { limits: { rows: 1, bytes: 4 * 1024 * 1024 }, rehearsal: {
        refused: async (n, leans, e) => { refusedRehearsals.push({ n, leans, code: (e as { code?: string }).code }); },
      } })));
    } finally { setReceivedDerivation(real); }
    expect(refusedRehearsals.length, "a child's rehearsal without its parent was refused").toBeGreaterThan(0);
    expect(refusedRehearsals.every((r) => r.leans && r.code === "bundle_derivation_failed"), "only segments that lean on an earlier one").toBe(true);
    await expectBitIdentical(b, whole, "taken after rehearsals that proved nothing");
  }, 300_000);
});

/**
 * What the rehearsal cannot see (README of spine/stampedMerge, 「接上傳輸前必須完成」): a refusal that exists only once an earlier segment's rows are in. The segments
 * before the refusing one stay. Pinned as it is today, with what that state must be: (i) every segment kept passed every check of taking a bundle, so it is what a
 * legal smaller bundle (those segments) taken in one piece leaves; (ii) what this node holds of the sender (`have`) does not move, and the same bundle offered again is
 * refused again and takes nothing more; (iii) the person reads that it was not all taken and what to do next (§5.1's words); (iv) this node's own writes, and the
 * bundles it sends, go on: nothing waits for the refused bundle.
 */
async function expectLeftAsASmallerBundle(b: Peer, a: Peer, pages: ChangeBundlePage[], run: (options: Parameters<typeof receiveChangeBundle>[2]) => Promise<string>, one: string): Promise<void> {
  const small = await copyOf(b, "b-small");
  const before = await nodeLocalOf(b);
  let plan: Array<{ n: number; content: ChangeBundle["items"] }> = [];
  let refusedAt = 0;
  const code = await run({
    limits: { rows: 1, bytes: 4 * 1024 * 1024 },
    afterSegment: async (n) => { if (n === 0) plan = (await q<{ n: number; content: ChangeBundle["items"] }>(`SELECT n, content FROM sync_inbox WHERE workspace_id = $1 AND kind = 'segment' ORDER BY n`, [b.ws])).rows; },
    inSegment: async (n) => { refusedAt = n; },
  });
  expect(code, "refused with the code of one piece").toBe(one);
  const kept = plan.filter((s) => s.n < refusedAt);
  expect(kept.length, "segments were taken before the refusing one").toBeGreaterThan(0);
  // (i) the state of a legal smaller bundle taken in one piece
  await onNode(small.node, () => applyChangeBundle(small.ws, { ...bundleOf(pages), items: kept.flatMap((s) => s.content) }));
  await expectSame(b, small, "(i) what a bundle of the segments kept leaves", [UPDATED_AT_OF_ATTRIBUTES]);
  // (iii) the person's sentence: not all of it, and what next; no technical word
  const outcome = await outcomeOf(b) as { code: string; sentence: string };
  expect(outcome.code).toBe(one);
  expect(outcome.sentence).toContain("只收進了其中一部分");
  expect(outcome.sentence).toContain("更新到最新版本");
  expect(outcome.sentence).not.toMatch(/[A-Za-z_]/);
  // (ii) `have` did not move; offered again, refused again, nothing more taken
  const left = await nodeLocalOf(b);
  expect(left.origins, "(ii) have").toEqual(before.origins);
  expect(left.inbox, "the inbox is empty").toEqual([]);
  expect(await run({ limits: { rows: 1, bytes: 4 * 1024 * 1024 } }), "(ii) offered again").toBe(one);
  await expectSame(b, small, "(ii) nothing more after the second try", [UPDATED_AT_OF_ATTRIBUTES]);
  expect((await nodeLocalOf(b)).origins, "(ii) have, after the second try").toEqual(before.origins);
  // (iv) a save on this node, and a bundle it sends, go on
  const own = randomUUID();
  await onNode(b.node, () => b.call("POST", "/api/nodes", { id: own, title: "written after the refusal", markdown: "", space_id: b.space }));
  await admit(a, b);
  const back = await pagesFor(b, a);
  await onNode(a.node, () => applyChangeBundle(a.ws, bundleOf(back)));
  expect(await onNode(a.node, async () => (await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [own])).rows.length), "(iv) the node's own write reached the other").toBe(1);
}

describe.runIf(isTestDb)("what the rehearsal cannot see: refused once an earlier segment is in (pinned as it is)", () => {
  /** Two new notes of the bundle that clash on a unique key no source declares (a node of another version has it; an honest node of the same version cannot make
   *  such a bundle: its own database would have refused the second note). Each rehearsed alone passes; the second is refused when the first is in. */
  it("two rows of the bundle in two segments clash on a key no source declares: the first segment stays, (i)–(iv) hold", async () => {
    const { a, b } = await twoPeers();
    await onNode(b.node, () => q(`CREATE UNIQUE INDEX test_inbox_twin_uq ON content_nodes (workspace_id, title) WHERE title = 'Twin'`));
    await onNode(a.node, async () => {
      await a.call("POST", "/api/nodes", { id: "a0000000-0000-4000-8000-0000000000c1", title: "Twin", markdown: "", space_id: a.space });
      for (let i = 0; i < 3; i++) await a.call("POST", "/api/nodes", { id: `a000000${i + 2}-0000-4000-8000-0000000000c1`, title: `between ${i}`, markdown: "", space_id: a.space });
      await a.call("POST", "/api/nodes", { id: "a0000009-0000-4000-8000-0000000000c1", title: "Twin", markdown: "", space_id: a.space });
    });
    const pages = await pagesFor(a, b);
    const whole = await copyOf(b, "b-whole");
    const one = await onNode(whole.node, () => applyChangeBundle(whole.ws, bundleOf(pages))).then(() => "taken", (e: unknown) => (e as { code?: string }).code ?? String(e));
    expect(one).toBe("bundle_unique_clash");
    await expectLeftAsASmallerBundle(b, a, pages, (options) => onNode(b.node, () => receiveChangeBundle(b.ws, pages, options)).then(() => "taken", (e: unknown) => (e as { code?: string }).code ?? String(e)), one);
  }, 300_000);

  /** A segment that leans on an earlier one (a child under a parent the bundle makes) and is refused for its own sake (its title clashes with a note here on a key no
   *  source declares): its rehearsal without the parent proves nothing, so the parent's segment is taken before the child's is refused. */
  it("a segment that leans on an earlier one and is refused for its own sake: the earlier segment stays, (i)–(iv) hold", async () => {
    const { a, b } = await twoPeers();
    await onNode(a.node, () => a.call("POST", "/api/nodes", { id: "b0000000-0000-4000-8000-0000000000d1", title: "Taken here", markdown: "", space_id: a.space }));
    const first = await pagesFor(a, b);
    await onNode(b.node, () => applyChangeBundle(b.ws, bundleOf(first)));
    await onNode(b.node, () => q(`CREATE UNIQUE INDEX test_inbox_taken_uq ON content_nodes (workspace_id, title) WHERE title = 'Taken here'`));
    const parent = "b0000001-0000-4000-8000-0000000000d1";
    await onNode(a.node, async () => {
      await a.call("POST", "/api/nodes", { id: parent, title: "New parent", markdown: "", space_id: a.space });
      await a.call("POST", "/api/nodes", { id: "b0000002-0000-4000-8000-0000000000d1", title: "Taken here", markdown: "", parent_id: parent });
    });
    const pages = await pagesFor(a, b);
    const whole = await copyOf(b, "b-whole");
    const one = await onNode(whole.node, () => applyChangeBundle(whole.ws, bundleOf(pages))).then(() => "taken", (e: unknown) => (e as { code?: string }).code ?? String(e));
    expect(one).toBe("bundle_unique_clash");
    const leaning: boolean[] = [];
    await expectLeftAsASmallerBundle(b, a, pages, (options) => onNode(b.node, () => receiveChangeBundle(b.ws, pages, { ...options, rehearsal: { refused: async (_n, leans) => { leaning.push(leans); } } }))
      .then(() => "taken", (e: unknown) => (e as { code?: string }).code ?? String(e)), one);
    expect(leaning.length > 0 && leaning.every((l) => l), "the child's rehearsal was refused, and the child's segment leans on the parent's").toBe(true);
  }, 300_000);
});
