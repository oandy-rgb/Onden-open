// Write stamps and the structure change log (db/migrations/190_sync_stamps.sql, spine/stamps.ts), through the real
// routes: what each kind of note write stamps, that a cascade and a nested write share the root's stamp, that a write
// that skipped mutate() is stamped and counted, and that the clock the database uses agrees with hlc.ts.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, pool, q, withTransaction } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import spaceRouter from "../routes/spaces.js";
import eventRouter from "../routes/events.js";
import backupRouter from "../routes/backup.js";
import syncRouter from "../routes/sync.js";
import { withRequestDevice } from "../requestContext.js";
import type { ActorCtx } from "../types.js";
import { tick } from "../hlc.js";
import { adoptForeignStamp, countWritesWithoutStamp } from "../spine/stamps.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { createNote } from "../services/noteCreate.js";
import { ensureOwnNodeId, forgetNodeId } from "../browser/nodeIdentity.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { zipEntries } from "./helpers/zipEntries.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const DEVICE = randomUUID();

type Stamp = { field: string; origin: string; seq: number; hlc_wall: number; hlc_counter: number; author: string | null; device: string | null; deleted: boolean };

describe.skipIf(!isTestDb)("write stamps on content_nodes", () => {
  let ws = "";
  let owner!: ActorCtx;
  let spaceA = "";
  let spaceB = "";
  const server = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  server.onError(apiOnError);
  server.use("*", async (c, next) => { c.set("actor", owner); await withRequestDevice(DEVICE, next); });
  server.route("/api/nodes", nodeRouter);
  server.route("/api/spaces", spaceRouter);
  server.route("/api/events", eventRouter);
  server.route("/api/backup", backupRouter);
  server.route("/api/sync", syncRouter);

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await server.request(path, {
      method, headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { status: res.status, json };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    expect(r.status, `${method} ${path}: ${JSON.stringify(r.json)}`).toBeLessThan(300);
    return r.json;
  };
  const create = async (extra: Record<string, unknown> = {}) => (await ok("POST", "/api/nodes", {
    id: randomUUID(), title: `stamp ${randomUUID().slice(0, 8)}`, markdown: "first", space_id: spaceA, ...extra,
  })).id as string;
  const stampsOf = async (id: string): Promise<Map<string, Stamp>> => new Map((await q<Stamp>(
    `SELECT field, origin, seq::int, hlc_wall::float8 AS hlc_wall, hlc_counter, author, device::text, deleted
       FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2`, [ws, id])).rows.map((r) => [r.field, r]));
  const order = (s: Stamp) => [s.hlc_wall, s.hlc_counter] as const;
  const later = (a: Stamp, b: Stamp) => a.hlc_wall > b.hlc_wall || (a.hlc_wall === b.hlc_wall && a.hlc_counter > b.hlc_counter);

  beforeAll(async () => {
    // The backup of this shared workspace asks the website module for the site when other files left one published.
    registerShippedModules();
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    owner = await persistActor(ws, { id: "", name: "Stamp Owner", role: "admin", type: "human" });
    spaceA = await makeSpace(ws, `stamp A ${Date.now()}`, [{ id: owner.id, permission: "edit" }]);
    spaceB = await makeSpace(ws, `stamp B ${Date.now()}`, [{ id: owner.id, permission: "edit" }]);
  });
  afterAll(async () => {
    // Three cases here set this shared workspace's clock ahead of the machine's (up to two hours). Left there, a file
    // that runs later in the same database dates every edit from that clock: attributeConflictRevert's "an edit made
    // an hour before it was sent" then reads as newer than the stored value and records no conflict.
    await seedQ(`UPDATE sync_clock SET hlc_wall = $1, hlc_counter = 0 WHERE workspace_id = $2 AND hlc_wall > $1`, [Date.now(), ws]);
    await pool.end();
  });

  it("a created note has one whole-row stamp naming the author and the device", async () => {
    const id = await create();
    const stamps = await stampsOf(id);
    expect([...stamps.keys()]).toEqual(["*"]);
    expect(stamps.get("*")).toMatchObject({ author: owner.id, device: DEVICE, deleted: false });
  });

  it("each kind of write stamps only the fields it changed, with a later stamp every time", async () => {
    const id = await create();
    const created = (await stampsOf(id)).get("*")!;

    await ok("PATCH", `/api/nodes/${id}`, { title: "renamed" });
    const afterTitle = await stampsOf(id);
    // a rename gives the note the slug its title gives, and that slug is a unit since migration 235: the same write stamps both
    expect([...afterTitle.keys()].sort()).toEqual(["*", "slug", "title"]);
    expect({ ...afterTitle.get("slug"), field: "title" }).toEqual(afterTitle.get("title"));
    expect(afterTitle.get("*")).toEqual(created);
    const titleStamp = afterTitle.get("title")!;
    expect(titleStamp.seq).toBeGreaterThan(created.seq);
    expect(later(titleStamp, created)).toBe(true);

    await ok("PATCH", `/api/nodes/${id}`, { markdown: "second body" });
    const afterBody = await stampsOf(id);
    expect(afterBody.get("title")).toEqual(titleStamp);
    const bodyStamp = afterBody.get("body")!;
    expect(bodyStamp.seq).toBeGreaterThan(titleStamp.seq);

    // Saving the same title again changes nothing: the stamp stays.
    await ok("PATCH", `/api/nodes/${id}`, { title: "renamed" });
    expect((await stampsOf(id)).get("title")).toEqual(titleStamp);

    const parent = await create();
    await ok("PATCH", `/api/nodes/${id}`, { parent_id: parent });
    const afterMove = await stampsOf(id);
    expect(afterMove.get("parent")!.seq).toBeGreaterThan(bodyStamp.seq);
    expect(afterMove.get("body")).toEqual(bodyStamp);

    const preview = await ok("GET", `/api/spaces/move-preview?node=${parent}&to=${spaceB}`);
    await ok("POST", "/api/spaces/move", { node_id: parent, to_space_id: spaceB, membership_epoch: preview.membership_epoch });
    const parentStamps = await stampsOf(parent);
    expect(parentStamps.get("space")).toMatchObject({ author: owner.id, device: DEVICE });
    // a note at the top moved to another space is placed there: its parent (still none) is stamped with the same write (migration 218)
    expect(parentStamps.get("parent")).toMatchObject({ seq: parentStamps.get("space")!.seq, origin: parentStamps.get("space")!.origin });
    // the child is in the new space because of where it is, not because anyone wrote a space for it (migration 218): no stamp, and its space is the parent's
    const childStamps = await stampsOf(id);
    expect(childStamps.get("space")).toBeUndefined();
    expect((await q<{ s: string }>(`SELECT space_id::text AS s FROM content_nodes WHERE id = $1`, [id])).rows[0]!.s).toBe(spaceB);
  });

  // review of PR #1992, round 1, point 1: a slug is a unit since migration 235, and its stamp is no edit: a move to another space leaves the `updated_at` of every note
  // under the moved one as it was, a note whose `updated_at` a write moved forward without a stamp (a board's or a canvas's own) and a note that takes `-2` there too
  it("a move to another space leaves every moved descendant's updated_at as it was, also one moved forward without a stamp and one that takes -2 there", async () => {
    const tag = randomUUID().slice(0, 6);
    const root = await create({ title: `Mover ${tag}` });
    const plain = await create({ parent_id: root, title: `Plain ${tag}` });
    const ahead = await create({ parent_id: root, title: `Ahead ${tag}` });
    const clash = await create({ parent_id: root, title: `Clash ${tag}` });
    await create({ space_id: spaceB, title: `Clash ${tag}` }); // in the target space: the moved one takes `-2`
    await create({ space_id: spaceB, title: `Ahead ${tag}` }); // and this one too
    await ok("PATCH", `/api/nodes/${ahead}`, { markdown: "an edit: a stamp that counts" });
    await seedQ(`UPDATE content_nodes SET updated_at = now() + interval '1 day' WHERE id = $1`, [ahead]); // later, as boardWrites.ts does: no stamp
    const times = async () => Object.fromEntries((await q<{ id: string; t: string }>(`SELECT id::text, updated_at::text AS t FROM content_nodes WHERE id = ANY($1::uuid[])`, [[plain, ahead, clash]])).rows.map((r) => [r.id, r.t]));
    const before = await times();
    const preview = await ok("GET", `/api/spaces/move-preview?node=${root}&to=${spaceB}`);
    await ok("POST", "/api/spaces/move", { node_id: root, to_space_id: spaceB, membership_epoch: preview.membership_epoch });
    expect((await q<{ slug: string }>(`SELECT slug FROM content_nodes WHERE id = $1`, [clash])).rows[0]!.slug).toBe(`clash-${tag}-2`);
    expect((await stampsOf(clash)).get("slug")).toBeDefined();
    expect((await stampsOf(ahead)).get("slug")).toBeDefined(); // `ahead-<tag>-2`: a slug stamp on a note whose updated_at is ahead of its stamps
    expect((await stampsOf(plain)).get("slug")).toBeUndefined(); // its slug is as it was: the move wrote nothing of it
    expect(await times()).toEqual(before);
  });

  it("deleting a note and its children shares the root's stamp; restoring stamps the deleted state again", async () => {
    const parent = await create();
    const child = await create({ parent_id: parent });
    const before = (await stampsOf(parent)).get("*")!;
    await ok("DELETE", `/api/nodes/${parent}`);
    const p = (await stampsOf(parent)).get("deleted")!;
    const c = (await stampsOf(child)).get("deleted")!;
    expect(p).toBeDefined();
    expect(c).toMatchObject({ seq: p.seq, origin: p.origin, hlc_wall: p.hlc_wall, hlc_counter: p.hlc_counter, author: owner.id });
    expect(p.seq).toBeGreaterThan(before.seq);

    await ok("POST", `/api/nodes/${parent}/undelete`);
    const restoredParent = (await stampsOf(parent)).get("deleted")!;
    const restoredChild = (await stampsOf(child)).get("deleted")!;
    expect(restoredParent.seq).toBeGreaterThan(p.seq);
    expect(restoredChild).toMatchObject({ seq: restoredParent.seq, origin: restoredParent.origin });
    expect(order(restoredParent)).not.toEqual(order(p));
  });

  it("restoring a deleted note from History stamps the restore as one operation by the person who did it", async () => {
    const parent = await create();
    const child = await create({ parent_id: parent });
    await ok("DELETE", `/api/nodes/${parent}`);
    const deleted = (await stampsOf(parent)).get("deleted")!;
    const eventId = (await q<{ id: string }>(`SELECT deleted_by_event_id::text AS id FROM content_nodes WHERE id = $1`, [parent])).rows[0]!.id;
    await ok("POST", `/api/events/${eventId}/restore`, { cascade: true });
    const p = (await stampsOf(parent)).get("deleted")!;
    const c = (await stampsOf(child)).get("deleted")!;
    expect(p.seq).toBeGreaterThan(deleted.seq);
    expect(p).toMatchObject({ author: owner.id, device: DEVICE });
    expect(c).toMatchObject({ seq: p.seq, origin: p.origin });
  });

  it("a purged note leaves a tombstone and no field stamps", async () => {
    const id = await create();
    await ok("PATCH", `/api/nodes/${id}`, { title: "to be purged" });
    await ok("DELETE", `/api/nodes/${id}`);
    const preview = await ok("GET", `/api/nodes/${id}/purge-preview`);
    await ok("POST", `/api/nodes/${id}/purge`, { expected_ids: preview.ids ?? [id] });
    const left = await stampsOf(id);
    expect([...left.keys()]).toEqual(["*"]);
    expect(left.get("*")).toMatchObject({ deleted: true });
  });

  it("a write that skips mutate gets a stamp without an author and is counted", async () => {
    const before = await countWritesWithoutStamp();
    const id = randomUUID();
    await seedQ(
      `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, space_id)
       VALUES ($1, $2, 'manual', 'content', 'direct write', $3, $4)`, [id, ws, `direct-${id}`, spaceA]);
    const stamps = await stampsOf(id);
    expect(stamps.get("*")).toMatchObject({ author: null, device: null });
    expect(await countWritesWithoutStamp()).toBe(before + 1);
    // a stamped write is not counted
    await create();
    expect(await countWritesWithoutStamp()).toBe(before + 1);
  });

  it("the node id is made once and every stamp of this installation carries it", async () => {
    const id = await create();
    const other = await create();
    const [a, b] = [(await stampsOf(id)).get("*")!, (await stampsOf(other)).get("*")!];
    expect(a.origin).toBe(b.origin);
    expect(b.seq).toBeGreaterThan(a.seq);
    expect((await q(`SELECT count(*)::int AS n FROM sync_node`)).rows[0]).toEqual({ n: 1 });
    expect(a.origin).toBe((await q<{ node_id: string }>(`SELECT node_id FROM sync_node`)).rows[0]!.node_id);
  });

  it("a browser-app copy takes its own node id once; the packaged database carries none", async () => {
    // Every copy starts from one packaged database. It used to carry the node id made at build time, so all copies
    // of a build stamped as the same node (2026-11-15).
    const nodeId = async () => (await q<{ node_id: string }>(`SELECT node_id FROM sync_node`)).rows[0]?.node_id;
    const original = (await nodeId())!;
    try {
      // The packaged database: no node id, and no record that a copy took one.
      await forgetNodeId();
      expect(await nodeId()).toBeUndefined();
      // A copy's first boot (migrate() makes a row; here the baked one of an older packaged database stands in).
      await seedQ(`INSERT INTO sync_node (singleton, node_id) VALUES (true, 'baked-into-the-package')`);
      // What such a copy wrote before it had its own id carries the shared one.
      const early = await create();
      const earlyStamp = (await stampsOf(early)).get("*")!;
      expect(earlyStamp.origin).toBe("baked-into-the-package");
      expect(await ensureOwnNodeId()).toBe(true);
      const own = (await nodeId())!;
      expect(own).not.toBe("baked-into-the-package");
      // Those stamps move to the copy's own id: origin only, the sequence number and the clock reading stay.
      expect((await stampsOf(early)).get("*")!).toEqual({ ...earlyStamp, origin: own });
      expect((await q(`SELECT count(*)::int AS n FROM sync_stamps WHERE origin = 'baked-into-the-package'`)).rows[0]).toEqual({ n: 0 });
      expect(own).toMatch(/^[0-9a-f-]{36}$/);
      // Later boots keep it, and what the copy writes carries it.
      expect(await ensureOwnNodeId()).toBe(false);
      expect(await nodeId()).toBe(own);
      expect((await stampsOf(await create())).get("*")!.origin).toBe(own);
      // A second copy of the same package is a different node.
      await forgetNodeId();
      await seedQ(`INSERT INTO sync_node (singleton, node_id) VALUES (true, 'baked-into-the-package')`);
      expect(await ensureOwnNodeId()).toBe(true);
      expect(await nodeId()).not.toBe(own);
    } finally {
      await forgetNodeId();
      await seedQ(`INSERT INTO sync_node (singleton, node_id) VALUES (true, $1)`, [original]);
    }
  });

  it("the clock the database uses for a write without mutate follows hlc.ts tick()", async () => {
    await create(); // makes sure the node row exists
    const run = async (wall: number, counter: number) => {
      await seedQ(`UPDATE sync_clock SET hlc_wall = $1, hlc_counter = $2 WHERE workspace_id = $3`, [wall, counter, ws]);
      const s = (await seedQ<{ s: { wall: number; counter: number } }>(`SELECT sync_allocate_stamp($1::uuid) AS s`, [ws])).rows[0]!.s;
      return { wall: s.wall, counter: s.counter };
    };
    // a clock far ahead of the machine's: the counter goes up
    const ahead = Date.now() + 3_600_000;
    expect(await run(ahead, 7)).toEqual(tick({ wall: ahead, counter: 7 }, Date.now()));
    // a clock behind: the wall time takes over and the counter starts again
    const behind = await run(1, 5);
    expect(behind.counter).toBe(0);
    expect(behind.wall).toBeGreaterThan(Date.now() - 5_000);
  });

  it("stamps and the structure log are in no note response, no sync content and no backup", async () => {
    const head = (await q<{ n: string }>(`SELECT COALESCE(max(id), 0)::text AS n FROM domain_events`)).rows[0]!.n;
    const id = await create();
    await ok("PATCH", `/api/nodes/${id}`, { title: "visible title" });
    const origin = (await stampsOf(id)).get("*")!.origin;
    const words = ["sync_stamps", "structure_log", "hlc_wall", "hlc_counter", "writes_without_mutate", origin];
    const notClaimed = (label: string, text: string) => { for (const w of words) expect(text.includes(w), `${label} mentions ${w}`).toBe(false); };

    notClaimed("GET note", JSON.stringify(await ok("GET", `/api/nodes/${id}`)));
    notClaimed("PATCH note", JSON.stringify(await ok("PATCH", `/api/nodes/${id}`, { title: "visible title 2" })));
    const delta = await ok("GET", `/api/sync?since=${head}`);
    expect(JSON.stringify(delta)).toContain(id); // the sync content does carry the note, so the check above is not vacuous
    notClaimed("sync delta", JSON.stringify(delta));

    const res = await server.request("/api/backup/full.zip");
    expect(res.status).toBe(200);
    const zip = zipEntries(Buffer.from(await res.arrayBuffer()));
    expect([...zip.values()].some((data) => data.toString("utf8").includes("visible title 2"))).toBe(true);
    for (const [name, data] of zip) notClaimed(`backup file ${name}`, data.toString("utf8"));
  });

  const insertDirect = async (workspaceId: string, spaceId: string) => {
    const id = randomUUID();
    await q(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, space_id)
             VALUES ($1, $2, 'manual', 'content', 'direct write', $3, $4)`, [id, workspaceId, `direct-${id}`, spaceId]);
    return id;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  describe("a stamp made on another node", () => {
    it("is written as received: this node's sequence number stays, its clock moves up to the received reading", async () => {
      await create(); // the clock row exists
      // Another test of this file puts the clock an hour ahead: with a received reading only minutes ahead (the bound is ten) this one needs its own start.
      await seedQ(`UPDATE sync_clock SET hlc_wall = $1, hlc_counter = 0 WHERE workspace_id = $2`, [Date.now(), ws]);
      const clockBefore = (await q<{ next_seq: string; hlc_wall: string; hlc_counter: number }>(
        `SELECT next_seq, hlc_wall, hlc_counter FROM sync_clock WHERE workspace_id = $1`, [ws])).rows[0]!;
      const foreign = { origin: `phone-${randomUUID()}`, seq: 41, wall: Date.now() + 300_000 /* ahead, but inside MAX_FOREIGN_CLOCK_AHEAD_MS */, counter: 3, author: owner.id, device: randomUUID() };
      const id = randomUUID();
      await withEventTransaction(ws, async () => {
        await adoptForeignStamp(ws, foreign);
        await q(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, space_id) VALUES ($1, $2, 'manual', 'content', 'phone note', $3, $4)`,
          [id, ws, `phone-${id}`, spaceA]);
      });
      expect((await stampsOf(id)).get("*")).toMatchObject({ origin: foreign.origin, seq: 41, hlc_wall: foreign.wall, hlc_counter: 3, author: owner.id, device: foreign.device });
      const clockAfter = (await q<{ next_seq: string; hlc_wall: string; hlc_counter: number }>(
        `SELECT next_seq, hlc_wall, hlc_counter FROM sync_clock WHERE workspace_id = $1`, [ws])).rows[0]!;
      expect(clockAfter.next_seq).toBe(clockBefore.next_seq);
      // receive(): the received wall is ahead of both this clock and the machine's, so the counter follows the received one
      expect([Number(clockAfter.hlc_wall), clockAfter.hlc_counter]).toEqual([foreign.wall, foreign.counter + 1]);
      // what this node writes next sorts after what it was sent
      const next = (await stampsOf(await create())).get("*")!;
      expect(later(next, { ...next, hlc_wall: foreign.wall, hlc_counter: foreign.counter })).toBe(true);
      expect(next.origin).not.toBe(foreign.origin);
    });

    it("is refused when it names this node, or when the transaction already has a stamp", async () => {
      const local = (await q<{ node_id: string }>(`SELECT node_id FROM sync_node`)).rows[0]!.node_id;
      const stamp = { origin: local, seq: 1, wall: 1, counter: 0, author: null, device: null };
      await expect(withEventTransaction(ws, () => adoptForeignStamp(ws, stamp))).rejects.toThrow(/made on this node/);
      const foreign = { ...stamp, origin: `other-${randomUUID()}` };
      await expect(withEventTransaction(ws, async () => { await adoptForeignStamp(ws, foreign); await adoptForeignStamp(ws, foreign); })).rejects.toThrow(/already has a stamp/);
    });
  });

  it("a write through mutate takes the next reading even when the last stamp is ahead of this machine's clock", async () => {
    await create();
    const ahead = Date.now() + 3_600_000;
    await seedQ(`UPDATE sync_clock SET hlc_wall = $1, hlc_counter = 9 WHERE workspace_id = $2`, [ahead, ws]);
    const stamp = (await stampsOf(await create())).get("*")!;
    expect([stamp.hlc_wall, stamp.hlc_counter]).toEqual([ahead, 10]);
  });

  describe("two connections", () => {
    it.skipIf(needsSecondConnection)("a long write in one workspace does not make a write in another wait", async () => {
      await create(); // the node id exists (made at boot); only its one-time first insert could make a writer wait
      const other = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Other', $1) RETURNING id::text`, [`stamp-other-${randomUUID()}`])).rows[0]!.id;
      const otherSpace = await makeSpace(other, `stamp other ${Date.now()}`, []);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let wrote!: () => void;
      const aWrote = new Promise<void>((r) => { wrote = r; });
      const long = withEventTransaction(ws, async () => { await insertDirect(ws, spaceA); wrote(); await gate; });
      await aWrote;
      const short = withEventTransaction(other, () => insertDirect(other, otherSpace));
      const outcome = await Promise.race([short.then(() => "finished"), sleep(5_000).then(() => "waited")]);
      release();
      await long;
      expect(outcome).toBe("finished");
    });

    it.skipIf(needsSecondConnection)("a transaction that wrote first and enters mutate later never deadlocks with one that starts in mutate", async () => {
      const note = (title: string) => createNote({ actor: owner, workspaceId: ws, title, markdown: "x", spaceId: spaceA, event: { uiContext: "node.create" } });
      const jitter = () => sleep(Math.floor(Math.random() * 15));
      // One round at a time: the two transactions of a round are the two connections; a lock wait must not use up the pool.
      for (let i = 0; i < 30; i++) {
        await Promise.race([
          Promise.all([
            withTransaction(async () => { await jitter(); await note(`order A ${i}`); await jitter(); }),
            withTransaction(async () => { await insertDirect(ws, spaceA); await jitter(); await note(`order B ${i}`); }),
          ]),
          sleep(20_000).then(() => { throw new Error(`round ${i} did not finish: a deadlock or a lock wait that never ends`); }),
        ]);
      }
    }, 120_000);
  });
});
