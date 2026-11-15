// Migration 202 after a random batch of real writes (causal-stamps proposal §8 S5). Through the real routes: notes, tags, attributes,
// hand-made edges, pointers and board cards are made, changed and removed at random. Then, inside a transaction that is rolled back at the
// end (the shared test database stays as it was), some of the stamps are taken away at random (units that never had one: a database from
// before stamps) and migration 202 is run. Whatever the batch was:
//   1 every unit that exists has a stamp (STAMPED_UNITS is the list; the migration finds the same units in the trigger catalog);
//   2 a stamp that was there is as it was (tombstones too); one that was not is the genesis stamp, with nothing taken from this node;
//   3 a second run adds nothing;
//   4 two databases that hold the same data write the same stamps: taking the genesis stamps away and running again gives them back.
// Then the backup round: a workspace backed up and restored into a new one (its rows are written again, so each is stamped by the
// write) is not stamped a second time by the migration.
// realPostgresAlso: the batches go through the real routes into the server's own triggers, and the migration runs inside the same open transaction
// SAFETY: only runs against a *_test database; skips otherwise.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";
import { apiOnError } from "../../httpError.js";
import { allowUnstampedWrite, getWorkspaceId, pool, q, withTransaction } from "../../db.js";
import nodeRouter from "../../routes/nodes.js";
import tagRouter from "../../routes/tags.js";
import edgeRouter from "../../routes/edges.js";
import pointerRouter from "../../routes/pointers.js";
import boardRouter from "../../routes/boards.js";
import bootstrapRouter from "../../routes/bootstrap.js";
import syncRouter from "../../routes/sync.js";
import canvasRouter from "../../routes/canvases.js";
import backupRouter from "../../routes/backup.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "../helpers/persistActor.js";
import { makeSpace } from "../helpers/spaceFixtures.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { checkAsync } from "../helpers/propsConfig.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { STAMPED_UNITS } from "../helpers/stampedUnits.js";
import { waitForJob } from "../helpers/restoreJob.js";
import { setWorkspaceOwner } from "../helpers/setOwner.js";

let current = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => current || await (await original<typeof import("../../db.js")>()).getWorkspaceId() }));

const sqlText = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations/202_stamps_genesis.sql"), "utf8");

class Rollback extends Error {}
/** Run `fn` in a transaction that is rolled back when it ends, so what it writes (the migration, the deleted stamps) never reaches the shared database. */
async function rolledBack<T>(fn: () => Promise<T>): Promise<T> {
  let out!: T;
  try {
    await allowUnstampedWrite("migration 202 check, rolled back", () => withTransaction(async () => { out = await fn(); throw new Rollback(); }));
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

const N = [0, 1, 2] as const;
type Op =
  | { kind: "create" }
  | { kind: "remove"; note: number }
  | { kind: "title"; note: number; n: number }
  | { kind: "tag"; note: number; tag: 0 | 1; on: boolean }
  | { kind: "attr"; note: number; value: number | null }
  | { kind: "edge"; from: number; to: number; on: boolean }
  | { kind: "pointer"; parent: number; target: number; on: boolean }
  | { kind: "card"; note: number; on: boolean; x: number };
const n3 = fc.constantFrom(...N);
const OPS: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("create" as const) }),
  fc.record({ kind: fc.constant("remove" as const), note: n3 }),
  fc.record({ kind: fc.constant("title" as const), note: n3, n: fc.integer({ min: 0, max: 5 }) }),
  fc.record({ kind: fc.constant("tag" as const), note: n3, tag: fc.constantFrom(0 as const, 1 as const), on: fc.boolean() }),
  fc.record({ kind: fc.constant("attr" as const), note: n3, value: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }) }),
  fc.record({ kind: fc.constant("edge" as const), from: n3, to: n3, on: fc.boolean() }).filter((o) => o.from !== o.to),
  fc.record({ kind: fc.constant("pointer" as const), parent: n3, target: n3, on: fc.boolean() }).filter((o) => o.parent !== o.target),
  fc.record({ kind: fc.constant("card" as const), note: n3, on: fc.boolean(), x: fc.integer({ min: 0, max: 2 }) }),
);

describe.skipIf(!isTestDatabase())("migration 202 after random writes (DB)", { timeout: 300_000 }, () => {
  let ws = "";
  let owner!: ActorCtx;
  let space = "";
  const server = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  server.onError(apiOnError);
  server.use("*", async (c, next) => { c.set("actor", owner); await next(); });
  for (const [path, router] of [["/api/nodes", nodeRouter], ["/api/tags", tagRouter], ["/api/edges", edgeRouter], ["/api/pointers", pointerRouter], ["/api/boards", boardRouter], ["/api/canvases", canvasRouter], ["/api/backup", backupRouter], ["/api/bootstrap", bootstrapRouter], ["/api/sync", syncRouter]] as const) {
    server.route(path, router);
  }
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await server.request(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    expect(res.status, `${method} ${path}: ${text}`).toBeLessThan(300);
    return text ? JSON.parse(text) : null;
  };

  beforeAll(async () => {
    registerShippedModules();
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    owner = await persistActor(ws, { id: "", name: "Genesis Owner", role: "admin", type: "human" });
    space = await makeSpace(ws, `genesis ${Date.now()}`, [{ id: owner.id, permission: "edit" }]);
  });
  afterAll(async () => { await pool.end(); });

  type Unit = { ws: string; tn: string; rk: string; fld: string };
  const stampKey = (r: { workspace_id: string; table_name: string; row_key: string; field: string }) => `${r.workspace_id}|${r.table_name}|${r.row_key}|${r.field}`;
  const stamps = async () => (await q<{ workspace_id: string; table_name: string; row_key: string; field: string; origin: string; seq: string; hlc_wall: string; hlc_counter: number; author: string | null; device: string | null; deleted: boolean }>(
    `SELECT workspace_id::text, table_name, row_key, field, origin, seq::text, hlc_wall::text, hlc_counter, author, device::text, deleted FROM sync_stamps`)).rows;
  let batchesWithMissingStamps = 0;
  const counts = async () => (await q<{ s: string; l: string }>(`SELECT (SELECT count(*) FROM sync_stamps)::text AS s, (SELECT count(*) FROM structure_log)::text AS l`)).rows[0]!;

  async function batch(ops: Op[]): Promise<void> {
    const notes: string[] = [];
    const create = async () => { notes.push((await call("POST", "/api/nodes", { id: randomUUID(), title: `g ${randomUUID().slice(0, 6)}`, markdown: "x", space_id: space })).id); return notes.length - 1; };
    for (const _ of N) await create();
    const tags = [] as string[];
    for (const i of [0, 1]) tags.push((await call("POST", "/api/tags", { name: `g-tag-${i}-${randomUUID().slice(0, 6)}` })).id);
    const board = (await call("POST", "/api/canvases", { space_id: space })).id as string;
    const gone = new Set<number>();
    const edgeIds = new Map<string, string>();
    for (const op of ops) {
      switch (op.kind) {
        case "create": await create(); break;
        case "remove": if (!gone.has(op.note)) { await call("DELETE", `/api/nodes/${notes[op.note]}`); gone.add(op.note); } break;
        case "title": if (!gone.has(op.note)) await call("PATCH", `/api/nodes/${notes[op.note]}`, { title: `t ${op.n} ${randomUUID().slice(0, 4)}` }); break;
        case "tag": if (!gone.has(op.note)) await call(op.on ? "PUT" : "DELETE", `/api/nodes/${notes[op.note]}/tags/${tags[op.tag]}`); break;
        case "attr":
          if (gone.has(op.note)) break;
          if (op.value === null) await call("DELETE", `/api/nodes/${notes[op.note]}/attributes/mood`);
          else await call("PUT", `/api/nodes/${notes[op.note]}/attributes/mood`, { value: String(op.value) });
          break;
        case "edge": {
          if (gone.has(op.from) || gone.has(op.to)) break;
          const k = `${op.from}/${op.to}`;
          if (op.on && !edgeIds.has(k)) edgeIds.set(k, (await call("POST", "/api/edges", { source_node_id: notes[op.from], target_node_id: notes[op.to], edge_type: "relates_to" })).id);
          else if (!op.on && edgeIds.has(k)) { await call("DELETE", `/api/edges/${edgeIds.get(k)}`); edgeIds.delete(k); }
          break;
        }
        case "pointer": {
          if (gone.has(op.parent) || gone.has(op.target)) break;
          const id = (await q<{ id: string }>(`SELECT derive_row_id('note_pointer', $1, $2)::text AS id`, [notes[op.parent], notes[op.target]])).rows[0]!.id;
          const there = (await q(`SELECT 1 FROM note_pointers WHERE id = $1`, [id])).rows.length > 0;
          if (op.on && !there) await call("POST", "/api/pointers", { target_id: notes[op.target], parent_id: notes[op.parent] });
          else if (!op.on && there) await call("DELETE", `/api/pointers/${id}`);
          break;
        }
        case "card":
          if (gone.has(op.note)) break;
          if (op.on) await call("PATCH", `/api/boards/${board}`, { cards: { upsert: [{ nodeId: notes[op.note], x: op.x, y: 0 }] } });
          else await call("PATCH", `/api/boards/${board}`, { cards: { remove: [notes[op.note]] } });
          break;
      }
    }

    // from here on nothing reaches the shared database
    await rolledBack(async () => {
      // a database from before stamps: some units never had a stamp (every third, by a hash of the unit; the third differs per batch)
      const third = ops.length % 3;
      await q(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND mod(abs(hashtext(table_name || row_key || field)), 3) = $2`, [ws, third]);
      const before = await stamps();
      const beforeByKey = new Map(before.map((r) => [stampKey(r), r]));
      const countsBefore = await counts();
      await q(sqlText);

      const after = await stamps();
      const afterByKey = new Map(after.map((r) => [stampKey(r), r]));
      const units = (await q<Unit>(STAMPED_UNITS)).rows;
      expect(units.length).toBeGreaterThan(5);
      let missing = 0;
      for (const u of units) {
        if (!beforeByKey.has(stampKey({ workspace_id: u.ws, table_name: u.tn, row_key: u.rk, field: u.fld }))) missing++;
        const got = afterByKey.get(stampKey({ workspace_id: u.ws, table_name: u.tn, row_key: u.rk, field: u.fld }));
        expect(got, `${u.tn} ${u.fld} has no stamp after the migration`).toBeDefined();
      }
      if (missing > 0) batchesWithMissingStamps++;
      for (const [k, was] of beforeByKey) expect(afterByKey.get(k), `a stamp that was there changed: ${k}`).toEqual(was);
      for (const [k, now] of afterByKey) {
        if (beforeByKey.has(k)) continue;
        expect(now, `a new stamp is not the genesis stamp: ${k}`).toMatchObject({ origin: "genesis", seq: "0", hlc_wall: "0", hlc_counter: 0, author: null, device: null, deleted: false });
      }

      const countsAfter = await counts();
      expect(Number(countsAfter.s)).toBeGreaterThanOrEqual(Number(countsBefore.s));
      await q(sqlText);
      expect(await counts()).toEqual(countsAfter);

      // the same data, the same stamps
      const genesis = (await stamps()).filter((r) => r.origin === "genesis").map(stampKey).sort();
      await q(`DELETE FROM sync_stamps WHERE origin = 'genesis'`);
      await q(sqlText);
      expect((await stamps()).filter((r) => r.origin === "genesis").map(stampKey).sort()).toEqual(genesis);
    });
  }

  it("every unit has a stamp afterwards, what was stamped is untouched, and a second run adds nothing", async () => {
    await checkAsync(fc.asyncProperty(fc.array(OPS, { minLength: 1, maxLength: 20 }), async (ops) => { await batch(ops); }), 15);
    expect(batchesWithMissingStamps, "no batch had a unit without a stamp: the test did not exercise the migration").toBeGreaterThan(0);
  });

  it("what a device is sent carries no stamp: the stamp tables are read by no payload (bootstrap, sync delta, membership)", async () => {
    await batch([{ kind: "create" }, { kind: "tag", note: 0, tag: 0, on: true }, { kind: "attr", note: 1, value: 1 }, { kind: "edge", from: 0, to: 1, on: true }, { kind: "card", note: 0, on: true, x: 1 }]);
    const get = async (path: string, headers: Record<string, string> = {}) => { const res = await server.request(path, { headers }); expect(res.status, path).toBe(200); return res.text(); };
    for (const text of [await get("/api/bootstrap", { "x-onden-bootstrap": "lean2" }), await get("/api/bootstrap"), await get("/api/sync?since=0"), await get("/api/sync/membership")]) {
      expect(text).not.toMatch(/hlc_wall|hlc_counter|genesis|sync_stamps|structure_log/);
    }
  });

  it("a workspace backed up and restored is stamped by the restore writes, and the migration does not stamp it again", async () => {
    // a source workspace of its own, with content the restore has to write
    const make = async (name: string) => {
      const id = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id::text`, [name, `${name}-${randomUUID()}`])).rows[0]!.id;
      current = id;
      const person = await persistActor(id, { id: "", name: `Owner of ${name}`, type: "human", role: "editor" });
      await setWorkspaceOwner(id, person.id);
      const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [person.id])).rows[0]!.id;
      return { id, person, personal };
    };
    const as = (actor: ActorCtx) => {
      const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
      hono.onError(apiOnError);
      hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
      for (const [path, router] of [["/api/nodes", nodeRouter], ["/api/tags", tagRouter], ["/api/backup", backupRouter]] as const) hono.route(path, router);
      return hono;
    };
    try {
      const source = await make("genesis-source");
      const send = async (path: string, method: string, body: unknown) => {
        const res = await as(source.person).request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        expect(res.status, await res.clone().text()).toBeLessThan(300);
        return res.json() as Promise<{ id: string }>;
      };
      const parent = (await send("/api/nodes", "POST", { title: "Parent", markdown: "p\n" })).id;
      await send("/api/nodes", "POST", { title: "Child", markdown: "c [[Parent]]\n", parent_id: parent });
      const tagId = (await send("/api/tags", "POST", { name: "genesis-books" })).id;
      await send(`/api/nodes/${parent}/tags/${tagId}`, "PUT", {});
      await send(`/api/nodes/${parent}/attributes/mood`, "PUT", { value: "calm" });

      const zip = Buffer.from(await (await as(source.person).request("/api/backup/full.zip")).arrayBuffer());
      const target = await make("genesis-target");
      const uploaded = await as(target.person).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
      expect(uploaded.status, await uploaded.clone().text()).toBe(200);
      const uploadId = ((await uploaded.json()) as { upload_id: string }).upload_id;
      const started = await as(target.person).request(`/api/backup/restore/${uploadId}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: target.personal, mode: "workspace" }) });
      expect([200, 202]).toContain(started.status);
      const job = await waitForJob(as(target.person), ((await started.json()) as { job: Parameters<typeof waitForJob>[1] }).job);
      expect(job.status, JSON.stringify(job)).toBe("done");

      const restored = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes WHERE workspace_id = $1 AND title IN ('Parent', 'Child')`, [target.id])).rows[0]!.n;
      expect(Number(restored)).toBe(2);
      // every unit of both workspaces has a stamp, and none of the restored ones is a genesis stamp: the writes stamped them
      const units = (await q<Unit>(`SELECT * FROM (${STAMPED_UNITS}) u WHERE ws IN ($1, $2)`, [source.id, target.id])).rows;
      const have = new Map((await stamps()).map((r) => [stampKey(r), r]));
      expect(units.length).toBeGreaterThan(8);
      for (const u of units.filter((x) => x.ws === target.id)) {
        const stamp = have.get(stampKey({ workspace_id: u.ws, table_name: u.tn, row_key: u.rk, field: u.fld }));
        expect(stamp, `${u.tn} ${u.fld} of the restored workspace`).toBeDefined();
        expect(stamp!.origin, `${u.tn} ${u.fld}`).not.toBe("genesis");
      }
      // the migration adds no stamp to either workspace
      await rolledBack(async () => {
        const before = new Set((await stamps()).filter((r) => r.workspace_id === source.id || r.workspace_id === target.id).map(stampKey));
        await q(sqlText);
        const added = (await stamps()).filter((r) => (r.workspace_id === source.id || r.workspace_id === target.id) && !before.has(stampKey(r)));
        expect(added).toEqual([]);
      });
    } finally {
      current = "";
    }
  });
});
