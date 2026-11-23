// A snapshot carries a note's versions (history-replication proposal §3.1, §3.4, §4.3, batch 3; spine/historyLayer.ts): the properties of the batch table, row 3,
// and the review of PR #1988 round 1.
//   * a third node joining by snapshot holds exactly its source's version set (keys, identity fields, content hashes, positions); no map of events is copied;
//     the same from a source whose history is the one migration 220 made of old data (g:, b:, set_aside, removed versions);
//   * a transfer of the history part cut at EVERY page boundary and resumed (every page again, or from the next one; the same file uploaded again, cut at every
//     line of its history part) ends the same and rewrites nothing;
//   * a page whose content does not match its hash, or that brings a held version with another identity, or that breaks any other rule, is refused whole and the
//     database is unchanged (every row compared, not counted), also when the bad item comes after good ones;
//   * the joiner is usable before the history part has arrived; a node whose history part is arriving is no snapshot source;
//   * an honest source never leaves the history part stuck: a writer removed since, a note deleted for good on the joiner meanwhile, the cleanup taking received
//     content between two pages; and the person can stop waiting;
//   * content travels by hash and is never sent or stored twice; a purge on the joiner keeps the content a received version still names (text and drawings).
// Random draws use a fresh seed every run (printed; a red is a finding: shrink it and pin it, never retry or pin the seed).
// realPostgresAlso: the history part is read in a read snapshot of its own after the rows; on Postgres the rows' snapshot and the writes beside it are two connections
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbDriver, migrate, q } from "../db.js";
import { setEnvironment } from "../config.js";
import { INK_CHUNK_THRESHOLD } from "../services/inkChunks.js";
import { chunkInk } from "../services/inkChunker.js";
import { MAX_INK_CHUNK_CHARS, checkHistoryItems, type HistoryItem, type HistoryPage } from "../spine/historyLayer.js";
import { readHistoryPages, snapshotSourceNode } from "../services/stampedSnapshot.js";
import { applyJoinPage, databaseJoinReadiness, finishHistory, joinProgress, stopWaitingForHistory } from "../services/stampedJoin.js";
import { collectOrphanBlobs } from "../services/maintenance/prune.js";
import { removeActor } from "../services/actors.js";
import { localNodeId } from "../spine/stamps.js";
import type { ActorCtx } from "../types.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import {
  buildSourceWorld, capture, captureHistory, exportAs, fillFrom, makeCaller, openNode, outOfScopeIds, snapshotApp,
  type Capture, type HistoryCapture, type SourceWorld,
} from "./helpers/stampedWorld.js";
type WireVersion = Extract<HistoryItem, { kind: "version" }>["version"];
/** The owner's decision (§10 question 4): the browser version keeps the drawings' history only under 50 MB. */
const BROWSER_INK_LIMIT = 50 * 1024 * 1024; // the threshold the owner decided (2026-11-22), written out: the test holds the number, not the constant

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? ""); // both engines: a node is a PGlite, or a database of the real server (helpers/distSim/postgresNodes.ts)
const backend = resolve(import.meta.dirname, "../..");

type Version = Record<string, unknown> & { note_id: string; unit: string; version_key: string; positions: [string, string][] };
type World = Pick<SourceWorld, "ws" | "owner">;

/** Every version of the workspace on `node` with every field of note_versions and its positions; `of`: only these notes. */
const versionsOn = (node: RealNode, ws: string, of?: string[]) => onNode(node, async () => (await q<Version>(
  `SELECT v.note_id::text, v.unit, v.version_key, v.kind, v.title, v.content_hash, v.at, v.clock_wall::text, v.clock_counter, v.ordinal, v.recorded_by, v.author_kind,
          v.author_id::text, v.restored_from, v.source_name,
          (SELECT jsonb_agg(jsonb_build_array(p.origin, p.seq::text) ORDER BY p.origin, p.seq) FROM note_version_positions p
            WHERE p.note_id = v.note_id AND p.unit = v.unit AND p.version_key = v.version_key) AS positions
     FROM note_versions v WHERE v.workspace_id = $1 ${of ? "AND v.note_id::text = ANY($2::text[])" : ""}
    ORDER BY v.note_id, v.unit COLLATE "C", v.version_key COLLATE "C"`, of ? [ws, of] : [ws])).rows);

/** Every row the history part writes, whole, and the join's record of it: "the database is unchanged" is these being EQUAL (not their counts). */
const everything = (node: RealNode, ws: string) => onNode(node, async () => (await q<{ t: string; r: string }>(
  `SELECT 'v' AS t, to_jsonb(v)::text AS r FROM note_versions v WHERE workspace_id = $1
   UNION ALL SELECT 'p', to_jsonb(p)::text FROM note_version_positions p WHERE workspace_id = $1
   UNION ALL SELECT 'b', hash || '/' || md5(content) FROM blobs
   UNION ALL SELECT 'c', node_id || '/' || hash || '/' || md5(content) FROM ink_chunks WHERE workspace_id = $1
   UNION ALL SELECT 'm', node_id || '/' || hash || '/' || md5(chunks) FROM ink_manifests WHERE workspace_id = $1
   UNION ALL SELECT 'j', (to_jsonb(j) - 'started_at')::text FROM sync_join j WHERE workspace_id = $1
   ORDER BY 1, 2`, [ws])).rows.map((r) => `${r.t} ${r.r}`));

/** The physical version (xmin) of every row the history part wrote: a row written again has another one. */
const xmins = (node: RealNode, ws: string) => onNode(node, async () => new Map((await q<{ k: string; x: string }>(
  `SELECT 'v' || note_id || unit || version_key AS k, xmin::text AS x FROM note_versions WHERE workspace_id = $1
   UNION ALL SELECT 'p' || note_id || unit || version_key || origin || seq, xmin::text FROM note_version_positions WHERE workspace_id = $1
   UNION ALL SELECT 'c' || node_id || hash, xmin::text FROM ink_chunks WHERE workspace_id = $1
   UNION ALL SELECT 'm' || node_id || hash, xmin::text FROM ink_manifests WHERE workspace_id = $1
   UNION ALL SELECT 'b' || hash, xmin::text FROM blobs WHERE hash IN (SELECT content_hash FROM note_versions WHERE workspace_id = $1)`, [ws])).rows.map((r) => [r.k, r.x] as const)));
const unchangedSince = (before: Map<string, string>, after: Map<string, string>) => [...before].filter(([k, x]) => after.get(k) !== x).map(([k]) => k);

const codeOf = async (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e: { code?: string }) => e.code ?? String(e));
const contentKey = (i: HistoryItem) => (i.kind === "blob" ? `b/${i.hash}` : i.kind === "ink_chunk" ? `c/${i.noteId}/${i.hash}` : i.kind === "ink_manifest" ? `m/${i.noteId}/${i.hash}` : `v/${i.version.noteId}/${i.version.unit}/${i.version.key}`);

/** An empty database with its one local person, the owner of its empty workspace, who has a sign-in: what a join through the route needs. */
async function emptyWithPerson(name: string): Promise<{ node: RealNode; person: ActorCtx }> {
  const node = await openNode(name);
  const person = await onNode(node, async () => {
    const ws = (await q<{ id: string }>(`SELECT id::text FROM workspaces WHERE slug = 'default'`)).rows[0]!.id;
    const a = await persistActor(ws, { id: "", name: "Local", role: "admin", type: "human" });
    await seedQ(`UPDATE actors SET external_id = $2 WHERE id = $1`, [a.id, `login-${randomUUID()}`]);
    return a;
  });
  return { node, person };
}

/** A random number drawn from the run's seed. */
function drawer(name: string): (n: number) => number {
  const seed = Math.floor(Math.random() * 2 ** 31);
  // eslint-disable-next-line no-console
  console.log(`[snapshotHistory] ${name}: seed ${seed}`);
  let rand = seed;
  return (n: number) => { rand = (rand * 1103515245 + 12345) % 2 ** 31; return rand % n; };
}

describe.skipIf(!isTestDb)("a snapshot carries the earlier versions", () => {
  let a: RealNode;
  let world: SourceWorld;
  let rowsAB: Capture, historyAB: HistoryCapture;
  let shared: { one: string; two: string; sketch: string; board: string; writer: string };
  let inScope: string[];
  const opened: RealNode[] = [];
  /** A device that took the notes of A's snapshot (and, unless `rowsOnly`, its history part). Each test makes its own: the order of tests is shuffled. */
  const joiner = async (name: string, rowsOnly = true, history: HistoryCapture = historyAB) => {
    const node = await openNode(`history-${name}-${randomUUID().slice(0, 6)}`);
    opened.push(node);
    await fillFrom(node, world, { ...rowsAB, history }, { rowsOnly });
    return node;
  };
  const finish = (node: RealNode, history: HistoryCapture = historyAB) => onNode(node, () => finishHistory({ workspaceId: world.ws, pages: history.pages.length, digests: history.summary.digests }));
  /** What `node` received equals A's version set exactly (keys, every identity field, content hashes, positions); its own versions are beside it. */
  const receivedEqualsSource = async (node: RealNode, units?: (v: Version) => boolean) => {
    const local = await onNode(node, () => localNodeId());
    const received = (await versionsOn(node, world.ws)).filter((v) => v.positions.some(([o]) => o !== local));
    expect(received).toEqual((await versionsOn(a, world.ws, inScope)).filter(units ?? (() => true)));
    // no map of events came with them (note_version_events is node-local): no event of this device names a version it received
    expect(await onNode(node, async () => (await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM note_version_events e JOIN note_version_positions p USING (note_id, unit, version_key) WHERE p.workspace_id = $1 AND p.origin <> $2`,
      [world.ws, local])).rows[0]!.n)).toBe(0);
  };

  beforeAll(async () => {
    a = await openNode("history-source");
    world = await buildSourceWorld(a);
    shared = await onNode(a, async () => {
      const note = async (title: string, markdown: string) => (await world.call("POST", "/api/nodes", { title, markdown, space_id: world.spaceA })).id as string;
      // two notes with the same text: one blob for both
      const one = await note("Same words one", "the very same words");
      const two = await note("Same words two", "the very same words");
      await world.call("PATCH", `/api/nodes/${two}`, { markdown: "the very same words, and more" });
      // a drawing saved small, then big twice (chunks shared between its two big versions), and a board drawing
      const sketch = await note("Sketch", "");
      const stroke = (i: number) => ({ id: `s${i}`, points: [[i, i], [i + 1, i + 2]] });
      const big = (n: number) => JSON.stringify({ v: 1, strokes: Array.from({ length: n }, (_, i) => stroke(i)) });
      await world.call("PUT", `/api/nodes/${sketch}/attributes/ink_data`, { value: JSON.stringify({ v: 1, strokes: [stroke(0)] }) });
      await world.call("PUT", `/api/nodes/${sketch}/attributes/ink_data`, { value: big(Math.ceil(INK_CHUNK_THRESHOLD / 20)) });
      await world.call("PUT", `/api/nodes/${sketch}/attributes/ink_data`, { value: big(Math.ceil(INK_CHUNK_THRESHOLD / 20) + 40) });
      const board = await note("Board", "");
      await world.call("PUT", `/api/nodes/${board}/attributes/note_ink`, { value: JSON.stringify({ v: 1, strokes: [stroke(7)] }) });
      // a member who writes a note, then is removed from the workspace: their versions stay theirs (review point 4a)
      const writerActor = await persistActor(world.ws, { id: "", name: "Writer", role: "editor", type: "human" });
      await seedQ(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit') ON CONFLICT DO NOTHING`, [world.spaceA, writerActor.id]);
      const writer = (await makeCaller(writerActor)("POST", "/api/nodes", { title: "Written by a member who left", markdown: "their words", space_id: world.spaceA })).id as string;
      await removeActor(world.owner, writerActor.id);
      return { one, two, sketch, board, writer };
    });
    const out = new Set(await outOfScopeIds(a, world));
    inScope = (await onNode(a, async () => (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1`, [world.ws])).rows.map((r) => r.id))).filter((id) => !out.has(id));
    rowsAB = await capture(a, world);
    historyAB = await captureHistory(a, world, rowsAB.summary.cut, 1_200);
    expect(historyAB.pages.length - historyAB.pages.findIndex((p) => p.layer === "history")).toBeGreaterThan(3);
  }, 300_000);
  afterAll(async () => { for (const node of [a, ...opened]) await node?.close(); });

  it("the history part holds every version of the notes it carries, content first, each piece of content once", async () => {
    const source = await versionsOn(a, world.ws, inScope);
    expect(source.length).toBeGreaterThan(10);
    expect(source.some((v) => v.unit === "ink_data") && source.some((v) => v.unit === "note_ink")).toBe(true);
    // a writer who was removed since is still named by id on their versions (no foreign key: their versions stay theirs)
    expect(source.some((v) => v.note_id === shared.writer && v.author_id !== null)).toBe(true);
    const items = historyAB.pages.flatMap((p) => p.items);
    const versions = items.filter((i): i is Extract<HistoryItem, { kind: "version" }> => i.kind === "version");
    expect(versions.map((i) => `${i.version.noteId}/${i.version.unit}/${i.version.key}`).sort()).toEqual(source.map((v) => `${v.note_id}/${v.unit}/${v.version_key}`).sort());
    const layers = historyAB.pages.map((p) => p.layer);
    expect(layers.indexOf("history")).toBeGreaterThan(0);
    expect(layers.slice(layers.indexOf("history")).every((l) => l === "history")).toBe(true);
    expect(historyAB.pages.every((p) => p.items.every((i) => (i.kind === "version") === (p.layer === "history")))).toBe(true);
    // each piece of content once: the blob of the two notes' common text, the chunks the two big drawings share
    const keys = items.filter((i) => i.kind !== "version").map(contentKey);
    expect(new Set(keys).size).toBe(keys.length);
    const sameText = source.filter((v) => v.note_id === shared.one && v.unit === "body")[0]!.content_hash;
    expect(source.filter((v) => v.content_hash === sameText).length).toBeGreaterThanOrEqual(2);
    expect(keys.filter((k) => k === `b/${sameText}`)).toHaveLength(1);
    const manifests = items.filter((i): i is Extract<HistoryItem, { kind: "ink_manifest" }> => i.kind === "ink_manifest");
    expect(manifests).toHaveLength(2);
    const listed = manifests.flatMap((m) => m.chunks.match(/.{64}/g)!);
    expect(new Set(listed).size).toBeLessThan(listed.length); // the second big save shares chunks with the first
    expect(items.filter((i) => i.kind === "ink_chunk")).toHaveLength(new Set(listed).size);
    // a blob only drawings name says so (a receiver that keeps the text history only leaves it out)
    const inkBlob = items.find((i): i is Extract<HistoryItem, { kind: "blob" }> => i.kind === "blob" && source.some((v) => v.unit !== "body" && v.content_hash === i.hash))!;
    expect(inkBlob.inkOnly).toBe(true);
    expect(historyAB.pages.every((p) => p.inkBytes === historyAB.summary.inkBytes && p.inkBytes > 0)).toBe(true);
    // a chunk is never longer than the drawing's own chunking makes one (the check on the receiver uses this bound)
    for (const text of ["x},".repeat(100_000), "x".repeat(200_000)]) expect(Math.max(...chunkInk(text).map((part) => part.length))).toBeLessThanOrEqual(MAX_INK_CHUNK_CHARS);
    expect(historyAB.summary.digests.all).toMatchObject({ versions: source.length, leftOut: 0, dangling: 0 });
  });

  it("the joiner is usable before the history part arrives, is no snapshot source until it is all in, and its own saves stay beside what it received", async () => {
    const b = await joiner("usable");
    expect(await onNode(b, () => joinProgress(world.ws))).toMatchObject({ state: "done", historyState: "arriving", historyDone: false, historyThrough: 0 });
    expect(await codeOf(onNode(b, () => snapshotSourceNode(world.ws)))).toBe("snapshot_source_history_incomplete");
    await onNode(b, async () => {
      await makeCaller(world.owner)("PATCH", `/api/nodes/${shared.two}`, { markdown: "written on the second device before the old versions came" });
      expect((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [shared.two])).rows[0]!.markdown).toContain("second device");
      expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM note_versions v JOIN note_version_positions p USING (note_id, unit, version_key) WHERE p.origin = $1`, [await localNodeId()])).rows[0]!.n).toBe(1);
      for (const page of historyAB.pages) await applyJoinPage(page);
    });
    await finish(b);
    await receivedEqualsSource(b);
    expect(await onNode(b, () => joinProgress(world.ws))).toMatchObject({ historyState: "done", historyLeftOut: 0 });
    expect(await codeOf(onNode(b, () => snapshotSourceNode(world.ws)))).toBe("ok");
  });

  it("a page that breaks a rule is refused whole and changes nothing, also when the bad item comes after good ones; the real pages after it still end in the source's set", async () => {
    const b = await joiner("refusals");
    const pages = historyAB.pages;
    const firstHistory = pages.findIndex((p) => p.layer === "history");
    await onNode(b, async () => { for (const page of pages.slice(0, firstHistory + 1)) await applyJoinPage(page); });
    const before = await everything(b, world.ws);
    const next = pages[firstHistory + 1]!;
    // the next real page, with the bad item at its END: everything before it would be written if the page were not one transaction
    const withAfter = (bad: HistoryItem): HistoryPage => ({ ...next, items: [...next.items, bad] });
    const blob = pages.flatMap((p) => p.items).find((i): i is Extract<HistoryItem, { kind: "blob" }> => i.kind === "blob")!;
    const chunk = pages.flatMap((p) => p.items).find((i): i is Extract<HistoryItem, { kind: "ink_chunk" }> => i.kind === "ink_chunk")!;
    const manifest = pages.flatMap((p) => p.items).find((i): i is Extract<HistoryItem, { kind: "ink_manifest" }> => i.kind === "ink_manifest")!;
    const held = pages[firstHistory]!.items.find((i): i is Extract<HistoryItem, { kind: "version" }> => i.kind === "version")!;
    const fresh = next.items.find((i): i is Extract<HistoryItem, { kind: "version" }> => i.kind === "version")!;
    const agent = await onNode(b, async () => (await q<{ id: string }>(`SELECT id::text FROM actors WHERE workspace_id = $1 AND type = 'agent' LIMIT 1`, [world.ws])).rows[0]!.id);
    const v = (over: Partial<WireVersion>): HistoryItem => ({ kind: "version", version: { ...fresh.version, ...over } });
    const bigContent = "x".repeat(MAX_INK_CHUNK_CHARS);
    const bigChunk: Extract<HistoryItem, { kind: "ink_chunk" }> = { kind: "ink_chunk", noteId: chunk.noteId, hash: createHash("sha256").update(bigContent).digest("hex"), content: bigContent };
    const { source, cut } = rowsAB.summary;
    const wrong: [string, HistoryPage][] = [
      // content that is not what its hash says: a blob, a chunk, a manifest whose chunks make another value (after its chunks were written in the same page)
      ["join_history_hash", { ...next, layer: "blobs", items: [{ ...blob, content: `${blob.content} (changed)` }] }],
      ["join_history_hash", { ...next, layer: "blobs", items: [{ ...chunk, content: `${chunk.content}x` }] }],
      ["join_history_hash", { ...next, layer: "blobs", items: [chunk, { ...manifest, hash: "0".repeat(64) }] }],
      // a manifest that lists one (largest) chunk again and again until the value would be larger than a value can be: refused by the sizes, before anything is joined
      ["join_history_shape", { ...next, layer: "blobs", items: [bigChunk, { ...manifest, noteId: chunk.noteId, chunks: bigChunk.hash.repeat(1025) }] }],
      // a version held already, again with another identity, after the page's good versions
      ["join_history_clash", withAfter({ kind: "version", version: { ...held.version, title: "another title" } })],
      ["join_history_unknown_note", withAfter(v({ noteId: randomUUID() }))],
      // its writer is an agent here, not a person
      ["join_history_shape", withAfter(v({ authorKind: "person", authorId: agent }))],
      // a position of an origin nobody vouches for; one past the source's cut; a key that is not what the version is
      ["join_history_shape", withAfter(v({ positions: [[world.ws, 1]] }))],
      // more positions than a version can travel with (64), all of them good ones
      ["join_history_shape", withAfter(v({ positions: Array.from({ length: 65 }, () => [source, 1] as [string, number]) }))],
      ["join_history_shape", withAfter(v({ key: `s:${source}:${cut + 1}:1`, positions: [[source, cut + 1]] }))],
      ["join_history_shape", withAfter(v({ key: `g:${"0".repeat(64)}` }))],
      ["join_history_shape", withAfter(v({ key: `m:${"0".repeat(64)}`, kind: "merged" }))],
      ["join_history_shape", withAfter({ kind: "version", version: { ...fresh.version, extra: 1 } as unknown as WireVersion })],
      // a version of a system note (no version list: note_version_in_scope; a tag has one since migration 231)
      ["join_history_shape", withAfter(v({ noteId: await onNode(b, async () => (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND source_type = 'system' LIMIT 1`, [world.ws])).rows[0]!.id) }))],
      ["join_history_order", { ...next, page: firstHistory + 3 }],
      ["join_page_changed", { ...pages[firstHistory]!, items: pages[firstHistory]!.items.slice(1) }],
    ];
    for (const [code, page] of wrong) {
      expect(await codeOf(onNode(b, () => applyJoinPage(page))), code).toBe(code);
      expect(await everything(b, world.ws), code).toEqual(before);
    }
    await onNode(b, async () => { for (const page of pages.slice(firstHistory + 1)) await applyJoinPage(page); });
    // a manifest that does not say what the source holds is not "done": nothing changes
    const lying = { ...historyAB.summary.digests, all: { ...historyAB.summary.digests.all, versionsHash: "0".repeat(64) } };
    const beforeDone = await everything(b, world.ws);
    expect(await codeOf(onNode(b, () => finishHistory({ workspaceId: world.ws, pages: pages.length, digests: lying })))).toBe("join_history_digest_mismatch");
    expect(await everything(b, world.ws)).toEqual(beforeDone);
    await finish(b);
    await receivedEqualsSource(b);
  });

  it("the history part cut at EVERY page boundary and sent again (from the start, or from the next page) ends the same and rewrites nothing", async () => {
    const coarse = await captureHistory(a, world, rowsAB.summary.cut, 6_000);
    for (let cutAt = 0; cutAt <= coarse.pages.length; cutAt++) {
      for (const resume of ["from the start", "from the next page"] as const) {
        const b = await joiner(`resume-${cutAt}-${resume.length}`, true, coarse);
        await onNode(b, async () => { for (const page of coarse.pages.slice(0, cutAt)) await applyJoinPage(page); });
        expect((await onNode(b, () => joinProgress(world.ws)))!.historyThrough).toBe(cutAt);
        expect(await codeOf(finish(b, coarse))).toBe(cutAt === coarse.pages.length ? "ok" : "join_page_missing");
        const written = await xmins(b, world.ws);
        const applied = await onNode(b, async () => {
          const out: boolean[] = [];
          for (const page of resume === "from the start" ? coarse.pages : coarse.pages.slice(cutAt)) out.push((await applyJoinPage(page)).applied);
          return out;
        });
        if (resume === "from the start") expect(applied.slice(0, cutAt).every((x) => !x), `${cutAt} ${resume}`).toBe(true);
        await finish(b, coarse);
        expect(unchangedSince(written, await xmins(b, world.ws)), `${cutAt} ${resume}`).toEqual([]);
        expect((await onNode(b, () => joinProgress(world.ws)))!.historyState).toBe("done");
        await receivedEqualsSource(b);
        await b.close();
        opened.splice(opened.indexOf(b), 1);
      }
    }
  }, 600_000);

  it("a third device joining from the second holds exactly the second's version set, with the content of every version", async () => {
    const b = await joiner("second", false);
    await onNode(b, () => makeCaller(world.owner)("PATCH", `/api/nodes/${shared.two}`, { markdown: "a save of the second device" }));
    const c = await openNode(`history-third-${randomUUID().slice(0, 6)}`);
    opened.push(c);
    await fillFrom(c, world, await capture(b, world, 10_000));
    expect(await onNode(c, () => joinProgress(world.ws))).toMatchObject({ historyState: "done" });
    expect(await versionsOn(c, world.ws)).toEqual(await versionsOn(b, world.ws));
    const missing = await onNode(c, async () => (await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM note_versions v WHERE v.workspace_id = $1 AND v.content_hash IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM blobs x WHERE x.hash = v.content_hash) AND NOT EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = v.note_id AND m.hash = v.content_hash)`, [world.ws])).rows[0]!.n);
    expect(missing).toBe(0);
    const values = await onNode(c, async () => (await q<{ hash: string; ok: boolean }>(
      `SELECT m.hash, encode(sha256(convert_to(string_agg(ch.content, '' ORDER BY i), 'UTF8')), 'hex') = m.hash AS ok
         FROM ink_manifests m CROSS JOIN LATERAL generate_series(0, length(m.chunks) / 32 - 1) i
         JOIN ink_chunks ch ON ch.node_id = m.node_id AND ch.hash = encode(substring(m.chunks FROM i * 32 + 1 FOR 32), 'hex')
        WHERE m.node_id = $1 GROUP BY m.hash, m.chunks`, [shared.sketch])).rows);
    expect(values).toHaveLength(2);
    expect(values.every((v) => v.ok)).toBe(true);
  });

  it("deleting notes for good on a device that joined keeps the content another note's received version still names (text and drawings), and so does the cleanup", async () => {
    const b = await joiner("purge", false);
    const text = (await versionsOn(b, world.ws, [shared.one])).find((v) => v.unit === "body")!.content_hash as string;
    await onNode(b, async () => {
      const call = makeCaller(world.owner);
      await call("DELETE", `/api/nodes/${shared.one}`);
      await call("POST", `/api/nodes/${shared.one}/purge`, { expected_ids: [shared.one] });
      expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [shared.one])).rows).toHaveLength(0);
      expect((await q(`SELECT 1 FROM blobs WHERE hash = $1`, [text])).rows).toHaveLength(1);
      const drawing = async () => (await q<{ m: number; c: number }>(`SELECT (SELECT count(*)::int FROM ink_manifests WHERE node_id = $1) AS m, (SELECT count(*)::int FROM ink_chunks WHERE node_id = $1) AS c`, [shared.sketch])).rows[0]!;
      const drawn = await drawing();
      expect(drawn.m).toBe(2);
      // a stray chunk no manifest lists (a cut transfer that was given up) goes; the received drawing's chunks and manifests stay
      await seedQ(`INSERT INTO ink_chunks (workspace_id, node_id, hash, content, size_bytes) VALUES ($1, $2, $3, 'stray', 5)`, [world.ws, shared.sketch, "f".repeat(64)]);
      await seedQ(`UPDATE blobs SET created_at = now() - interval '30 days'`);
      await seedQ(`UPDATE ink_manifests SET created_at = now() - interval '30 days'`);
      await seedQ(`UPDATE ink_chunks SET created_at = now() - interval '30 days'`);
      await collectOrphanBlobs();
      expect((await q(`SELECT 1 FROM blobs WHERE hash = $1`, [text])).rows).toHaveLength(1);
      expect(await drawing()).toEqual(drawn);
      expect((await q(`SELECT 1 FROM ink_chunks WHERE hash = $1`, ["f".repeat(64)])).rows).toHaveLength(0);
    });
  });

  // Review point 4: an honest source never leaves the history part stuck.
  it("a note deleted for good on the joiner while its versions are on the way does not keep the history part from completing", async () => {
    const pages = historyAB.pages;
    const firstHistory = pages.findIndex((p) => p.layer === "history");
    const later = pages.slice(firstHistory + 1).flatMap((p) => p.items).find((i): i is Extract<HistoryItem, { kind: "version" }> => i.kind === "version" && i.version.unit === "body")!.version.noteId;
    const b = await joiner("purged-meanwhile");
    let gone = new Set<string>();
    await onNode(b, async () => {
      for (const page of pages.slice(0, firstHistory + 1)) await applyJoinPage(page);
      const call = makeCaller(world.owner);
      await call("DELETE", `/api/nodes/${later}`).catch(() => undefined);
      // what goes with it (its descendants) is confirmed as the screen confirms it
      const plan = (await call("GET", `/api/nodes/${later}/purge-preview`)) as { ids: string[] };
      await call("POST", `/api/nodes/${later}/purge`, { expected_ids: plan.ids });
      gone = new Set(plan.ids);
      // The purge deletes the purged notes' content at once (services/purgedContent.ts). A version still to come of a note that stays, with the very same content
      // (two notes once had the same text), then finds it gone: that page is refused (join_history_content_gone, nothing written) and the same file again brings
      // the content back (its content pages are written again). Which case this run is in follows from the data, so it is worked out, not guessed.
      const versionsToCome = pages.slice(firstHistory + 1).flatMap((p) => p.items).flatMap((i) => (i.kind === "version" ? [i.version] : []));
      const wanted = versionsToCome.filter((v) => !gone.has(v.noteId) && v.contentHash !== null);
      const present = new Set((await q<{ k: string }>(
        `SELECT 'b' || hash AS k FROM blobs WHERE hash = ANY($1::text[]) UNION ALL SELECT 'm' || node_id || '/' || hash FROM ink_manifests WHERE hash = ANY($1::text[])`,
        [wanted.map((v) => v.contentHash)])).rows.map((r) => r.k));
      const needsPurged = wanted.some((v) => !present.has(`b${v.contentHash}`) && !present.has(`m${v.noteId}/${v.contentHash}`));
      let refusal: string | null = null;
      for (const page of pages.slice(firstHistory + 1)) {
        const code = await codeOf(applyJoinPage(page));
        if (code !== "ok") { refusal = code; break; }
      }
      expect(refusal, needsPurged ? "a version to come needs content the purge took" : "nothing to come needs what the purge took").toBe(needsPurged ? "join_history_content_gone" : null);
      if (refusal) for (const page of pages) await applyJoinPage(page); // the same file again
    });
    await finish(b);
    expect(await onNode(b, () => joinProgress(world.ws))).toMatchObject({ historyState: "done" });
    await receivedEqualsSource(b, (v) => !gone.has(v.note_id));
  });

  it("content the cleanup takes between two pages comes back with the same pages again", async () => {
    const pages = historyAB.pages;
    const firstHistory = pages.findIndex((p) => p.layer === "history");
    const b = await joiner("cleanup-between");
    await onNode(b, async () => {
      for (const page of pages.slice(0, firstHistory)) await applyJoinPage(page);
      await seedQ(`UPDATE blobs SET created_at = now() - interval '30 days'`);
      await seedQ(`UPDATE ink_manifests SET created_at = now() - interval '30 days'`);
      await seedQ(`UPDATE ink_chunks SET created_at = now() - interval '30 days'`);
      await collectOrphanBlobs();
    });
    expect(await codeOf(onNode(b, () => applyJoinPage(pages[firstHistory]!)))).toBe("join_history_content_gone");
    await onNode(b, async () => { for (const page of pages) await applyJoinPage(page); });
    await finish(b);
    await receivedEqualsSource(b);
  });

  it("the person can stop waiting: what arrived goes, the notes and this device's own versions stay, and until a file brings them in the device makes none", async () => {
    const pages = historyAB.pages;
    const b = await joiner("given-up");
    await onNode(b, async () => {
      for (const page of pages.slice(0, pages.length - 2)) await applyJoinPage(page);
      await makeCaller(world.owner)("PATCH", `/api/nodes/${shared.two}`, { markdown: "kept: written here" });
    });
    const notes = await onNode(b, async () => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM content_nodes WHERE workspace_id = $1`, [world.ws])).rows[0]!.n);
    // a temporary session cannot give the earlier versions up: nothing changes
    const session = { ...world.owner, type: "session" } as typeof world.owner;
    expect(await onNode(b, () => stopWaitingForHistory(session, world.ws).then(() => "ok", (e: Error) => e.constructor.name))).toBe("AuthorityError");
    expect(await onNode(b, () => joinProgress(world.ws))).toMatchObject({ historyState: "arriving" });
    const { removed } = await onNode(b, () => stopWaitingForHistory(world.owner, world.ws));
    expect(removed).toBeGreaterThan(0);
    const local = await onNode(b, () => localNodeId());
    const left = await versionsOn(b, world.ws);
    expect(left.length).toBe(1);
    expect(left.every((v) => v.positions.every(([o]) => o === local))).toBe(true);
    expect(await onNode(b, async () => (await q<{ n: number }>(`SELECT count(*)::int AS n FROM content_nodes WHERE workspace_id = $1`, [world.ws])).rows[0]!.n)).toBe(notes);
    expect(await onNode(b, () => joinProgress(world.ws))).toMatchObject({ historyState: "given_up", historyDone: true });
    // no earlier versions now: no source of an incomplete history (the owner's decision of 2026-11-23) until a file brings them in (tests below)
    expect(await codeOf(onNode(b, () => snapshotSourceNode(world.ws)))).toBe("snapshot_source_history_missing");
    expect(await codeOf(onNode(b, () => applyJoinPage(pages[pages.length - 1]!)))).toBe("join_page_extra");
    expect(await codeOf(onNode(b, () => stopWaitingForHistory(world.owner, world.ws)))).toBe("join_history_not_arriving");
  });

  // §10 question 4: "在 50 MB 以內，瀏覽器版就全部存。超過的話，先只存內文歷史，並在畫面上說明。"
  it("the browser version over the drawings' threshold keeps the text history only; a server keeps all of it", async () => {
    const over = { ...historyAB, pages: historyAB.pages.map((p) => ({ ...p, inkBytes: BROWSER_INK_LIMIT + 1 })) };
    const server = await joiner("gate-server", true, over);
    await onNode(server, async () => { for (const page of over.pages) await applyJoinPage(page); });
    await finish(server, over);
    expect(await onNode(server, () => joinProgress(world.ws))).toMatchObject({ historyScope: "all", historyState: "done" });
    setEnvironment({ ONDEN_BROWSER_APP: "1" });
    try {
      const browser = await joiner("gate-browser", true, over);
      await onNode(browser, async () => { for (const page of over.pages) await applyJoinPage(page); });
      await finish(browser, over);
      expect(await onNode(browser, () => joinProgress(world.ws))).toMatchObject({ historyScope: "body", historyState: "done" });
      await receivedEqualsSource(browser, (v) => v.unit === "body");
      expect(await onNode(browser, async () => (await q<{ n: number }>(`SELECT ((SELECT count(*) FROM ink_manifests WHERE workspace_id = $1) + (SELECT count(*) FROM ink_chunks WHERE workspace_id = $1))::int AS n`, [world.ws])).rows[0]!.n)).toBe(0);
      // that copy as a source: its file says it holds the text history only, so a server joining from it keeps the same and says so (never "all of it")
      setEnvironment({ ONDEN_BROWSER_APP: "" });
      const fromBrowser = await capture(browser, world, 10_000);
      expect(fromBrowser.history?.pages.length).toBeGreaterThan(0);
      expect(fromBrowser.history?.pages.every((p) => p.textOnly)).toBe(true);
      const third = await openNode(`gate-third-${randomUUID().slice(0, 6)}`);
      opened.push(third);
      await fillFrom(third, world, fromBrowser);
      expect(await onNode(third, () => joinProgress(world.ws))).toMatchObject({ historyScope: "body", historyState: "done" });
      expect(await versionsOn(third, world.ws)).toEqual(await versionsOn(browser, world.ws));
      setEnvironment({ ONDEN_BROWSER_APP: "1" });
      // at the threshold, not over it, the browser keeps all of it
      const at = { ...historyAB, pages: historyAB.pages.map((p) => ({ ...p, inkBytes: BROWSER_INK_LIMIT })) };
      const under = await joiner("gate-browser-under", true, at);
      await onNode(under, async () => { for (const page of at.pages) await applyJoinPage(page); });
      await finish(under, at);
      expect(await onNode(under, () => joinProgress(world.ws))).toMatchObject({ historyScope: "all" });
    } finally { setEnvironment({ ONDEN_BROWSER_APP: "" }); }
  }, 120_000); // three databases joined

  it("a cut beyond the source's own is no snapshot", async () => {
    expect(await codeOf(onNode(a, () => readHistoryPages(world.owner, world.ws, { cut: rowsAB.summary.cut + 1_000 }, async () => undefined)))).toBe("snapshot_history_cut");
  });
});

// The rules a page is checked by before the database is asked anything (the first layer): each one, on its own item.
describe("the form of an item of the history part", () => {
  const source = randomUUID(), former = randomUUID(), brought = randomUUID(), local = randomUUID(), note = randomUUID();
  const vouch = { source, cut: 10, former: { [former]: 5 }, brought: { content_nodes: { [brought]: 7 }, spaces: { [brought]: 9 } }, local };
  const at = "2026-11-21T08:00:00.123456Z";
  const good = (over: Partial<WireVersion> = {}): WireVersion => ({
    noteId: note, unit: "body", key: `s:${source}:4:1`, kind: "updated", title: "T", contentHash: "a".repeat(64), at, wall: 1, counter: 0, ordinal: 1,
    recordedBy: source, authorKind: "automatic", authorId: null, restoredFrom: null, sourceName: null, positions: [[source, 4]], ...over,
  });
  const check = (version: WireVersion) => { try { checkHistoryItems({ layer: "history", items: [{ kind: "version", version }] }, vouch); return "ok"; } catch (e) { return (e as { code: string }).code; } };
  it("accepts a version of every origin it vouches for, up to how far it holds each", () => {
    expect(check(good())).toBe("ok");
    expect(check(good({ key: `s:${former}:5:1`, positions: [[former, 5]] }))).toBe("ok");
    expect(check(good({ key: `s:${brought}:9:1`, positions: [[brought, 9]] }))).toBe("ok"); // the most it holds of it under any label
  });
  it.each([
    ["a former id past what the source holds of it", good({ key: `s:${former}:6:1`, positions: [[former, 6]] })],
    ["another origin past the most the source holds of it", good({ key: `s:${brought}:10:1`, positions: [[brought, 10]] })],
    ["this device's own origin", good({ key: `s:${local}:1:1`, positions: [[local, 1]] })],
    ["an s: key whose position is not one it travels from", good({ positions: [[source, 3]] })],
    ["an s: key whose ordinal is not the version's", good({ ordinal: 2 })],
    ["a g: key that is not what the version is", good({ key: `g:${"0".repeat(64)}` })],
    ["a b: key on a version that is not a baseline", good({ key: `b:${"0".repeat(64)}` })],
    ["an m: key (batch 6)", good({ key: `m:${"0".repeat(64)}`, kind: "merged" })],
    ["a drawing with a title", good({ unit: "ink_data", title: "T" })],
    ["a restored_from that is no key", good({ restoredFrom: "yesterday" })],
    ["a time that is no time", good({ at: "2026-02-31T08:00:00.000000Z" })],
    ["a field the format does not have", { ...good(), extra: true } as unknown as WireVersion],
  ])("refuses %s", (_name, version) => expect(check(version)).toBe("join_history_shape"));
  it("refuses content larger than a value can be (a chunk, a text), and a blob that says something else than `inkOnly: true`", () => {
    const blobOf = (item: Record<string, unknown>) => { try { checkHistoryItems({ layer: "blobs", items: [item as unknown as HistoryItem] }, vouch); return "ok"; } catch (e) { return (e as { code: string }).code; } };
    expect(blobOf({ kind: "ink_chunk", noteId: note, hash: "a".repeat(64), content: "x".repeat(MAX_INK_CHUNK_CHARS + 1) })).toBe("join_history_shape");
    expect(blobOf({ kind: "blob", hash: "a".repeat(64), content: "x", inkOnly: false })).toBe("join_history_shape");
    // a text's content larger than a value can be (64 MiB of characters): refused by its length, before it is hashed
    expect(blobOf({ kind: "blob", hash: "a".repeat(64), content: "x".repeat(64 * 1024 * 1024 + 1) })).toBe("join_history_shape");
    expect(blobOf({ kind: "blob", hash: createHash("sha256").update("x".repeat(64 * 1024 * 1024)).digest("hex"), content: "x".repeat(64 * 1024 * 1024) })).toBe("ok");
  });
});

// Review point 7: the source as production has it, history made by migration 220 out of old data (g:, b:, set_aside, removed versions), not only s: keys.
if (dbDriver === "pglite") describe.skipIf(!isTestDb)("a snapshot of a database whose history migration 220 made from old data", () => {
  let dir = "", file = "";
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "history-old-copy-"));
    file = join(dir, "history.tar.gz");
    await promisify(execFile)("npx", ["tsx", "src/browser/makeOldCopy.ts", file, "history"], { cwd: backend, timeout: 280_000, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1", ONDEN_PGLITE_SNAPSHOT: "" } });
  }, 300_000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("a device joining from it holds the same versions, g: and b: keys and set-aside and removed drawings included", async () => {
    const old = await RealNode.open("history-old-source", undefined, file);
    const joinerNode = await openNode(`history-old-joiner-${randomUUID().slice(0, 6)}`);
    try {
      const world = await onNode(old, async () => {
        await migrate({ seedNativeActor: false }); // the copy is from before 220: upgrading it is what makes its history versions
        const ws = (await q<{ id: string }>(`SELECT id::text FROM workspaces ORDER BY created_at LIMIT 1`)).rows[0]!.id;
        const owner = (await q<{ id: string }>(`SELECT owner_actor_id::text AS id FROM workspaces WHERE id = $1`, [ws])).rows[0]!.id;
        const row = (await q<{ name: string }>(`SELECT name FROM actors WHERE id = $1`, [owner])).rows[0]!;
        return { ws, owner: { id: owner, name: row.name, role: "admin", type: "human" } as unknown as ActorCtx };
      });
      const kinds = await onNode(old, async () => (await q<{ k: string }>(`SELECT DISTINCT left(version_key, 2) || kind AS k FROM note_versions WHERE workspace_id = $1 ORDER BY 1`, [world.ws])).rows.map((r) => r.k));
      expect(kinds.some((k) => k.startsWith("g:"))).toBe(true);
      expect(kinds.some((k) => k.startsWith("b:"))).toBe(true);
      await fillFrom(joinerNode, world, await capture(old, world, 2_000));
      expect(await onNode(joinerNode, () => joinProgress(world.ws))).toMatchObject({ historyState: "done" });
      const out = new Set(await outOfScopeIds(old, world));
      const scoped = (await onNode(old, async () => (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1`, [world.ws])).rows.map((r) => r.id))).filter((id) => !out.has(id));
      expect(await versionsOn(joinerNode, world.ws)).toEqual(await versionsOn(old, world.ws, scoped));
    } finally { await old.close(); await joinerNode.close(); }
  }, 300_000);
});

describe.skipIf(!isTestDb)("the snapshot file brings the earlier versions after the notes", () => {
  let src: RealNode;
  let world: SourceWorld;
  let text = "";
  let expected: Version[] = [];

  beforeAll(async () => {
    src = await openNode("history-file-source");
    world = await buildSourceWorld(src);
    const res = await onNode(src, async () => { const r = await exportAs(world.owner); return { status: r.status, text: await r.text() }; });
    expect(res.status).toBe(200);
    text = res.text;
    // what the file carries, read now: other tests write to this source afterwards (the order is shuffled)
    const out = new Set(await outOfScopeIds(src, world));
    const scoped = (await onNode(src, async () => (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1`, [world.ws])).rows.map((r) => r.id))).filter((id) => !out.has(id));
    expected = await versionsOn(src, world.ws, scoped);
  }, 120_000);
  afterAll(async () => { await src?.close(); });

  it("a file that stops at ANY line of its history part leaves the notes in use; the same file uploaded again brings in the rest and rewrites nothing", async () => {
    const lines = text.trim().split("\n");
    const kinds = lines.map((l) => (JSON.parse(l) as { kind: string }).kind);
    const rowsDone = kinds.indexOf("rows-done");
    expect(rowsDone).toBeGreaterThan(1);
    expect(kinds.at(-1)).toBe("manifest");
    // every place the file can stop after the notes are in: after rows-done, after each page of the history part (not after the manifest: that is the whole file)
    for (let stop = rowsDone + 1; stop < lines.length; stop++) {
      const { node, person } = await emptyWithPerson(`history-file-receiver-${stop}`);
      try {
        const post = (as: ActorCtx, body: string) => onNode(node, async () => snapshotApp(as).request("/api/snapshot", { method: "POST", body }));
        const first = await post(person, `${lines.slice(0, stop).join("\n")}\n`);
        expect(first.status, String(stop)).toBe(200);
        expect(await first.json()).toMatchObject({ historyDone: false, history: "arriving", historyRefused: "join_history_file_cut" });
        expect(await onNode(node, () => joinProgress(world.ws))).toMatchObject({ state: "done", historyThrough: stop - rowsDone - 1, historyState: "arriving" });
        const held = await xmins(node, world.ws);
        // after the join the sign-in on this device is the snapshot's owner (spine/stampedImport.ts markJoinDone): they upload the file again
        const again = await post(world.owner, text);
        expect(again.status).toBe(200);
        expect(await again.json()).toMatchObject({ historyDone: true, history: "done" });
        expect(unchangedSince(held, await xmins(node, world.ws))).toEqual([]);
        expect(await versionsOn(node, world.ws)).toEqual(expected);
        const third = await post(world.owner, text);
        expect([third.status, ((await third.json()) as { error: string }).error]).toEqual([409, "join_already_done"]);
      } finally { await node.close(); }
    }
  }, 600_000);

  // Review of PR #1988, round 2, point 1: a cut at any byte (inside a line, as almost every cut is) is answered as the database really is: before the notes are
  // all in, refused and nothing kept (an empty database again); after, 200 with the notes in and the earlier versions as far as they came. Never "nothing was kept"
  // about notes that are here.
  it("a file cut in the middle of ANY line is answered as the database really is, and the same whole file finishes it", async () => {
    const lines = text.trim().split("\n");
    const rowsDone = lines.findIndex((l) => l.startsWith('{"kind":"rows-done"'));
    for (let at = 1; at < lines.length; at++) {
      const cut = `${lines.slice(0, at).join("\n")}\n${lines[at]!.slice(0, Math.floor(lines[at]!.length / 2))}`;
      const { node, person } = await emptyWithPerson(`history-file-midline-${at}`);
      try {
        const post = (as: ActorCtx, body: string) => onNode(node, async () => snapshotApp(as).request("/api/snapshot", { method: "POST", body }));
        const first = await post(person, cut);
        const answer = await first.json() as { error?: string; history?: string; historyRefused?: string | null };
        const progress = await onNode(node, () => joinProgress(world.ws));
        if (at <= rowsDone) {
          // the notes are not all in (the cut is in a page of the notes, or in the line that ends them): refused, and the database is the empty one again
          expect([[409, 422].includes(first.status), progress], String(at)).toEqual([true, null]);
          expect(answer.error, String(at)).toMatch(/^join_(bad_line|incomplete)$/);
          expect(await onNode(node, () => databaseJoinReadiness()), String(at)).toMatchObject({ ready: true });
          continue;
        }
        expect(first.status, String(at)).toBe(200);
        expect(answer, String(at)).toMatchObject({ history: "arriving", historyRefused: "join_history_file_cut" });
        expect(progress, String(at)).toMatchObject({ state: "done", historyState: "arriving" });
        const again = await post(world.owner, text);
        expect(await again.json(), String(at)).toMatchObject({ history: "done", historyRefused: null });
        expect(await versionsOn(node, world.ws), String(at)).toEqual(expected);
      } finally { await node.close(); }
    }
  }, 600_000);

  it("a device whose notes are here is answered, not refused, when the next file is of another version or broken: the notes are not in question", async () => {
    const lines = text.trim().split("\n");
    const rowsDone = lines.findIndex((l) => l.startsWith('{"kind":"rows-done"'));
    const { node, person } = await emptyWithPerson("history-file-hard-refusals");
    try {
      const post = (as: ActorCtx, body: string) => onNode(node, async () => snapshotApp(as).request("/api/snapshot", { method: "POST", body }));
      expect(await (await post(person, `${lines.slice(0, rowsDone + 1).join("\n")}\n`)).json()).toMatchObject({ history: "arriving" });
      const otherShape = [JSON.stringify({ ...JSON.parse(lines[0]!), dataShape: 1 }), ...lines.slice(1)].join("\n");
      const shape = await post(world.owner, otherShape);
      expect([shape.status, await shape.json()]).toEqual([200, expect.objectContaining({ history: "arriving", historyRefused: "join_data_shape" })]);
      const broken = await post(world.owner, `${lines[0]}\n{not a message\n`);
      expect([broken.status, await broken.json()]).toEqual([200, expect.objectContaining({ history: "arriving", historyRefused: "join_history_file_cut" })]);
      expect(await onNode(node, () => joinProgress(world.ws))).toMatchObject({ state: "done", historyState: "arriving" });
    } finally { await node.close(); }
  }, 120_000);

  it("a refusal in the history part answers that the notes are in and why the earlier versions are not; another file cannot finish them", async () => {
    const lines = text.trim().split("\n");
    const rowsDone = lines.findIndex((l) => l.startsWith('{"kind":"rows-done"'));
    const damaged = lines.map((l, i) => {
      if (i !== rowsDone + 1) return l;
      const page = JSON.parse(l) as { kind: string; page: HistoryPage };
      const blob = page.page.items.find((it) => it.kind === "blob") as Extract<HistoryItem, { kind: "blob" }>;
      blob.content = `${blob.content} (changed)`;
      return JSON.stringify(page);
    });
    const { node, person } = await emptyWithPerson("history-file-refused");
    try {
      const res = await onNode(node, async () => snapshotApp(person).request("/api/snapshot", { method: "POST", body: `${damaged.join("\n")}\n` }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ history: "arriving", historyRefused: "join_history_hash" });
      expect(await onNode(node, () => joinProgress(world.ws))).toMatchObject({ state: "done", historyState: "arriving" });
      // a file of another cut is not this device's file
      const other = await onNode(src, async () => { await world.call("PATCH", `/api/nodes/${world.secretNote}`, {}).catch(() => undefined); await world.call("POST", "/api/nodes", { title: "Later", markdown: "x", space_id: world.spaceA }); const r = await exportAs(world.owner); return r.text(); });
      const refused = await onNode(node, async () => snapshotApp(world.owner).request("/api/snapshot", { method: "POST", body: other }));
      expect([refused.status, ((await refused.json()) as { historyRefused: string }).historyRefused]).toEqual([200, "join_history_other_file"]);
      // the same, undamaged file goes on
      const fine = await onNode(node, async () => snapshotApp(world.owner).request("/api/snapshot", { method: "POST", body: text }));
      expect(await fine.json()).toMatchObject({ history: "done" });
    } finally { await node.close(); }
  }, 180_000);
  // A tag's description has versions since migration 231 (history batch 8): they travel like a note's, by the same rule of which notes have a version list.
  it("a tag's earlier descriptions come with the file, as a note's do", async () => {
    const made = await onNode(src, async () => {
      const tag = (await world.call("POST", "/api/tags", { name: `described-${randomUUID().slice(0, 6)}` })).id as string;
      await world.call("PATCH", `/api/nodes/${tag}`, { markdown: "first description" });
      await world.call("PATCH", `/api/nodes/${tag}`, { markdown: "second description" });
      return { tag, text: await (await exportAs(world.owner)).text() };
    });
    const sourceVersions = await versionsOn(src, world.ws, [made.tag]);
    expect(sourceVersions.length).toBeGreaterThanOrEqual(2);
    const { node, person } = await emptyWithPerson("history-tag-descriptions");
    try {
      const res = await onNode(node, async () => snapshotApp(person).request("/api/snapshot", { method: "POST", body: made.text }));
      expect(await res.json()).toMatchObject({ history: "done", historyRefused: null });
      expect(await versionsOn(node, world.ws, [made.tag])).toEqual(sourceVersions);
    } finally { await node.close(); }
  }, 120_000);

  // The owner's decision of 2026-11-23 (PR #1988, round 1, point 8): a device that joined before migration 229 has no earlier versions and is not marked complete;
  // nor is one whose person stopped waiting. Neither may be a snapshot source (it would hand on notes without their history); a file of the same source, even a
  // newer one, brings in only its history part, and the notes are not touched.
  for (const how of ["missing", "given_up"] as const) {
    it(`a device without its earlier versions (${how}) is no source, and a newer file of the same source brings in only them, the notes untouched`, async () => {
      const lines = text.trim().split("\n");
      const rowsDone = lines.findIndex((l) => l.startsWith('{"kind":"rows-done"'));
      const { node, person } = await emptyWithPerson(`history-refill-${how}`);
      try {
        const post = (as: ActorCtx, body: string) => onNode(node, async () => snapshotApp(as).request("/api/snapshot", { method: "POST", body }));
        // the notes only, as a file before data shape 9 brought them; then the state that device is in
        expect(await (await post(person, `${lines.slice(0, rowsDone + 1).join("\n")}\n`)).json()).toMatchObject({ history: "arriving" });
        await onNode(node, () => stopWaitingForHistory(world.owner, world.ws));
        if (how === "missing") {
          // a join finished before migration 229: the column is not there yet, and the migration itself marks the join (not a hand-written UPDATE)
          await onNode(node, async () => {
            await seedQ(`ALTER TABLE sync_join DROP COLUMN history_state`);
            await seedQ(readFileSync(resolve(backend, "db/migrations/229_sync_join_history.sql"), "utf8"));
          });
          expect(await onNode(node, () => joinProgress(world.ws))).toMatchObject({ state: "done", historyState: "missing" });
        }
        expect(await onNode(node, () => databaseJoinReadiness())).toMatchObject({ ready: false, code: "join_history_missing" });
        expect(await codeOf(onNode(node, () => snapshotSourceNode(world.ws)))).toBe("snapshot_source_history_missing");
        expect(await versionsOn(node, world.ws)).toEqual([]);
        // the source goes on: a new note (this device never had it) and a new save of a note it has
        const newer = await onNode(src, async () => {
          const fresh = (await world.call("POST", "/api/nodes", { title: `Written later ${how}`, markdown: "only on the source", space_id: world.spaceA })).id as string;
          const root = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = 'Root'`, [world.ws])).rows[0]!.id;
          await world.call("PATCH", `/api/nodes/${root}`, { markdown: `saved again on the source (${how})` });
          return { fresh, root, text: await (await exportAs(world.owner)).text() };
        });
        const notes = () => onNode(node, async () => (await q<{ id: string; x: string; t: string }>(`SELECT id::text, xmin::text AS x, title AS t FROM content_nodes WHERE workspace_id = $1 ORDER BY id`, [world.ws])).rows);
        const stamps = () => onNode(node, async () => (await q<{ n: string }>(`SELECT count(*)::text AS n, max(xmin::text) AS x FROM sync_stamps WHERE workspace_id = $1`, [world.ws])).rows[0]);
        const notesBefore = await notes(), stampsBefore = await stamps();
        // a file of another device: answered (the notes are here), its history refused, nothing changes
        const forged = newer.text.trim().split("\n");
        forged[0] = JSON.stringify({ ...JSON.parse(forged[0]!), source: randomUUID() });
        const other = await post(world.owner, `${forged.join("\n")}\n`);
        expect([other.status, ((await other.json()) as { historyRefused: string }).historyRefused]).toEqual([200, "join_history_other_source"]);
        expect(await onNode(node, () => joinProgress(world.ws))).toMatchObject({ historyState: how });
        // the newer file, cut after its first page of earlier versions, then whole: it goes on from there and rewrites nothing
        const newerLines = newer.text.trim().split("\n");
        const newerRowsDone = newerLines.findIndex((l) => l.startsWith('{"kind":"rows-done"'));
        const part = await post(world.owner, `${newerLines.slice(0, newerRowsDone + 2).join("\n")}\n`);
        expect(await part.json()).toMatchObject({ pages: 0, history: "arriving", historyRefused: "join_history_file_cut" });
        expect(await codeOf(onNode(node, () => snapshotSourceNode(world.ws)))).toBe("snapshot_source_history_incomplete");
        const held = await xmins(node, world.ws);
        const whole = await post(world.owner, newer.text);
        expect(await whole.json()).toMatchObject({ pages: 0, history: "done", historyRefused: null });
        expect(unchangedSince(held, await xmins(node, world.ws))).toEqual([]);
        // the notes: not one row written, no new stamp; the note written later on the source is not here
        expect(await notes()).toEqual(notesBefore);
        expect(await stamps()).toEqual(stampsBefore);
        expect(notesBefore.some((n) => n.id === newer.fresh)).toBe(false);
        // the earlier versions: every version the source has of the notes this device has, with their positions; those of the newer note were skipped
        const expected = await versionsOn(src, world.ws, notesBefore.map((n) => n.id));
        expect(notesBefore.some((n) => n.id === newer.root)).toBe(true);
        const rootSaves = expected.filter((v) => v.note_id === newer.root).length;
        expect(rootSaves, "the save made on the source after this device took its notes is among them").toBeGreaterThanOrEqual(2);
        expect(await versionsOn(node, world.ws)).toEqual(expected);
        const skipped = await onNode(node, async () => (await q<{ k: string }>(`SELECT e->>'k' AS k FROM sync_join, jsonb_array_elements(history_skipped) e`)).rows.map((r) => r.k));
        expect(skipped.some((k) => k.startsWith(`${newer.fresh}/`)), "the versions of the note this device never had were skipped and counted").toBe(true);
        expect(await codeOf(onNode(node, () => snapshotSourceNode(world.ws)))).toBe("ok");
        // done: another file is a new join of a device that is not empty, refused as before
        const again = await post(world.owner, newer.text);
        expect([again.status, ((await again.json()) as { error: string }).error]).toEqual([409, "join_already_done"]);
      } finally { await node.close(); }
    }, 240_000);
  }
});
