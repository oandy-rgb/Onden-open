// Random operations through the real routes on the stamped rows people write (attributes, tag applications, hand-made
// edges, pointers, board cards). After every operation (causal-stamps proposal §8, "written ⇒ stamp, deleted ⇒ tombstone"):
//   1 a unit that is there has a live stamp that names its author; one that was there and is gone has a tombstone;
//   2 no write skipped the write entry (sync_clock.writes_without_mutate did not move): a stamp the trigger had to make
//     itself carries no author.
// SAFETY: only runs against a *_test database; skips otherwise.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";
import { apiOnError } from "../../httpError.js";
import { getWorkspaceId, pool, q } from "../../db.js";
import nodeRouter from "../../routes/nodes.js";
import tagRouter from "../../routes/tags.js";
import edgeRouter from "../../routes/edges.js";
import pointerRouter from "../../routes/pointers.js";
import boardRouter from "../../routes/boards.js";
import canvasRouter from "../../routes/canvases.js";
import { withRequestDevice } from "../../requestContext.js";
import { countWritesWithoutStamp } from "../../spine/stamps.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "../helpers/persistActor.js";
import { makeSpace } from "../helpers/spaceFixtures.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { checkAsync } from "../helpers/propsConfig.js";
import { isTestDatabase } from "../helpers/testDatabase.js";

const N = [0, 1, 2] as const;
const KEYS = ["mood", "stage"] as const;
type Op =
  | { kind: "tag"; note: number; tag: 0 | 1; on: boolean }
  | { kind: "attr"; note: number; key: (typeof KEYS)[number]; value: number | null }
  | { kind: "edge"; from: number; to: number; on: boolean }
  | { kind: "pointer"; parent: number; target: number; on: boolean }
  | { kind: "card"; note: number; on: boolean; x: number };

const n3 = fc.constantFrom(...N);
const OPS: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("tag" as const), note: n3, tag: fc.constantFrom(0 as const, 1 as const), on: fc.boolean() }),
  fc.record({ kind: fc.constant("attr" as const), note: n3, key: fc.constantFrom(...KEYS), value: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }) }),
  fc.record({ kind: fc.constant("edge" as const), from: n3, to: n3, on: fc.boolean() }).filter((o) => o.from !== o.to),
  fc.record({ kind: fc.constant("pointer" as const), parent: n3, target: n3, on: fc.boolean() }).filter((o) => o.parent !== o.target),
  fc.record({ kind: fc.constant("card" as const), note: n3, on: fc.boolean(), x: fc.integer({ min: 0, max: 2 }) }),
);

describe.skipIf(!isTestDatabase())("stamps: random route writes (DB)", { timeout: 300_000 }, () => {
  let ws = "";
  let owner!: ActorCtx;
  let space = "";
  const server = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  server.onError(apiOnError);
  server.use("*", async (c, next) => { c.set("actor", owner); await withRequestDevice(randomUUID(), next); });
  server.route("/api/nodes", nodeRouter);
  server.route("/api/tags", tagRouter);
  server.route("/api/edges", edgeRouter);
  server.route("/api/pointers", pointerRouter);
  server.route("/api/boards", boardRouter);
  server.route("/api/canvases", canvasRouter);
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
    owner = await persistActor(ws, { id: "", name: "Route Stamp Owner", role: "admin", type: "human" });
    space = await makeSpace(ws, `rs ${Date.now()}`, [{ id: owner.id, permission: "edit" }]);
  });
  afterAll(async () => { await pool.end(); });

  const stampOf = async (table: string, key: string) => (await q<{ deleted: boolean; author: string | null }>(
    `SELECT deleted, author FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = '*'`, [ws, table, key])).rows[0] ?? null;

  async function run(ops: Op[]): Promise<void> {
    const notes: string[] = [];
    for (const i of N) notes.push((await call("POST", "/api/nodes", { id: randomUUID(), title: `rs ${i} ${randomUUID().slice(0, 6)}`, markdown: "x", space_id: space })).id);
    const tags = [] as string[];
    for (const i of [0, 1]) tags.push((await call("POST", "/api/tags", { name: `rs-tag-${i}-${randomUUID().slice(0, 6)}` })).id);
    const board = (await call("POST", "/api/canvases", { space_id: space })).id as string;
    // what is there now / what has been there: the model the stamps are checked against
    const units = new Map<string, { table: string; key: string; there: boolean; ever: boolean }>();
    const unit = (table: string, key: string) => units.get(`${table}|${key}`) ?? (units.set(`${table}|${key}`, { table, key, there: false, ever: false }), units.get(`${table}|${key}`)!);
    const set = (table: string, key: string, there: boolean) => { const u = unit(table, key); u.there = there; u.ever ||= there; };
    const edgeIds = new Map<string, string>();
    const withoutAuthorBefore = await countWritesWithoutStamp(ws);

    for (const op of ops) {
      const where = JSON.stringify(op);
      switch (op.kind) {
        case "tag": {
          const [id, t] = [notes[op.note]!, tags[op.tag]!];
          await call(op.on ? "PUT" : "DELETE", `/api/nodes/${id}/tags/${t}`);
          set("node_tags", `${id}/${t}`, op.on);
          break;
        }
        case "attr": {
          const id = notes[op.note]!;
          if (op.value === null) await call("DELETE", `/api/nodes/${id}/attributes/${op.key}`);
          else await call("PUT", `/api/nodes/${id}/attributes/${op.key}`, { value: String(op.value) });
          set("node_attributes", `${id}/${op.key}`, op.value !== null);
          break;
        }
        case "edge": {
          const [a, b] = [notes[op.from]!, notes[op.to]!];
          const key = `${a}/${b}`;
          if (op.on && !edgeIds.has(key)) edgeIds.set(key, (await call("POST", "/api/edges", { source_node_id: a, target_node_id: b, edge_type: "relates_to" })).id);
          else if (!op.on && edgeIds.has(key)) { await call("DELETE", `/api/edges/${edgeIds.get(key)}`); edgeIds.delete(key); }
          set("node_edges", `${a}/${b}/relates_to`, edgeIds.has(key));
          break;
        }
        case "pointer": {
          const [parent, target] = [notes[op.parent]!, notes[op.target]!];
          const id = (await q<{ id: string }>(`SELECT derive_row_id('note_pointer', $1, $2)::text AS id`, [parent, target])).rows[0]!.id;
          if (op.on && !unit("note_pointers", id).there) await call("POST", "/api/pointers", { target_id: target, parent_id: parent });
          else if (!op.on && unit("note_pointers", id).there) await call("DELETE", `/api/pointers/${id}`);
          set("note_pointers", id, op.on);
          break;
        }
        case "card": {
          const id = notes[op.note]!;
          if (op.on) await call("PATCH", `/api/boards/${board}`, { cards: { upsert: [{ nodeId: id, x: op.x, y: 0 }] } });
          else if (unit("node_positions", `${id}/${board}`).there) await call("PATCH", `/api/boards/${board}`, { cards: { remove: [id] } });
          set("node_positions", `${id}/${board}`, op.on);
          break;
        }
      }
      for (const u of units.values()) {
        const stamp = await stampOf(u.table, u.key);
        if (u.there) expect(stamp, `${where}: ${u.table} ${u.key} is there but has no live stamp`).toMatchObject({ deleted: false });
        else if (u.ever) expect(stamp, `${where}: ${u.table} ${u.key} is gone but has no tombstone`).toMatchObject({ deleted: true });
        if (stamp) expect(stamp.author, `${where}: ${u.table} ${u.key} stamp has no author`).toBe(owner.id);
      }
      expect(await countWritesWithoutStamp(ws), `${where}: a write skipped the write entry`).toBe(withoutAuthorBefore);
    }
  }

  it("keeps the invariants through random operations", async () => {
    await checkAsync(fc.asyncProperty(fc.array(OPS, { minLength: 1, maxLength: 25 }), async (ops) => { await run(ops); }), 25);
  });
});
