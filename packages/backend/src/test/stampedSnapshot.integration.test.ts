// A workspace copied to an empty database with every row's write stamp kept (services/stampedSnapshot.ts → services/stampedJoin.ts, the owner-only
// routes in routes/stampedSnapshot.ts): the two databases hold the same, table by table (the digest and, as a check of the digest itself, a row-by-row
// comparison); the receiver goes on as a node of its own; what is wrong with a snapshot is refused and leaves no half-copied workspace; the routes
// stream it out and take it in, owner only. SAFETY: two databases made from the migrated template: PGlite databases of this process, or databases
// of the real server of a `_test` DATABASE_URL (helpers/distSim/postgresNodes.ts); the same test bodies run on both.
// (the browser app's packaged database as the receiver is in stampedSnapshotBrowserShell.integration.test.ts)
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getWorkspaceId, migrate, q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, digestAs, exportAs, fillFrom, makeCaller, openNode, outOfScopeIds, rowsOf, snapshotApp, stampsOfWorkspace, type Capture, type SourceWorld } from "./helpers/stampedWorld.js";
import { readStampedPages } from "../services/stampedSnapshot.js";
import { abandonJoin, applyJoinPage, databaseJoinReadiness, finishJoin, joinProgress, startJoin } from "../services/stampedJoin.js";
import { computeSnapshotDigest, compareDigests, type StampedPage } from "../spine/snapshotSql.js";
import { SNAPSHOT_SPECS } from "../spine/snapshotTables.js";
import { CARRIED_LABELS } from "../spine/stampedMerge/index.js";
import { markJoinDone, readJoinProgress } from "../spine/stampedImport.js";
import { standAsideForImport, stampTransaction } from "../spine/stamps.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { buildBootstrap } from "../services/sync/index.js";
import { indexMissingNoteLinks } from "../services/wikilinkEdges.js";
import { snapshotScopeFor } from "../services/readPolicy.js";
import { withActorReadSnapshot } from "../services/actorReadSnapshot.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import type { ActorCtx } from "../types.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? ""); // both engines: a node is a PGlite, or a database of the real server (helpers/distSim/postgresNodes.ts)
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe.skipIf(!isTestDb)("a stamped snapshot copied to an empty database", () => {
  let src: RealNode;
  let dst: RealNode;
  let world: SourceWorld;
  let cap: Capture;

  beforeAll(async () => {
    src = await openNode("source");
    dst = await openNode("receiver");
    world = await buildSourceWorld(src);
    cap = await capture(src, world, 12_000);
    await fillFrom(dst, world, cap);
  }, 120_000);
  afterAll(async () => { await src?.close(); await dst?.close(); });

  it("holds the same in every carried table, in rows and in stamps (digest)", async () => {
    const mine = await digestAs(dst, world.ws, world.owner);
    expect(compareDigests(cap.summary.digest, mine)).toEqual([]);
    // the world really reaches every table, so "equal" is not "both empty"
    const rows = Object.fromEntries(cap.summary.digest.map((d) => [d.table, d.rows]));
    for (const spec of SNAPSHOT_SPECS) expect(rows[spec.table], `no ${spec.table} row in the test world`).toBeGreaterThan(0);
    const stamps = Object.fromEntries(cap.summary.digest.map((d) => [d.table, d.stamps]));
    for (const spec of SNAPSHOT_SPECS.filter((s) => s.stamps)) expect(stamps[spec.table], `no ${spec.table} stamp`).toBeGreaterThan(0);
    expect(cap.pages.length).toBeGreaterThan(2);
  });

  it("holds the same row by row: every column that is carried, and every stamp, one by one", async () => {
    const [a, b] = [await rowsOf(src, world), await rowsOf(dst, world)];
    for (const table of Object.keys(a)) expect(a[table]!.length, `no ${table} row to compare`).toBeGreaterThan(0);
    for (const table of Object.keys(a)) expect(b[table], table).toEqual(a[table]);
    const hidden = await outOfScopeIds(src, world);
    expect(hidden).toContain(world.secretNote);
    const [sa, sb] = [await stampsOfWorkspace(src, world, hidden), await stampsOfWorkspace(dst, world, hidden)];
    expect(sb.length).toBeGreaterThan(50);
    expect(sb).toEqual(sa);
    // the stamps are the source's, as they were: some name the source node, some are genesis, and the receiver's own node is in none
    const origins = new Set(sb.map((s) => s.origin));
    const dstNode = await onNode(dst, async () => (await q<{ node_id: string }>(`SELECT node_id FROM sync_node`)).rows[0]!.node_id);
    expect(origins.has(cap.summary.source)).toBe(true);
    expect(origins.has(dstNode)).toBe(false);
    expect([...origins].every((o) => o === cap.summary.source || o === "genesis")).toBe(true);
  });

  it("the two checks notice a row changed on the receiver: the digest and the row-by-row comparison both differ", async () => {
    const tampered = await openNode("receiver-tampered");
    try {
      await fillFrom(tampered, world, cap);
      const rootId = cap.pages.flatMap((p) => p.items).flatMap((i) => (i.kind === "row" && i.table === "content_nodes" && i.values.title === "Root" ? [String(i.values.id)] : []))[0]!;
      await onNode(tampered, () => seedQ(`UPDATE content_nodes SET title = 'Changed after the copy' WHERE id = $1`, [rootId]));
      const differences = compareDigests(cap.summary.digest, await digestAs(tampered, world.ws, world.owner));
      expect(differences.some((d) => d.table === "content_nodes" && d.what === "rows")).toBe(true);
      expect((await rowsOf(tampered, world)).content_nodes).not.toEqual((await rowsOf(src, world)).content_nodes);
    } finally { await tampered.close(); }
  }, 60_000);

  it("is not a copy of what the owner cannot read, nor of what stays on a node", async () => {
    const text = JSON.stringify(cap.pages);
    expect(text).not.toContain("private words");
    expect(text).not.toContain("friend@example.test");
    expect(text).not.toContain("not-a-real-hash");
    expect(text).not.toContain("etag-of-this-node");
    expect(text).not.toContain("membership_epoch");
    expect(text).not.toContain("url_ciphertext");
    for (const word of ["structure_log", "domain_events", "token", "idempotency"]) expect(text, word).not.toContain(word);
    const noteIds = cap.pages.flatMap((p) => p.items).flatMap((i) => (i.kind === "row" && i.table === "content_nodes" ? [String(i.values.id)] : []));
    expect(noteIds).not.toContain(world.secretNote);
    // no `friend`'s personal row travels with the owner's snapshot
    const prefs = cap.pages.flatMap((p) => p.items).filter((i) => i.kind === "row" && i.table === "actor_prefs").map((i) => String((i as { values: Record<string, unknown> }).values.actor_id));
    expect(prefs).toEqual([world.owner.id]);
    // the receiver holds none of it either
    await onNode(dst, async () => {
      expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [world.secretNote])).rows).toHaveLength(0);
      expect((await q(`SELECT invite_email, invite_token_hash FROM actors WHERE id = $1`, [world.friend.id])).rows[0]).toEqual({ invite_email: null, invite_token_hash: null });
      expect((await q(`SELECT 1 FROM rss_subscriptions WHERE etag IS NOT NULL OR last_error IS NOT NULL`)).rows).toHaveLength(0);
      expect((await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_stamps WHERE row_key LIKE $1`, [`%${world.secretNote}%`])).rows[0]!.n).toBe("0");
    });
  });

  it("leaves a database that is done, with the join counted and the triggers as before", async () => {
    await onNode(dst, async () => {
      const progress = await readJoinProgress(world.ws);
      expect(progress).toMatchObject({ state: "done", sourceNode: cap.summary.source, cutSeq: cap.summary.cut, appliedThrough: cap.pages.length });
      expect(Number((await q<{ n: string }>(`SELECT import_batches::text AS n FROM sync_join WHERE workspace_id = $1`, [world.ws])).rows[0]!.n)).toBe(cap.pages.length);
      // nothing is left to stamp: migration 202's pass finds nothing to add, and a second pass adds nothing either
      const pass = (await q<Record<string, string>>(`SELECT * FROM sync_genesis_pass()`)).rows[0]!;
      expect(Object.values(pass).map(Number)).toEqual([0, 0, 0, 0]);
    });
  });

  it("goes on as a node of its own: its writes are stamped with its own id, from sequence number 1, after what it received", async () => {
    const own = await openNode("receiver-with-writes");
    await fillFrom(own, world, cap);
    const receiver = await onNode(own, async () => {
      const node = (await q<{ node_id: string }>(`SELECT node_id FROM sync_node`)).rows[0]!.node_id;
      const clock = (await q<{ next_seq: string; hlc_wall: string; hlc_counter: number }>(`SELECT next_seq, hlc_wall, hlc_counter FROM sync_clock WHERE workspace_id = $1`, [world.ws])).rows[0]!;
      const received = (await q<{ w: string; c: number }>(`SELECT max(hlc_wall)::text AS w, max(hlc_counter) AS c FROM sync_stamps WHERE workspace_id = $1 AND origin <> 'genesis'`, [world.ws])).rows[0]!;
      const before = Number((await q<{ n: string }>(`SELECT writes_without_mutate::text AS n FROM sync_clock WHERE workspace_id = $1`, [world.ws])).rows[0]!.n);
      const call = makeCaller(world.owner);
      const id = (await call("POST", "/api/nodes", { title: "Written on the receiver", markdown: "x", space_id: world.spaceA })).id as string;
      const root = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE title = 'Root'`)).rows[0]!.id;
      await call("PATCH", `/api/nodes/${root}`, { title: "Root, edited on the receiver" });
      const stampOf = async (key: string, field: string) => (await q<{ origin: string; seq: string; hlc_wall: string; hlc_counter: number }>(
        `SELECT origin, seq::text, hlc_wall::text, hlc_counter FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = $3`, [world.ws, key, field])).rows[0]!;
      const created = await stampOf(id, "*");
      const edited = await stampOf(root, "title");
      const after = Number((await q<{ n: string }>(`SELECT writes_without_mutate::text AS n FROM sync_clock WHERE workspace_id = $1`, [world.ws])).rows[0]!.n);
      return { node, clock, received, created, edited, before, after };
    });
    expect(receiver.clock.next_seq).toBe("1");
    expect([receiver.created.origin, receiver.edited.origin]).toEqual([receiver.node, receiver.node]);
    expect([Number(receiver.created.seq), Number(receiver.edited.seq)]).toEqual([1, 2]);
    // the edit wins over the stamp the title came with: its clock reading is later
    const later = (a: { wall: number; counter: number }, b: { wall: number; counter: number }) => a.wall > b.wall || (a.wall === b.wall && a.counter > b.counter);
    expect(later({ wall: Number(receiver.edited.hlc_wall), counter: receiver.edited.hlc_counter }, { wall: Number(receiver.received.w), counter: receiver.received.c })).toBe(true);
    expect(receiver.after).toBe(receiver.before); // every write came through the write entry: none made its own stamp
    // a copy that holds the source's stamps and its own is a source in turn (own-node-transport batch 2): its snapshot brings the node it joined from, at the cut it took, in every label
    const relayed = await onNode(own, () => readStampedPages(world.owner, world.ws, { since: null, layer: "rows" }, async () => undefined));
    expect(relayed.source).toBe(receiver.node);
    expect(Object.keys(relayed.brought).sort()).toEqual([...CARRIED_LABELS].sort());
    for (const of of Object.values(relayed.brought)) expect(of).toEqual({ [cap.summary.source]: cap.summary.cut });
    await own.close();
  }, 60_000);

  it("links the sign-in of the device to the person's row, and to no one else's; the snapshot never carries a sign-in", async () => {
    const linked = await openNode("receiver-with-login");
    try {
      await fillFrom(linked, world, cap, { localLogin: "login-of-this-device" });
      await onNode(linked, async () => {
        const logins = (await q<{ id: string; external_id: string | null; type: string }>(`SELECT id::text, external_id, type FROM actors WHERE workspace_id = $1 AND external_id IS NOT NULL`, [world.ws])).rows;
        // the person (a human) now answers to this device's sign-in; the only other link is the System account's, which travels as it is
        expect(logins.filter((a) => a.type === "human")).toEqual([{ id: world.owner.id, external_id: "login-of-this-device", type: "human" }]);
      });
      // the digest does not see the link: it is not part of what a snapshot carries
      expect(compareDigests(cap.summary.digest, await digestAs(linked, world.ws, world.owner))).toEqual([]);
    } finally { await linked.close(); }
  }, 60_000);

  it("reads the same notes as the source does: after the derived data is worked out again, bootstrap of the owner counts as many notes on both", async () => {
    // what is derived from the note text is not carried: the receiver works it out itself (the catch-up the product already runs)
    await onNode(dst, () => indexMissingNoteLinks({ workspaceId: world.ws }));
    const count = (node: RealNode) => onNode(node, async () => {
      const boot = await buildBootstrap(world.owner, world.ws, { slimBodies: true });
      return (boot.nodes as unknown[]).length;
    });
    // the owner reads the same notes on the receiver as on the source (the system space's notes are neither carried nor read by the owner)
    expect(await count(dst)).toBe(await count(src));
  });

  it("refuses what is not done, and a token", async () => {
    const run = (options: Parameters<typeof readStampedPages>[2], who = world.owner) => onNode(src, () => readStampedPages(who, world.ws, options, async () => undefined));
    await expect(run({ since: { origin: 1 } as never, layer: "rows" })).rejects.toMatchObject({ code: "snapshot_since_not_done" });
    await expect(run({ since: null, layer: "history" })).rejects.toMatchObject({ code: "snapshot_layer_not_done" });
    await expect(run({ since: null, layer: "blobs" })).rejects.toMatchObject({ code: "snapshot_layer_not_done" });
    await expect(run({ since: null, layer: "rows" }, { ...world.owner, tokenScope: { access: "read", allowedTools: [], tokenId: "t" } as never })).rejects.toThrow(/reserved to a person/);
  });

  it("a limited reader's snapshot is what that reader can read, and a receiver of it digests the same", async () => {
    // the friend reads the secret space and space B but not space A: their snapshot has a different set of notes than the owner's
    const friendCap = await capture(src, { ws: world.ws, owner: world.friend });
    const notes = friendCap.pages.flatMap((p) => p.items).flatMap((i) => (i.kind === "row" && i.table === "content_nodes" ? [String(i.values.title)] : []));
    expect(notes).toContain("Friend only");
    expect(notes).not.toContain("Root");
    expect(JSON.stringify(friendCap.pages)).not.toContain("Owner's own");
    const mine = await onNode(src, () => withActorReadSnapshot(world.friend, world.ws, async (a) => computeSnapshotDigest(world.ws, await snapshotScopeFor(a))));
    expect(compareDigests(friendCap.summary.digest, mine)).toEqual([]);
  });
});

describe.skipIf(!isTestDb)("a stamped snapshot import refuses what is wrong and leaves nothing behind", () => {
  let src: RealNode;
  let world: SourceWorld;
  let cap: Capture;
  const opened: RealNode[] = [];
  const receiver = async (name: string) => { const n = await openNode(name); opened.push(n); return n; };

  beforeAll(async () => {
    src = await openNode("source");
    world = await buildSourceWorld(src);
    cap = await capture(src, world, 12_000);
  }, 120_000);
  // Each test's receivers are closed when it ends: the in-memory databases held until the end of the file took 3 GB and the
  // worker was killed for memory on a 7 GB machine (2026-11-16).
  afterEach(async () => { for (const n of opened.splice(0)) await n.close(); });
  afterAll(async () => { await src?.close(); });

  // EVERY refusal case of this file goes through `join`, so each one is also a check that the read-only probe (what GET /api/snapshot/readiness answers)
  // said the same thing the join then did: ready when the join went through, the same code (and, for a not-empty database, the same kind) when it refused.
  const join = async (node: RealNode, c: Capture = cap) => {
    const probe = await onNode(node, () => databaseJoinReadiness());
    try {
      await onNode(node, () => startJoin({ workspaceId: world.ws, sourceNode: c.summary.source, cutSeq: c.summary.cut, personActorId: world.owner.id }));
    } catch (error) {
      const refused = error as { code?: string; message: string };
      expect(probe, `the probe said ${JSON.stringify(probe)} but the join refused with ${refused.code}`).toMatchObject({ ready: false, code: refused.code });
      if (!probe.ready && "kind" in probe && probe.kind !== null) expect(refused.message).toContain(probe.kind);
      throw error;
    }
    expect(probe.ready, `the probe refused (${JSON.stringify(probe)}) but the join went through`).toBe(true);
  };
  const apply = (node: RealNode, page: StampedPage) => onNode(node, () => applyJoinPage(page));
  const finish = (node: RealNode, c: Capture = cap, pages = c.pages.length) => onNode(node, () => finishJoin({ workspaceId: world.ws, pages, digest: c.summary.digest, localLogin: null }));
  const abandon = (node: RealNode) => onNode(node, () => abandonJoin(world.ws));
  /** Nothing of the workspace is left: no row, no stamp, no clock, no join record. */
  const expectNothingLeft = (node: RealNode) => onNode(node, async () => {
    for (const table of ["workspaces", "content_nodes", "spaces", "actors", "sync_stamps", "sync_clock", "sync_join"]) {
      const column = table === "workspaces" ? "id" : "workspace_id";
      expect((await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${column} = $1`, [world.ws])).rows[0]!.n, table).toBe("0");
    }
  });
  const pagesWith = (edit: (pages: StampedPage[]) => void) => { const pages = clone(cap.pages); edit(pages); return pages; };
  const firstRow = (pages: StampedPage[], table: string) => { for (const p of pages) for (const i of p.items) if (i.kind === "row" && i.table === table) return i; throw new Error(`no ${table} row`); };

  /** Apply `pages` to a fresh receiver and finish: whatever goes wrong must end with nothing left (fillFrom abandons on a refusal). */
  const refused = async (name: string, pages: StampedPage[], matcher: RegExp | string, pageCount = pages.length) => {
    const node = await receiver(name);
    await expect(fillFrom(node, world, { pages, summary: { ...cap.summary, pages: pageCount } })).rejects.toThrow(matcher);
    await expectNothingLeft(node);
  };

  it("a page applied twice is the same as once; a page number applied with other content, or one page too many, is refused", async () => {
    const node = await receiver("repeated");
    await join(node);
    expect((await apply(node, cap.pages[0]!)).applied).toBe(true);
    expect((await apply(node, cap.pages[0]!)).applied).toBe(false);
    const changed = clone(cap.pages[0]!);
    (changed.items.find((i) => i.kind === "row" && i.table === "actors") as { values: Record<string, unknown> }).values.name = "Someone else";
    await expect(apply(node, changed)).rejects.toThrow(/already applied with other content/);
    for (const page of cap.pages.slice(1)) await apply(node, page);
    await apply(node, { ...clone(cap.pages[1]!), page: cap.pages.length + 1 }); // the same rows again under a new number
    await expect(finish(node)).rejects.toThrow(/more pages arrived/);
    expect((await onNode(node, () => joinProgress(world.ws)))!.state).toBe("joining");
    await abandon(node);
    await expectNothingLeft(node);
  }, 60_000);

  it("a stamp far ahead of this machine's clock refuses its whole page: nothing of it is written and the clock does not move", async () => {
    // a stamp the source itself made (not a genesis stamp, which every row shares): its clock reading is put an hour past the bound
    const pages = pagesWith((p) => {
      const stamp = p.flatMap((page) => page.items).flatMap((i) => (i.kind === "row" && i.table === "content_nodes" ? i.stamps : [])).find((s) => s.origin === cap.summary.source);
      stamp!.wall = Date.now() + 10 * 60 * 1000 + 3_600_000;
    });
    const node = await receiver("clock-ahead");
    await join(node);
    const at = pages.findIndex((p) => p.items.some((i) => i.kind === "row" && i.table === "content_nodes" && i.stamps.some((s) => s.wall > Date.now() + 10 * 60 * 1000)));
    for (const page of pages.slice(0, at)) await apply(node, page);
    await expect(apply(node, pages[at]!)).rejects.toThrow(/too far ahead/);
    await onNode(node, async () => {
      // none of the refused page's notes is in the database (the pages before it are)
      const refusedIds = pages[at]!.items.flatMap((i) => (i.kind === "row" && i.table === "content_nodes" ? [String(i.values.id)] : []));
      expect(refusedIds.length).toBeGreaterThan(0);
      expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes WHERE id = ANY($1::uuid[])`, [refusedIds])).rows[0]!.n)).toBe(0);
      const clock = (await q<{ hlc_wall: string }>(`SELECT hlc_wall::text FROM sync_clock WHERE workspace_id = $1`, [world.ws])).rows[0];
      expect(Number(clock?.hlc_wall ?? 0)).toBeLessThan(Date.now() + 60_000);
      expect((await joinProgress(world.ws))!.pages).not.toContain(pages[at]!.page);
    });
    await abandon(node);
    await expectNothingLeft(node);
  }, 60_000);

  it("a stamp that names this node's own id is refused", async () => {
    const node = await receiver("own-id");
    const own = await onNode(node, async () => (await q<{ node_id: string }>(`SELECT node_id FROM sync_node`)).rows[0]!.node_id);
    await join(node);
    const page = clone(cap.pages[0]!);
    const row = page.items.find((i) => i.kind === "row" && i.stamps.length > 0);
    if (row?.kind === "row") row.stamps[0]!.origin = own;
    else page.items.push({ kind: "tombstone", table: "spaces", stamp: { label: "spaces", rowKey: "x", field: "*", origin: own, seq: 1, wall: 1, counter: 0, author: null, device: null, deleted: true, saw: {}, meta: null, heads: [] } });
    await expect(apply(node, page)).rejects.toThrow(/made on this node/);
    await abandon(node);
  }, 60_000);

  it("refuses an origin the snapshot does not vouch for, one stamp number with two contents, a table or column that is not carried, a row of another workspace, a sign-in", async () => {
    const node = await receiver("malformed");
    await join(node);
    const page0 = cap.pages[0]!;
    const stampOf = (pages: StampedPage[]) => { const row = firstRow(pages, "content_nodes"); if (row.kind !== "row") throw new Error(); return row; };
    const withRow = (edit: (page: StampedPage) => void) => { const page = clone(page0); edit(page); return page; };
    const cases: [string, StampedPage, RegExp][] = [
      ["a third origin", withRow((p) => { p.items.push({ kind: "tombstone", table: "spaces", stamp: { label: "spaces", rowKey: "k", field: "*", origin: "someone-else", seq: 1, wall: 1, counter: 0, author: null, device: null, deleted: true, saw: {}, meta: null, heads: [] } }); }), /does not vouch/],
      ["one stamp number, two contents", withRow((p) => { const s = { label: "spaces", rowKey: "k", field: "*", origin: cap.summary.source, seq: 9, wall: 1, counter: 0, author: null, device: null, deleted: true, saw: {}, meta: null, heads: [] }; p.items.push({ kind: "tombstone", table: "spaces", stamp: s }, { kind: "tombstone", table: "spaces", stamp: { ...s, rowKey: "k2", wall: 2 } }); }), /two different contents/],
      ["a table that is not carried", withRow((p) => { p.items.push({ kind: "row", table: "domain_events", values: { id: 1 }, stamps: [] }); }), /does not carry/],
      ["a column that is not carried", withRow((p) => { (p.items.find((i) => i.kind === "row" && i.table === "workspaces") as { values: Record<string, unknown> }).values.membership_epoch = 99; }), /does not carry/],
      ["a row of another workspace", withRow((p) => { p.items = [{ kind: "row", table: "spaces", values: { ...(firstRow([page0], "spaces") as { values: Record<string, unknown> }).values, workspace_id: "00000000-0000-4000-8000-000000000000" }, stamps: [] }]; }), /another workspace/],
      ["a person that signs in through the snapshot", withRow((p) => { (p.items.find((i) => i.kind === "row" && i.table === "actors" && i.values.type === "human") ?? p.items.find((i) => i.kind === "row" && i.table === "actors") as { values: Record<string, unknown> }); const a = p.items.find((i) => i.kind === "row" && i.table === "actors") as { values: Record<string, unknown> }; a.values.type = "human"; a.values.external_id = "a-login"; }), /sign-in/],
    ];
    void stampOf;
    for (const [what, page, matcher] of cases) await expect(apply(node, page), what).rejects.toThrow(matcher);
    // none of it was written, and the page number is still free
    await onNode(node, async () => {
      expect((await q<{ n: string }>(`SELECT count(*)::text AS n FROM workspaces WHERE id = $1`, [world.ws])).rows[0]!.n).toBe("0");
      expect((await joinProgress(world.ws))!.pages).toEqual([]);
    });
    await abandon(node);
  }, 60_000);

  it("a workspace that already holds notes of its own is not joined, and a second join cannot start", async () => {
    const node = await receiver("not-empty");
    await onNode(node, async () => {
      const ws = await getWorkspaceId();
      const actor = await persistActor(ws, { id: "", name: "Local", role: "admin", type: "human" });
      const space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
      await makeCaller(actor)("POST", "/api/nodes", { title: "My own note", markdown: "mine", space_id: space });
    });
    await expect(join(node)).rejects.toThrow(/content of its own/);
    await onNode(node, async () => {
      expect((await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes WHERE title = 'My own note'`)).rows[0]!.n).toBe("1");
    });
    const empty = await receiver("second-join");
    await join(empty);
    await expect(join(empty)).rejects.toThrow(/already running/);
    await abandon(empty);
  }, 60_000);

  /** The person of an empty database who joins: a human with a sign-in, the owner (what a first sign-in makes). */
  const shellPerson = (node: RealNode) => onNode(node, async () => {
    const ws = await getWorkspaceId();
    const actor = await persistActor(ws, { id: "", name: "Local", role: "admin", type: "human" });
    await seedQ(`UPDATE actors SET external_id = $1 WHERE id = $2`, [`login-${actor.id}`, actor.id]);
    return actor;
  });
  const joinAs = (node: RealNode, person: ActorCtx) => onNode(node, () => startJoin({ workspaceId: world.ws, sourceNode: cap.summary.source, cutSeq: cap.summary.cut, personActorId: world.owner.id, shellPersonId: person.id }));
  /** The same person, in the empty database again: their row (same id), their sign-in, the ownership; nobody else, one workspace. */
  const expectPersonBack = (node: RealNode, person: ActorCtx) => onNode(node, async () => {
    const back = (await q<{ external_id: string | null; owner: boolean; workspaces: string; humans: string }>(
      `SELECT a.external_id, (w.owner_actor_id = a.id) AS owner, (SELECT count(*)::text FROM workspaces) AS workspaces, (SELECT count(*)::text FROM actors WHERE type = 'human') AS humans
         FROM actors a JOIN workspaces w ON w.id = a.workspace_id WHERE a.id = $1`, [person.id])).rows[0];
    expect(back).toEqual({ external_id: `login-${person.id}`, owner: true, workspaces: "1", humans: "1" });
  });

  it("cancelling puts back the empty database at once: the snapshot is gone, the usual empty workspace is there with the same person, and it can join again", async () => {
    const node = await receiver("cancelled");
    const person = await shellPerson(node);
    await joinAs(node, person);
    await apply(node, cap.pages[0]!);
    await apply(node, cap.pages[1]!);
    await abandon(node);
    await expectNothingLeft(node);
    // the empty workspace is made again at once, in this process: no restart is needed to sign in or to try again; the person who tried is in it
    await onNode(node, async () => { expect(await getWorkspaceId()).toBeTruthy(); });
    await expectPersonBack(node, person);
    // and it can join again
    await fillFrom(node, world, cap);
  }, 90_000);

  it("a join cut off by a dead process is discarded at the next start: the database is the empty one again, with the same person, and can join", async () => {
    const node = await receiver("died");
    const person = await shellPerson(node);
    await joinAs(node, person);
    await apply(node, cap.pages[0]!);
    await apply(node, cap.pages[1]!);
    // no abandon: the process died here. The next start is migrate().
    await onNode(node, async () => {
      expect((await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_join WHERE state = 'joining'`)).rows[0]!.n).toBe("1");
      await migrate({ seedNativeActor: true });
      expect((await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_join`)).rows[0]!.n).toBe("0");
      expect(await getWorkspaceId()).toBeTruthy();
    });
    await expectNothingLeft(node);
    await expectPersonBack(node, person);
    await fillFrom(node, world, cap);
  }, 90_000);

  it("a database where someone already wrote is not taken for empty, whatever they wrote: a tag, a second person, a personal row", async () => {
    const cases: [string, (ws: string, actor: ActorCtx) => Promise<void>][] = [
      ["a tag of their own", async (_ws, actor) => { await makeCaller(actor)("POST", "/api/tags", { name: `mine-${Math.random().toString(36).slice(2, 8)}` }); }],
      ["a second person", async (ws) => { await persistActor(ws, { id: "", name: "Second", role: "editor", type: "human" }); }],
      ["a row of the tables a fresh install leaves empty", async (_ws, actor) => { await seedQ(`INSERT INTO actor_prefs (actor_id, key, value) VALUES ($1, 'theme', '"dark"'::jsonb)`, [actor.id]); }],
    ];
    for (const [what, write] of cases) {
      const node = await receiver(`written-${what.slice(0, 6)}`);
      await onNode(node, async () => {
        const ws = (await q<{ id: string }>(`SELECT id::text FROM workspaces WHERE slug = 'default'`)).rows[0]!.id;
        await write(ws, await persistActor(ws, { id: "", name: "Local", role: "admin", type: "human" }));
      });
      await expect(join(node), what).rejects.toThrow(/content of its own/);
      await onNode(node, async () => { expect((await q<{ n: string }>(`SELECT count(*)::text AS n FROM workspaces`)).rows[0]!.n, what).toBe("1"); });
    }
  }, 120_000);

  it("says which kind of thing made the database not empty (a preference is one: the rule is listed for the owner), and a stamp of the System account's own work is not one", async () => {
    const lone = await receiver("preference-only");
    await onNode(lone, async () => {
      const ws = (await q<{ id: string }>(`SELECT id::text FROM workspaces WHERE slug = 'default'`)).rows[0]!.id;
      const actor = await persistActor(ws, { id: "", name: "Local", role: "admin", type: "human" });
      await seedQ(`INSERT INTO actor_prefs (actor_id, key, value) VALUES ($1, 'language', '"zh-TW"'::jsonb)`, [actor.id]);
    });
    await expect(join(lone)).rejects.toThrow(/prefs/);
    const worked = await receiver("system-work");
    await onNode(worked, async () => {
      const ws = (await q<{ id: string }>(`SELECT id::text FROM workspaces WHERE slug = 'default'`)).rows[0]!.id;
      const system = (await q<{ id: string }>(`SELECT id::text FROM actors WHERE workspace_id = $1 AND type = 'agent' LIMIT 1`, [ws])).rows[0]!.id;
      const node = (await q<{ node_id: string }>(`SELECT node_id FROM sync_node`)).rows[0]!.node_id;
      // what a background job's write leaves: a stamp of this node with the System account as its author
      await seedQ(`INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted) VALUES ($1, 'spaces', 'background-job-row', '*', $2, 900001, 1, 0, $3, NULL, false)`, [ws, node, system]);
    });
    await join(worked);
    await abandon(worked);
  }, 120_000);

  it("the module switches an install turns off are the same set in either order (stored sorted since migration 209, unsorted before): the probe and the join both take the database for empty; another set is not", async () => {
    // the install's set as two databases can hold it: sorted (written after 209), and in the order an install wrote it before 209 (the sorting trigger is set aside to write it so)
    for (const [what, off, empty] of [
      ["sorted", ["external_calendars", "skills"], true],
      ["install order", ["skills", "external_calendars"], true],
      ["another set", ["skills"], false],
    ] as const) {
      const node = await receiver(`switches-${what.replace(/ /g, "-")}`);
      await onNode(node, async () => {
        await seedQ(`ALTER TABLE workspaces DISABLE TRIGGER workspaces_sets_sorted`);
        await seedQ(`UPDATE workspaces SET modules_off = $1::jsonb WHERE slug = 'default'`, [JSON.stringify(off)]);
        await seedQ(`ALTER TABLE workspaces ENABLE TRIGGER workspaces_sets_sorted`);
        expect((await q<{ t: string }>(`SELECT modules_off::text AS t FROM workspaces WHERE slug = 'default'`)).rows[0]!.t, what).toBe(JSON.stringify(off).replace(/","/g, '", "'));
      });
      if (empty) { await join(node); await abandon(node); } // `join` also checks that the probe (GET /api/snapshot/readiness) said the same
      else await expect(join(node), what).rejects.toThrow(/module_switch/);
    }
  }, 120_000);

  it("a tag a person made is not taken for empty even when its only stamps are genesis and the history is pruned (the rows an install makes are told by name, not by stamp); the one thing that stays unseen, an install row edited without a stamp or an event, is pinned", async () => {
    const node = await receiver("pruned-history-tag");
    const tagId = await onNode(node, async () => {
      const ws = (await q<{ id: string }>(`SELECT id::text FROM workspaces WHERE slug = 'default'`)).rows[0]!.id;
      const tag = (await makeCaller(await persistActor(ws, { id: "", name: "Local", role: "admin", type: "human" }))("POST", "/api/tags", { name: "made-by-a-person" })).id as string;
      // the history is pruned and what the person's write stamped is taken back to genesis, as migration 202 leaves rows made before stamps
      await seedQ(`DO $$ BEGIN PERFORM set_config('myapp.allow_event_prune', 'on', true); DELETE FROM domain_events WHERE workspace_id = '${ws}' AND actor_type <> 'system'; END $$`);
      await seedQ(`DELETE FROM sync_stamps WHERE workspace_id = $1`, [ws]);
      await q(`SELECT * FROM sync_genesis_pass()`);
      return tag;
    });
    await expect(join(node)).rejects.toMatchObject({ code: "join_not_empty" });
    await onNode(node, async () => { expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [tagId])).rows).toHaveLength(1); });

    // KNOWN LIMIT, pinned: a built-in tag a person edited whose only stamps are genesis and whose history is pruned looks like the install's own, and the join replaces it
    // What an install makes is told by NAME (the built-in tags, the default / system / restricted / personal spaces …), so a person's own tag or
    // space is seen whatever its stamps say. What cannot be told is a row the install makes, EDITED without a stamp and without an event: its
    // history was pruned and its stamp was taken back to genesis (made before stamps existed, kept by migration 202). Expected, for now: the join
    // succeeds and that edit is gone. The layer above must not offer "add this device" to a database a person has used.
    const editNode = await receiver("pruned-history-edit");
    const edited = await onNode(editNode, async () => {
      const ws = (await q<{ id: string }>(`SELECT id::text FROM workspaces WHERE slug = 'default'`)).rows[0]!.id;
      await persistActor(ws, { id: "", name: "Local", role: "admin", type: "human" });
      await seedQ(`DO $$ BEGIN PERFORM set_config('myapp.allow_event_prune', 'on', true); DELETE FROM domain_events WHERE workspace_id = '${ws}' AND actor_type <> 'system'; END $$`);
      await seedQ(`UPDATE content_nodes SET tag_schema = '{"fields": [{"name": "edited"}]}'::jsonb WHERE workspace_id = $1 AND node_type = 'class_tag' AND title = 'book'`, [ws]);
      await seedQ(`DELETE FROM sync_stamps WHERE workspace_id = $1`, [ws]);
      await q(`SELECT * FROM sync_genesis_pass()`);
      return (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = 'book' AND node_type = 'class_tag'`, [ws])).rows[0]!.id;
    });
    await join(editNode);
    await onNode(editNode, async () => { expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [edited])).rows).toHaveLength(0); });
    await abandon(editNode);
  }, 120_000);

  it("rows out of the order of the table list are refused, inside a page and across pages", async () => {
    const node = await receiver("order");
    await join(node);
    const rowOf = (table: string) => clone(cap.pages.flatMap((p) => p.items).find((i) => i.kind === "row" && i.table === table)!);
    const backwards = { ...clone(cap.pages[0]!), items: [rowOf("spaces"), rowOf("workspaces")] };
    await expect(apply(node, backwards)).rejects.toThrow(/order of its table list/);
    await apply(node, cap.pages[0]!); // the workspace, the people, the spaces: in order
    const late = { ...clone(cap.pages[0]!), page: 90, items: [rowOf("actors")] };
    await expect(apply(node, late)).rejects.toThrow(/order of its table list/);
    await abandon(node);
  }, 60_000);

  it("a workspace that is being filled takes no other write: the write entry refuses it", async () => {
    const node = await receiver("no-writes");
    await join(node);
    await apply(node, cap.pages[0]!);
    await onNode(node, async () => {
      await expect(withEventTransaction(world.ws, () => stampTransaction(world.ws, world.owner.id))).rejects.toMatchObject({ code: "workspace_joining", status: 409 });
    });
    await abandon(node);
  }, 60_000);

  it("the person the hello names must be a human who owns the snapshot's workspace: an agent, a member who is not the owner and a stranger are refused, and nothing is left", async () => {
    // WHO THE SIGN-IN BECOMES (spine/stampedImport.ts markJoinDone): only the owner of the snapshot's workspace; nothing else of a request picks a person
    const agent = String(cap.pages.flatMap((p) => p.items).flatMap((i) => (i.kind === "row" && i.table === "actors" && i.values.type === "agent" ? [i.values.id] : []))[0]);
    const cases: [string, string, RegExp][] = [["an agent", agent, /names a person it does not hold/], ["a member who does not own the workspace", world.friend.id, /does not own the workspace/], ["a person the snapshot does not hold", "00000000-0000-4000-8000-0000000000a9", /names a person it does not hold/]];
    for (const [what, person, message] of cases) {
      const node = await receiver(`person-${what.slice(0, 8)}`);
      await onNode(node, () => startJoin({ workspaceId: world.ws, sourceNode: cap.summary.source, cutSeq: cap.summary.cut, personActorId: person }));
      for (const page of cap.pages) await apply(node, page);
      await expect(onNode(node, () => finishJoin({ workspaceId: world.ws, pages: cap.pages.length, digest: cap.summary.digest, localLogin: "a-login" })), what).rejects.toThrow(message);
      // the sign-in is linked to nobody, and the join is still open (nothing became "done")
      await onNode(node, async () => {
        expect((await q(`SELECT 1 FROM actors WHERE external_id = 'a-login'`)).rows).toHaveLength(0);
        expect((await joinProgress(world.ws))!.state).toBe("joining");
      });
      await abandon(node);
      await expectNothingLeft(node);
    }
  }, 120_000);

  it("the triggers stand aside only inside a join: the setting alone, without a join record, changes nothing", async () => {
    const node = await receiver("stray-setting");
    await onNode(node, async () => {
      const ws = await getWorkspaceId();
      const space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
      const id = "00000000-0000-4000-8000-0000000000aa";
      await withEventTransaction(ws, async () => {
        await standAsideForImport(ws);
        await q(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, space_id) VALUES ($1, $2, 'manual', 'content', 'stray', 'stray-a', $3)`, [id, ws, space]);
      });
      expect((await q(`SELECT 1 FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2`, [ws, id])).rows).toHaveLength(1);
    });
  }, 60_000);
});

const appFor = snapshotApp;

describe.skipIf(!isTestDb)("the snapshot routes", () => {
  let src: RealNode;
  let dst: RealNode;
  let world: SourceWorld;
  let text = "";

  beforeAll(async () => {
    src = await openNode("route-source");
    dst = await openNode("route-receiver");
    world = await buildSourceWorld(src);
    // the answer is a stream that holds the owner's read snapshot (a connection) until its last line is read: read it while still on the node
    const res = await onNode(src, async () => {
      const response = await exportAs(world.owner);
      return { status: response.status, contentType: response.headers.get("content-type") ?? "", text: await response.text() };
    });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/x-ndjson");
    text = res.text;
  }, 120_000);
  afterAll(async () => { await src?.close(); await dst?.close(); });

  it("streams hello, pages and a manifest, one message a line", () => {
    const lines = text.trim().split("\n").map((l) => JSON.parse(l) as { kind: string });
    expect(lines[0]!.kind).toBe("hello");
    expect(lines.at(-1)!.kind).toBe("manifest");
    expect(lines.slice(1, -1).every((l) => l.kind === "page")).toBe(true);
    expect(lines[0]).toMatchObject({ workspaceId: world.ws, person: world.owner.id });
  });

  it("answers a person who is not the owner, and a token, with 403 before anything is read", async () => {
    const res = await onNode(src, async () => appFor(world.friend).request("/api/snapshot"));
    expect(res.status).toBe(403);
    const token = await onNode(src, async () => appFor({ ...world.owner, tokenScope: { access: "read", allowedTools: [], tokenId: "t" } as never }).request("/api/snapshot"));
    expect(token.status).toBe(403);
    const none = await onNode(src, async () => appFor(null).request("/api/snapshot"));
    expect([401, 403]).toContain(none.status);
  });

  it("fills an empty database from the stream, owner only; an upload that stops half way leaves the empty database", async () => {
    // on the receiver the one local person is the owner (the first human of a workspace is)
    const local = await onNode(dst, async () => {
      const ws = (await q<{ id: string }>(`SELECT id::text FROM workspaces WHERE slug = 'default'`)).rows[0]!.id;
      const actor = await persistActor(ws, { id: "", name: "Local", role: "admin", type: "human" });
      await seedQ(`UPDATE actors SET external_id = 'login-of-local-first' WHERE id = $1`, [actor.id]);
      return { ws, actor };
    });
    const cutOff = text.slice(0, text.indexOf("\n", Math.floor(text.length / 2)) + 1); // no manifest
    const half = await onNode(dst, async () => appFor(local.actor).request("/api/snapshot", { method: "POST", body: cutOff }));
    expect(half.status).toBe(422);
    expect(((await half.json()) as { error: string }).error).toBe("join_incomplete");
    await onNode(dst, async () => {
      expect((await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes WHERE workspace_id = $1`, [world.ws])).rows[0]!.n).toBe("0");
      expect((await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_join`)).rows[0]!.n).toBe("0");
    });
    // the empty workspace is back at once, with the SAME person in it: their row, their sign-in and the ownership (not a new row the next
    // sign-in would make under another id); no restart, no second person
    await onNode(dst, async () => {
      const back = (await q<{ external_id: string | null; owner: boolean; workspaces: string; humans: string }>(
        `SELECT a.external_id, (w.owner_actor_id = a.id) AS owner, (SELECT count(*)::text FROM workspaces) AS workspaces, (SELECT count(*)::text FROM actors WHERE type = 'human') AS humans
           FROM actors a JOIN workspaces w ON w.id = a.workspace_id WHERE a.id = $1`, [local.actor.id])).rows[0];
      expect(back).toEqual({ external_id: "login-of-local-first", owner: true, workspaces: "1", humans: "1" });
    });
    const local2 = local.actor;
    // a delegated token is not a person: refused before anything is read
    const asToken = { ...local2, tokenScope: { access: "write", allowedTools: [], tokenId: "t" } as never };
    expect((await onNode(dst, async () => appFor(asToken).request("/api/snapshot", { method: "POST", body: text }))).status).toBe(403);
    const ok = await onNode(dst, async () => appFor(local2).request("/api/snapshot", { method: "POST", body: text }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { pages: number }).pages).toBeGreaterThan(0);
    await onNode(dst, async () => {
      expect((await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes WHERE workspace_id = $1 AND title = 'Root'`, [world.ws])).rows[0]!.n).toBe("1");
      expect((await q<{ state: string }>(`SELECT state FROM sync_join WHERE workspace_id = $1`, [world.ws])).rows[0]!.state).toBe("done");
    });
  }, 120_000);

  it("refuses a line that is not a message, and a page before the hello", async () => {
    const empty = await openNode("route-receiver-2");
    try {
      const actor = await onNode(empty, async () => {
        const ws = (await q<{ id: string }>(`SELECT id::text FROM workspaces WHERE slug = 'default'`)).rows[0]!.id;
        const a = await persistActor(ws, { id: "", name: "Local", role: "admin", type: "human" });
        await seedQ(`UPDATE actors SET external_id = 'login-of-local' WHERE id = $1`, [a.id]);
        return a;
      });
      const post = (body: string) => onNode(empty, async () => appFor(actor).request("/api/snapshot", { method: "POST", body }));
      const junk = await post("not json\n");
      expect([junk.status, ((await junk.json()) as { error: string }).error]).toEqual([422, "join_bad_line"]);
      const page = text.split("\n")[1]!;
      const early = await post(`${page}\n`);
      expect([early.status, ((await early.json()) as { error: string }).error]).toEqual([422, "join_bad_line"]);
      expect((await onNode(empty, async () => (await q<{ n: string }>(`SELECT count(*)::text AS n FROM workspaces`)).rows[0]!.n))).toBe("1");
    } finally { await empty.close(); }
  }, 60_000);
});
