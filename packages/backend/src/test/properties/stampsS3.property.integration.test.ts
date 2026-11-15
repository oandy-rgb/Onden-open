// Random operations on the S3 units (db/migrations/199_stamps_s3.sql): tag_schema keys, collection_views, space capability
// switches (through the real route), space members add / remove / role change, workspace time and module switches.
// After every operation:
//   1 every key or view the column holds has a live stamp; a key it does not hold has none (a tombstone, or nothing);
//   2 an operation that writes the same content again (another key order, another layout) stamps nothing;
//   3 (and after really deleting the space) replaying structure_log from its start gives the space's switches and its members as the tables hold them now.
// SAFETY: only runs against a *_test database; skips otherwise.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";
import { apiOnError } from "../../httpError.js";
import { getWorkspaceId, pool, q } from "../../db.js";
import tagRouter from "../../routes/tags.js";
import spaceRouter from "../../routes/spaces.js";
import workspaceRouter from "../../routes/workspace.js";
import { withRequestDevice } from "../../requestContext.js";
import type { ActorCtx } from "../../types.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { stampTransaction } from "../../spine/stamps.js";
import { persistActor } from "../helpers/persistActor.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { checkAsync } from "../helpers/propsConfig.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { capabilityProblems, memberProblems } from "../helpers/structureReplay.js";

const SWITCHES = ["publish", "external_ai", "backup", "shared_seen", "members_can_move_out"] as const;
const KEYS = ["a", "b", "c", "d"] as const;
const VIEW_IDS = ["v1", "v2", "v3", "v4"] as const;

type Op =
  | { kind: "schema-set"; key: (typeof KEYS)[number]; value: number }
  | { kind: "schema-remove"; key: (typeof KEYS)[number] }
  | { kind: "schema-rewrite" }
  | { kind: "views-set"; id: (typeof VIEW_IDS)[number]; name: number }
  | { kind: "views-remove"; id: (typeof VIEW_IDS)[number] }
  | { kind: "views-rewrite" }
  | { kind: "switch"; key: (typeof SWITCHES)[number]; on: boolean }
  | { kind: "member"; who: 0 | 1 | 2; permission: "view" | "edit" | "remove" }
  | { kind: "time"; hour: number }
  | { kind: "module"; off: boolean };

const OPS: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("schema-set" as const), key: fc.constantFrom(...KEYS), value: fc.integer({ min: 0, max: 3 }) }),
  fc.record({ kind: fc.constant("schema-remove" as const), key: fc.constantFrom(...KEYS) }),
  fc.constant({ kind: "schema-rewrite" as const }),
  fc.record({ kind: fc.constant("views-set" as const), id: fc.constantFrom(...VIEW_IDS), name: fc.integer({ min: 0, max: 3 }) }),
  fc.record({ kind: fc.constant("views-remove" as const), id: fc.constantFrom(...VIEW_IDS) }),
  fc.constant({ kind: "views-rewrite" as const }),
  fc.record({ kind: fc.constant("switch" as const), key: fc.constantFrom(...SWITCHES), on: fc.boolean() }),
  fc.record({ kind: fc.constant("member" as const), who: fc.constantFrom(0 as const, 1 as const, 2 as const), permission: fc.constantFrom("view" as const, "edit" as const, "remove" as const) }),
  fc.record({ kind: fc.constant("time" as const), hour: fc.integer({ min: 0, max: 3 }) }),
  fc.record({ kind: fc.constant("module" as const), off: fc.boolean() }),
);

describe.skipIf(!isTestDatabase())("stamps S3: random operations (DB)", { timeout: 300_000 }, () => {
  let ws = "";
  let owner!: ActorCtx;
  let members: ActorCtx[] = [];
  const server = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  server.onError(apiOnError);
  server.use("*", async (c, next) => { c.set("actor", owner); await withRequestDevice(randomUUID(), next); });
  server.route("/api/tags", tagRouter);
  server.route("/api/spaces", spaceRouter);
  server.route("/api/workspace", workspaceRouter);
  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await server.request(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    expect(res.status, `${method} ${path}: ${text}`).toBeLessThan(300);
    return text ? JSON.parse(text) : null;
  };
  const stamped = (write: () => Promise<unknown>) => withEventTransaction(ws, async () => { await stampTransaction(ws, owner.id); await write(); });
  const stampMap = async (table: string, key: string) => new Map((await q<{ field: string; seq: string; deleted: boolean }>(
    `SELECT field, seq::text, deleted FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3`, [ws, table, key])).rows.map((r) => [r.field, `${r.seq}/${r.deleted}`]));

  beforeAll(async () => {
    registerShippedModules();
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    owner = await persistActor(ws, { id: "", name: "S3 Prop Owner", role: "admin", type: "human" });
    members = [];
    for (let i = 0; i < 3; i++) members.push(await persistActor(ws, { id: "", name: `S3 Prop Member ${i}`, role: "editor", type: "human" }));
  });
  afterAll(async () => { await pool.end(); });

  async function run(ops: Op[]): Promise<void> {
    const tagId = (await ok("POST", "/api/tags", { name: `s3prop-${randomUUID().slice(0, 8)}` })).id as string;
    const spaceId = (await ok("POST", "/api/spaces", { name: `s3 prop ${randomUUID().slice(0, 6)}` })).id as string;
    const schema: Record<string, number> = {};
    const views = new Map<string, number>();
    const stampsNow = async () => ({
      schema: await stampMap("content_nodes.tag_schema", tagId), views: await stampMap("content_nodes.collection_views", tagId),
      caps: await stampMap("spaces.capabilities", spaceId),
    });
    const viewList = () => [...views].map(([id, name]) => ({ id, name: `n${name}`, layout: "table" }));
    for (const op of ops) {
      const where = JSON.stringify(op);
      const before = await stampsNow();
      let sameContent = false;
      switch (op.kind) {
        case "schema-set": { sameContent = schema[op.key] === op.value; schema[op.key] = op.value; await stamped(() => q(`UPDATE content_nodes SET tag_schema = $2::jsonb WHERE id = $1`, [tagId, JSON.stringify(schema)])); break; }
        case "schema-remove": { sameContent = !(op.key in schema); delete schema[op.key]; await stamped(() => q(`UPDATE content_nodes SET tag_schema = $2::jsonb WHERE id = $1`, [tagId, JSON.stringify(schema)])); break; }
        case "schema-rewrite": { sameContent = true; const reversed = Object.fromEntries(Object.entries(schema).reverse()); await stamped(() => q(`UPDATE content_nodes SET tag_schema = $2::jsonb WHERE id = $1`, [tagId, ` ${JSON.stringify(reversed, null, 2)} `])); break; }
        case "views-set": { sameContent = views.get(op.id) === op.name; views.set(op.id, op.name); await stamped(() => q(`UPDATE content_nodes SET collection_views = $2::jsonb WHERE id = $1`, [tagId, JSON.stringify(viewList())])); break; }
        case "views-remove": { sameContent = !views.has(op.id); views.delete(op.id); await stamped(() => q(`UPDATE content_nodes SET collection_views = $2::jsonb WHERE id = $1`, [tagId, JSON.stringify(viewList())])); break; }
        case "views-rewrite": { sameContent = true; const shuffled = viewList().reverse().map((v) => Object.fromEntries(Object.entries(v).reverse())); await stamped(() => q(`UPDATE content_nodes SET collection_views = $2::jsonb WHERE id = $1`, [tagId, JSON.stringify(shuffled)])); break; }
        case "switch": await ok("PATCH", `/api/spaces/${spaceId}`, { capabilities: { [op.key]: op.on } }); break;
        case "member": await ok(op.permission === "remove" ? "DELETE" : "PUT", `/api/spaces/${spaceId}/members/${members[op.who]!.id}`, op.permission === "remove" ? undefined : { permission: op.permission }); break;
        case "time": await ok("PATCH", "/api/workspace/time", { day_start_hour: op.hour }); break;
        case "module": await ok("PATCH", "/api/workspace/modules", { module: "external_calendars", imported: !op.off }); break;
      }
      const after = await stampsNow();
      // 2 writing the same content again stamps nothing
      if (sameContent) expect(after, `${where}: the same content stamped something`).toEqual(before);
      // 1 present keys have a live stamp, absent ones do not
      const live = (m: Map<string, string>) => new Set([...m].filter(([, v]) => v.endsWith("/false")).map(([k]) => k));
      const stored = (await q<{ tag_schema: Record<string, unknown> | null; collection_views: Array<{ id: string }> | null }>(`SELECT tag_schema, collection_views FROM content_nodes WHERE id = $1`, [tagId])).rows[0]!;
      expect([...live(after.schema)].sort(), `${where}: tag_schema stamps`).toEqual(Object.keys(stored.tag_schema ?? {}).map((k) => `key:${k}`).sort());
      expect([...live(after.views)].sort(), `${where}: view stamps`).toEqual((stored.collection_views ?? []).map((v) => `view:${v.id}`).sort());
      const caps = (await q<{ capabilities: Record<string, unknown> }>(`SELECT capabilities FROM spaces WHERE id = $1`, [spaceId])).rows[0]!.capabilities;
      expect([...live(after.caps)].sort(), `${where}: switch stamps`).toEqual(Object.keys(caps).map((k) => `switch:${k}`).sort());
      // 3 the structure log replays to the tables
      expect(await capabilityProblems(ws, spaceId), where).toEqual([]);
      expect(await memberProblems(ws, spaceId), where).toEqual([]);
    }
    // 4 really deleting the space leaves no stamp saying a member or a switch is still there, and the log replays to nothing
    await stamped(() => q(`DELETE FROM spaces WHERE id = $1`, [spaceId]));
    const stillLive = (await q<{ table_name: string; row_key: string; field: string }>(
      `SELECT table_name, row_key, field FROM sync_stamps WHERE workspace_id = $1 AND deleted = false
         AND ((table_name = 'space_members' AND row_key LIKE $2) OR (table_name = 'spaces.capabilities' AND row_key = $3))`, [ws, `${spaceId}/%`, spaceId])).rows;
    expect(stillLive, "after deleting the space").toEqual([]);
    expect(await memberProblems(ws, spaceId), "after deleting the space").toEqual([]);
    expect(await capabilityProblems(ws, spaceId), "after deleting the space").toEqual([]);
  }

  it("keeps the invariants through random operations", async () => {
    await checkAsync(fc.asyncProperty(fc.array(OPS, { minLength: 1, maxLength: 30 }), async (ops) => { await run(ops); }), 25);
  });
});
