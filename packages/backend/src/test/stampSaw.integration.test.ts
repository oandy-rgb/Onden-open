// What a write stamp says its writer had seen (migration 205), through the real routes and the real triggers; the other heads of a unit;
// and the unit-level reader and writer of the merge core (spine/stampedMerge/dbUnits.ts): read what the database holds, merge what another
// node sent, write the answer back, and the next ordinary write of a person replaces every head it had seen.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, pool, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import { withRequestDevice } from "../requestContext.js";
import type { ActorCtx } from "../types.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { mergeUnitsIntoWorkspace } from "../spine/stampedImport.js";
import { type Cell, type Stamp, DEFAULT_MAX_SKEW_MS, canonical, conflictsOf, genesisName, writeUnit } from "../spine/stampedMerge/unit.js";
import { UNIT_SOURCES, readUnit } from "../spine/stampedMerge/dbUnits.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const DEVICE = randomUUID();
type StampRow = { field: string; origin: string; seq: number; saw: Record<string, number>; meta: unknown; deleted: boolean };

describe.skipIf(!isTestDb)("what a stamp says its writer had seen", () => {
  let ws = "";
  let owner!: ActorCtx;
  let space = "";
  const server = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  server.onError(apiOnError);
  server.use("*", async (c, next) => { c.set("actor", owner); await withRequestDevice(DEVICE, next); });
  server.route("/api/nodes", nodeRouter);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await server.request(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await res.json().catch(() => null);
    expect(res.status, `${method} ${path}: ${JSON.stringify(json)}`).toBeLessThan(300);
    return json as { id: string };
  };
  const create = async (title = `saw ${randomUUID().slice(0, 8)}`) => (await call("POST", "/api/nodes", { id: randomUUID(), title, markdown: "first", space_id: space })).id;
  const stamps = async (id: string): Promise<Map<string, StampRow>> => new Map((await q<StampRow>(
    `SELECT field, origin, seq::int, saw, meta, deleted FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2`, [ws, id])).rows.map((r) => [r.field, r]));
  const heads = async (id: string, field: string) => (await q<{ origin: string; seq: number; content_hash: string; value: string | null }>(
    `SELECT origin, seq::int, content_hash, value FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = $3 ORDER BY origin, seq`, [ws, id, field])).rows;
  const peer = (seq: number, wall = Date.now()): Stamp => ({ origin: "peer-node", seq, wall, counter: 0, author: null, device: null });
  const cell = (stamp: Stamp, value: string | null, saw: Record<string, number> = {}): Cell => ({ stamp, saw, deleted: false, value });
  const genesisAt = (id: string, field: string, value: string) => seedQ(
    `INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted) VALUES ($1, 'content_nodes', $2, $3, 'genesis', 0, 0, 0, NULL, NULL, false)
     ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET origin = 'genesis', seq = 0, hlc_wall = 0, hlc_counter = 0, author = NULL, device = NULL, deleted = false, saw = '{}'::jsonb, meta = NULL`, [ws, id, field]).then(() => value);
  const asWritten = (id: string) => withEventTransaction(ws, async () => id);

  beforeAll(async () => {
    registerShippedModules();
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    owner = await persistActor(ws, { id: "", name: "Saw Owner", role: "admin", type: "human" });
    space = await makeSpace(ws, `saw ${Date.now()}`, [{ id: owner.id, permission: "edit" }]);
  });
  afterAll(async () => { await pool.end(); });

  it("a stamp written before this existed says nothing; a write over the creation of its row names that creation", async () => {
    const id = await create();
    const created = (await stamps(id)).get("*")!;
    expect(created.saw).toEqual({});
    await call("PATCH", `/api/nodes/${id}`, { title: "renamed" });
    const title = (await stamps(id)).get("title")!;
    expect(title.saw).toEqual({ [created.origin]: created.seq });
    await call("PATCH", `/api/nodes/${id}`, { title: "renamed again" });
    const again = (await stamps(id)).get("title")!;
    expect(again.saw).toEqual({ [created.origin]: title.seq }); // the largest per origin: the earlier write and the creation under it
  });

  it("a write over a genesis value names that value by its content, the way the merge core names it", async () => {
    const id = await create("before stamps");
    await seedQ(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND row_key = $2`, [ws, id]);
    await genesisAt(id, "*", "");
    await call("PATCH", `/api/nodes/${id}`, { title: "after stamps" });
    const written = (await stamps(id)).get("title")!;
    const name = genesisName({ stamp: { origin: "genesis", seq: 0, wall: 0, counter: 0, author: null, device: null }, saw: {}, deleted: false, value: "before stamps" });
    expect(written.saw).toEqual({ [name]: 0 });
    // The next write of the same field is made over a real stamp, and carries what that stamp had seen (the genesis value too: it is still seen).
    await call("PATCH", `/api/nodes/${id}`, { title: "third" });
    expect((await stamps(id)).get("title")!.saw).toEqual({ [name]: 0, [written.origin]: written.seq });
  });

  it("moving a note records where it came from beside the stamp", async () => {
    const parent = await create(), other = await create(), id = await create();
    await call("PATCH", `/api/nodes/${id}`, { parent_id: parent });
    expect((await stamps(id)).get("parent")!.meta).toEqual({ from: null });
    await call("PATCH", `/api/nodes/${id}`, { parent_id: other });
    expect((await stamps(id)).get("parent")!.meta).toEqual({ from: parent });
  });

  it("the body of a long note is not copied on every edit: saw is worked out without the old text once the field has a stamp of its own", async () => {
    const id = await create();
    await call("PATCH", `/api/nodes/${id}`, { markdown: "one" });
    await call("PATCH", `/api/nodes/${id}`, { markdown: "two" });
    const body = (await stamps(id)).get("body")!;
    expect(Object.keys(body.saw)).toHaveLength(1);
  });

  describe("what a field follows from its row's creation", () => {
    it("a row's creation with two heads (two nodes made the same id): the field follows both, and the write of a person has seen both, as the core says", async () => {
      const id = await create("two creations");
      await seedQ(`INSERT INTO sync_stamp_heads (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter) VALUES ($1, 'content_nodes', $2, '*', 'peer-node', 3, $3, 0)`, [ws, id, Date.now()]);
      const core = writeUnit(await readUnit(ws, { table: "content_nodes", row: id, field: "title" }), { origin: "me", seq: 99, wall: Date.now(), counter: 0, author: null, device: null }, { value: "x" })[0]!.saw;
      expect(core).toHaveProperty(["peer-node"], 3); // the core: both creation heads are seen
      await call("PATCH", `/api/nodes/${id}`, { title: "settled over both creations" });
      expect((await stamps(id)).get("title")!.saw).toEqual(core); // the database says the same
      expect((await q(`SELECT 1 FROM sync_stamp_heads WHERE workspace_id = $1 AND row_key = $2 AND field = '*'`, [ws, id])).rows).toHaveLength(1); // they are the creation's heads: they stay
    });
    // Review of PR #2024, round 3, point 1: a holder's re-send of `*` (meta.resent) is no creation, nothing follows it (dbUnits.ts readUnit, rows.ts fieldsOf), so a
    // person's write to a field that follows `*` has not seen it, in the core and in the database (migration 240: sync_stamp_put_over and sync_stamp_put_beside).
    const resendBeside = (id: string) => seedQ(
      `INSERT INTO sync_stamp_heads (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, meta) VALUES ($1, 'content_nodes', $2, '*', 'peer-node', 7, $3, 0, '{"resent": true}'::jsonb)`, [ws, id, Date.now()]);
    const coreSaw = async (id: string, field: string) =>
      writeUnit(await readUnit(ws, { table: "content_nodes", row: id, field }), { origin: "me", seq: 99, wall: Date.now(), counter: 0, author: null, device: null }, { value: "x" })[0]!.saw;
    it("a re-send of the row's creation beside it: the field does not follow it, and a person's write has not seen it, as the core says", async () => {
      const id = await create("re-sent creation");
      await resendBeside(id);
      expect((await stamps(id)).has("title"), "the title follows the creation").toBe(false);
      const core = await coreSaw(id, "title");
      expect(core, "the core: only the creation is seen").not.toHaveProperty(["peer-node"]);
      await call("PATCH", `/api/nodes/${id}`, { title: "written beside a re-send" });
      expect((await stamps(id)).get("title")!.saw).toEqual(core); // the database says the same (sync_stamp_put_over)
      expect(await heads(id, "*"), "the re-send is the creation's head, not this field's: it stays").toHaveLength(1);
    });
    it("the same for a place written beside its other heads (a top note moved to another space): the move has not seen the re-send, as the core says", async () => {
      const id = await create("re-sent creation, moved");
      const space2 = await makeSpace(ws, `saw moved ${Date.now()}`, [{ id: owner.id, permission: "edit" }]);
      await resendBeside(id);
      expect((await stamps(id)).has("parent"), "the parent follows the creation").toBe(false);
      expect((await stamps(id)).has("sort"), "the order key follows the creation").toBe(false);
      const core = { parent: await coreSaw(id, "parent"), sort: await coreSaw(id, "sort") };
      expect(core.parent, "the core: only the creation is seen").not.toHaveProperty(["peer-node"]);
      await seedQ(`UPDATE content_nodes SET space_id = $2 WHERE id = $1`, [id, space2]); // the move stamps parent and sort beside their heads (migration 218, 5)
      const after = await stamps(id);
      expect({ parent: after.get("parent")!.saw, sort: after.get("sort")!.saw }).toEqual(core); // the database says the same (sync_stamp_put_beside)
    });
  });

  describe("a genesis value is named the same in SQL and in the core, for every kind of column", () => {
    const GENESIS = { origin: "genesis", seq: 0, wall: 0, counter: 0, author: null, device: null };
    const cases: [string, string, (id: string, other: string, space2: string) => [string, unknown[]]][] = [
      ["title (text, non-ASCII)", "title", (id) => [`UPDATE content_nodes SET title = 'changed' WHERE id = $1`, [id]]],
      ["body (newlines, quotes, non-ASCII)", "body", (id) => [`UPDATE content_nodes SET markdown = 'x' WHERE id = $1`, [id]]],
      ["body (empty string)", "body", (id) => [`UPDATE content_nodes SET markdown = 'y' WHERE id = $1`, [id]]],
      ["parent (uuid)", "parent", (id) => [`UPDATE content_nodes SET parent_id = NULL WHERE id = $1`, [id]]],
      ["parent (null)", "parent", (id, other) => [`UPDATE content_nodes SET parent_id = $2 WHERE id = $1`, [id, other]]],
      ["hidden (boolean)", "hidden", (id) => [`UPDATE content_nodes SET hidden = NOT hidden WHERE id = $1`, [id]]],
      ["sort (order key, text)", "sort", (id) => [`UPDATE content_nodes SET order_key = 'a1' WHERE id = $1`, [id]]],
      ["space (uuid)", "space", (id, _o, space2) => [`UPDATE content_nodes SET space_id = $2 WHERE id = $1`, [id, space2]]],
      ["deleted (timestamptz as true/false)", "deleted", (id) => [`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [id]]],
    ];
    for (const [name, field, update] of cases) {
      it(`${name}: the name the trigger writes is the name the core gives the value read before`, async () => {
        const other = await create("some parent");
        const space2 = await makeSpace(ws, `saw other ${Date.now()}`, [{ id: owner.id, permission: "edit" }]);
        const id = await create(name.startsWith("title") ? "Titel ünï \u4e2d\u6587 ✓" : "plain");
        if (name.startsWith("body")) await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [id, name.includes("empty") ? "" : "line one\n\"quoted\" 'single' \\ back\nline three — 中文\n"]);
        if (name === "parent (uuid)") await seedQ(`UPDATE content_nodes SET parent_id = $2 WHERE id = $1`, [id, other]);
        await seedQ(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND row_key = $2`, [ws, id]);
        await genesisAt(id, "*", "");
        const read = (await readUnit(ws, { table: "content_nodes", row: id, field }))![0]!;
        expect(read.stamp.origin).toBe("genesis");
        const [sql, params] = update(id, other, space2);
        await seedQ(sql, params);
        const saw = (await stamps(id)).get(field)!.saw;
        expect(Object.keys(saw)).toEqual([genesisName({ stamp: GENESIS, saw: {}, deleted: false, value: read.value })]);
      });
    }
    it("a JSON unit's genesis value is the text PostgreSQL gives for the jsonb (space after the colon): the same text on both sides, so the same name", async () => {
      const text = (await q<{ t: string }>(`SELECT '{"a": [1, 2], "b": {"c": null}}'::jsonb::text AS t`)).rows[0]!.t;
      expect(text).toBe('{"a": [1, 2], "b": {"c": null}}');
      const name = (await q<{ n: string }>(`SELECT 'genesis:' || sync_genesis_hash(sync_content_text('{"a": [1, 2], "b": {"c": null}}'::jsonb::text)) AS n`)).rows[0]!.n;
      expect(name).toBe(genesisName({ stamp: GENESIS, saw: {}, deleted: false, value: text }));
    });
  });

  describe("a row deleted for good keeps what its deleter had seen", () => {
    it("the tombstone carries every field's heads and the largest number per origin, taken before the field stamps go", async () => {
      const id = await create("to be purged");
      await call("PATCH", `/api/nodes/${id}`, { title: "edited" });
      await call("PATCH", `/api/nodes/${id}`, { markdown: "edited too" });
      const before = await stamps(id);
      await seedQ(`INSERT INTO sync_stamp_heads (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, value) VALUES ($1, 'content_nodes', $2, 'title', 'peer-node', 8, $3, 0, 'the other title')`, [ws, id, Date.now()]);
      await seedQ(`DELETE FROM content_nodes WHERE id = $1`, [id]);
      const star = (await stamps(id)).get("*")!;
      expect(star.deleted).toBe(true);
      const meta = star.meta as { seen: Record<string, number>; heads: Record<string, [string, number][]> };
      expect(meta.seen["peer-node"]).toBe(8);
      expect(meta.seen[before.get("title")!.origin]).toBe(Math.max(before.get("title")!.seq, before.get("body")!.seq, before.get("*")!.seq));
      expect(meta.heads.title).toEqual(expect.arrayContaining([[before.get("title")!.origin, before.get("title")!.seq], ["peer-node", 8]]));
      expect(meta.heads.body).toEqual([[before.get("body")!.origin, before.get("body")!.seq]]);
      expect([...(await stamps(id)).keys()]).toEqual(["*"]);
    });
  });

  describe("the unit-level reader and writer", () => {
    it("reads a unit as the heads the database holds, a field that follows its row's creation included", async () => {
      const id = await create("read me");
      const unit = (await readUnit(ws, { table: "content_nodes", row: id, field: "title" }))!;
      expect(unit).toHaveLength(1);
      expect(unit[0]).toMatchObject({ value: "read me", saw: {}, deleted: false });
      const star = (await readUnit(ws, { table: "content_nodes", row: id, field: "*" }))!;
      expect(star[0]!.value).toEqual({});
      expect(star[0]!.stamp).toEqual(unit[0]!.stamp); // the field has no stamp of its own: it carries its row's creation stamp
      expect(await readUnit(ws, { table: "content_nodes", row: randomUUID(), field: "title" })).toBeUndefined();
    });

    it("two writes that never saw each other: the larger stamp is the value, the other is kept with its value, and one person's write replaces both", async () => {
      const id = await create("base");
      await call("PATCH", `/api/nodes/${id}`, { title: "local" });
      const local = (await readUnit(ws, { table: "content_nodes", row: id, field: "title" }))![0]!;
      const incoming = cell(peer(1, local.stamp.wall + 1000), "from the peer");
      const report = await mergeUnitsIntoWorkspace(ws, [{ address: { table: "content_nodes", row: id, field: "title" }, unit: [incoming] }]);
      expect(report).toMatchObject({ stored: 1, rejected: [], deferred: [] });
      expect(report.events[0]!.result.outcome).toBe("conflict");
      // what the report says happened is what is stored: the event's unit is the unit the database now reads back (the core's account must equal the data)
      expect(canonical(report.events[0]!.result.unit)).toBe(canonical((await readUnit(ws, { table: "content_nodes", row: id, field: "title" }))!));
      expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [id])).rows[0]!.title).toBe("from the peer");
      expect(await heads(id, "title")).toEqual([expect.objectContaining({ origin: local.stamp.origin, seq: local.stamp.seq, value: "local" })]);
      const unit = (await readUnit(ws, { table: "content_nodes", row: id, field: "title" }))!;
      expect(unit.map((c) => c.value)).toEqual(["from the peer", "local"]);
      expect(conflictsOf(unit).map((c) => c.value)).toEqual(["local"]);
      // Reading it again and merging it again changes nothing.
      const twice = await mergeUnitsIntoWorkspace(ws, [{ address: { table: "content_nodes", row: id, field: "title" }, unit }]);
      expect(twice).toMatchObject({ stored: 0, rejected: [], deferred: [] });
      // A person writes: it has seen both heads, and nothing of the conflict is left.
      await call("PATCH", `/api/nodes/${id}`, { title: "settled" });
      expect(await heads(id, "title")).toEqual([]);
      const settled = (await stamps(id)).get("title")!;
      expect(settled.saw).toMatchObject({ "peer-node": 1, [local.stamp.origin]: local.stamp.seq });
      expect(conflictsOf((await readUnit(ws, { table: "content_nodes", row: id, field: "title" }))!)).toEqual([]);
    });

    it("a value from before stamps survives a write that was made over a different value (it never saw it)", async () => {
      const id = await create("x");
      await seedQ(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND row_key = $2`, [ws, id]);
      await genesisAt(id, "*", "");
      await genesisAt(id, "title", "x");
      const y2 = cell(peer(4), "y2", { [genesisName(cell({ origin: "genesis", seq: 0, wall: 0, counter: 0, author: null, device: null }, "y"))]: 0 });
      await mergeUnitsIntoWorkspace(ws, [{ address: { table: "content_nodes", row: id, field: "title" }, unit: [y2] }]);
      const unit = (await readUnit(ws, { table: "content_nodes", row: id, field: "title" }))!;
      expect(unit.map((c) => [c.stamp.origin, c.value])).toEqual([["peer-node", "y2"], ["genesis", "x"]]);
      const stored = await heads(id, "title");
      expect(stored).toHaveLength(1);
      expect(stored[0]!.origin).toBe("genesis");
      expect(stored[0]!.content_hash).toMatch(/^[0-9a-f]{64}$/);
      // The person who looks at both and writes names both genesis values and the peer's write.
      await call("PATCH", `/api/nodes/${id}`, { title: "chosen" });
      expect((await stamps(id)).get("title")!.saw).toMatchObject({ "peer-node": 4 });
      expect(await heads(id, "title")).toEqual([]);
    });

    it("a write whose clock is ahead of ours waits: nothing is stored, and the report names it", async () => {
      const id = await create("clock");
      const ahead = cell(peer(2, Date.now() + 3 * DEFAULT_MAX_SKEW_MS), "from the future");
      const report = await mergeUnitsIntoWorkspace(ws, [{ address: { table: "content_nodes", row: id, field: "title" }, unit: [ahead] }]);
      expect(report.stored).toBe(0);
      expect(report.deferred).toHaveLength(1);
      expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [id])).rows[0]!.title).toBe("clock");
      // Later, when our clock has caught up (the gate says so), it is taken.
      const later = await mergeUnitsIntoWorkspace(ws, [{ address: { table: "content_nodes", row: id, field: "title" }, unit: [ahead] }], { nowWall: Date.now() + 3 * DEFAULT_MAX_SKEW_MS, maxSkewMs: DEFAULT_MAX_SKEW_MS });
      expect(later.stored).toBe(1);
    });

    it("the same write number with another content is refused and nothing changes", async () => {
      const id = await create("clash");
      const a = cell(peer(7, Date.now() + 1), "one");
      await mergeUnitsIntoWorkspace(ws, [{ address: { table: "content_nodes", row: id, field: "title" }, unit: [a] }]);
      const report = await mergeUnitsIntoWorkspace(ws, [{ address: { table: "content_nodes", row: id, field: "title" }, unit: [{ ...a, value: "other" }] }]);
      expect(report.rejected).toHaveLength(1);
      expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [id])).rows[0]!.title).toBe("one");
    });

    it("the writes of a merge are not stamped again, and are counted", async () => {
      const id = await create("count");
      const before = Number((await q<{ n: string }>(`SELECT merge_batches::text AS n FROM sync_clock WHERE workspace_id = $1`, [ws])).rows[0]!.n);
      const countBefore = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_stamps WHERE workspace_id = $1`, [ws])).rows[0]!.n;
      await mergeUnitsIntoWorkspace(ws, [{ address: { table: "content_nodes", row: id, field: "body" }, unit: [cell(peer(9, Date.now() + 2), "peer body")] }]);
      const after = Number((await q<{ n: string }>(`SELECT merge_batches::text AS n FROM sync_clock WHERE workspace_id = $1`, [ws])).rows[0]!.n);
      expect(after).toBe(before + 1);
      const body = (await stamps(id)).get("body")!;
      expect(body).toMatchObject({ origin: "peer-node", seq: 9 }); // the peer's stamp as received, not this node's
      expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_stamps WHERE workspace_id = $1`, [ws])).rows[0]!.n)).toBe(Number(countBefore) + 1);
      expect(await asWritten(id)).toBe(id);
    });

    it("a merged move is not written to the structure log (kept as it is: the log is this device's own history, and a line for a change from another device is for batch 2b)", async () => {
      const id = await create("moved by a peer"), parent = await create("new parent");
      const lines = async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM structure_log WHERE workspace_id = $1 AND row_key = $2`, [ws, id])).rows[0]!.n);
      const before = await lines();
      await mergeUnitsIntoWorkspace(ws, [{ address: { table: "content_nodes", row: id, field: "parent" }, unit: [cell(peer(21, Date.now() + 5), parent)] }]);
      expect((await q<{ parent_id: string }>(`SELECT parent_id::text FROM content_nodes WHERE id = $1`, [id])).rows[0]!.parent_id).toBe(parent);
      expect(await lines()).toBe(before);
    });

    it("a workspace that is being joined takes no merged units, and nothing is written", async () => {
      const id = await create("joining");
      await seedQ(`INSERT INTO sync_join (workspace_id, source_node, cut_seq, state) VALUES ($1, 'other-node', 0, 'joining')`, [ws]);
      try {
        await expect(mergeUnitsIntoWorkspace(ws, [{ address: { table: "content_nodes", row: id, field: "title" }, unit: [cell(peer(11, Date.now() + 3), "refused")] }])).rejects.toMatchObject({ code: "merge_not_open" });
      } finally { await seedQ(`DELETE FROM sync_join WHERE workspace_id = $1`, [ws]); }
      expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [id])).rows[0]!.title).toBe("joining");
    });

    it("the units this reads are the ones the stamp trigger of the table watches", async () => {
      const row = (await q<{ args: string }>(
        `SELECT encode(t.tgargs, 'escape') AS args FROM pg_trigger t WHERE t.tgrelid = 'content_nodes'::regclass AND t.tgname = 'content_nodes_sync_stamp_update'`)).rows[0]!;
      const args = row.args.split("\\000");
      const watched = Object.fromEntries(args[3]!.split(",").map((s) => s.split("=") as [string, string]));
      expect(UNIT_SOURCES.find((u) => u.label === "content_nodes")!.fields).toEqual(watched);
      expect(canonical(args.slice(0, 3))).toBe(canonical(["content_nodes", "id", "workspace_id"]));
    });
  });

  describe("the migration's read-only preview", () => {
    /** The preview query in the header of migration 205: the comment lines `--   ...` after `-- Read-only preview` up to the line that is only `--   ;`. */
    const preview = () => {
      const lines = readFileSync(join(import.meta.dirname, "../../db/migrations/205_stamp_saw_heads.sql"), "utf8").split("\n");
      const from = lines.findIndex((l) => l.startsWith("-- Read-only preview"));
      const body: string[] = [];
      for (const l of lines.slice(from)) { if (l.trim() === "--   ;") break; if (l.startsWith("--   SELECT") || l.startsWith("--   UNION")) body.push(l.slice(5)); }
      return body.join("\n");
    };
    it("runs in a read-only transaction, answers counts only, and its numbers are what the migration then adds", async () => {
      await create();
      const rows = await (async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN READ ONLY");
          const r = await client.query(preview());
          await client.query("ROLLBACK");
          return r.rows as { part: string; rows: string; est_bytes: string }[];
        } finally { client.release(); }
      })();
      expect(rows.map((r) => r.part)).toEqual(["index content_nodes (parent_id)", "sync_stamps rows that get saw = {} (none is rewritten)", "sync_stamp_heads rows (a new table)"]);
      const withParent = Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes WHERE parent_id IS NOT NULL`)).rows[0]!.n);
      expect(Number(rows[0]!.rows)).toBe(withParent);
      expect(Number(rows[0]!.est_bytes)).toBe(withParent * 33);
      expect(Number(rows[1]!.rows)).toBe(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_stamps`)).rows[0]!.n));
      for (const r of rows) for (const v of Object.values(r)) expect(String(v)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // no id, title or value
    });
    it("a stamp that was there before the migration keeps saw = {} and meta NULL: nothing is rewritten", async () => {
      const id = await create();
      expect((await stamps(id)).get("*")).toMatchObject({ saw: {}, meta: null });
      const unfilled = await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_stamps WHERE origin = 'genesis' AND (saw <> '{}'::jsonb OR meta IS NOT NULL)`);
      expect(unfilled.rows[0]!.n).toBe("0");
    });
  });
});
