// Write stamps and the structure log for the keys inside JSON columns, spaces, space members and workspace settings
// (db/migrations/199_stamps_s3.sql, causal-stamps proposal S3). For each stamped unit: create, change one key, remove one key,
// remove the row; one stamp per transaction; an untouched key keeps its stamp; the same content in another key order or
// layout changes nothing; the structure log replays to the table; none of it reaches a response, sync content or backup.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, pool, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import tagRouter from "../routes/tags.js";
import boardRouter from "../routes/boards.js";
import canvasRouter from "../routes/canvases.js";
import spaceRouter from "../routes/spaces.js";
import workspaceRouter from "../routes/workspace.js";
import backupRouter from "../routes/backup.js";
import syncRouter from "../routes/sync.js";
import bootstrapRouter from "../routes/bootstrap.js";
import { withRequestDevice } from "../requestContext.js";
import type { ActorCtx } from "../types.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { stampTransaction, countWritesWithoutStamp } from "../spine/stamps.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { zipEntries } from "./helpers/zipEntries.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { capabilityProblems, memberProblems } from "./helpers/structureReplay.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const DEVICE = randomUUID();
const MIGRATION = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../db/migrations/199_stamps_s3.sql"), "utf8");

type Stamp = { field: string; origin: string; seq: number; hlc_wall: number; hlc_counter: number; author: string | null; device: string | null; deleted: boolean };
type LogRow = { field: string; old_value: string | null; new_value: string | null; seq: number; author: string | null };

describe.skipIf(!isTestDb)("write stamps on JSON keys, spaces, space members and workspace settings", { timeout: 60_000 }, () => {
  let ws = "";
  let owner!: ActorCtx;
  let other!: ActorCtx;
  let space = "";
  const server = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  server.onError(apiOnError);
  server.use("*", async (c, next) => { c.set("actor", owner); await withRequestDevice(DEVICE, next); });
  server.route("/api/nodes", nodeRouter);
  server.route("/api/tags", tagRouter);
  server.route("/api/boards", boardRouter);
  server.route("/api/canvases", canvasRouter);
  server.route("/api/spaces", spaceRouter);
  server.route("/api/workspace", workspaceRouter);
  server.route("/api/backup", backupRouter);
  server.route("/api/sync", syncRouter);
  server.route("/api/bootstrap", bootstrapRouter);

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
  const tag = async () => (await ok("POST", "/api/tags", { name: `s3tag-${randomUUID().slice(0, 8)}` })).id as string;
  const note = async () => (await ok("POST", "/api/nodes", { id: randomUUID(), title: `s3 ${randomUUID().slice(0, 8)}`, markdown: "x", space_id: space })).id as string;
  const sharedSpace = async () => (await ok("POST", "/api/spaces", { name: `s3 space ${randomUUID().slice(0, 6)}` })).id as string;
  const stampsOf = async (table: string, key: string): Promise<Map<string, Stamp>> => new Map((await q<Stamp>(
    `SELECT field, origin, seq::int, hlc_wall::float8 AS hlc_wall, hlc_counter, author, device::text, deleted
       FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3`, [ws, table, key])).rows.map((r) => [r.field, r]));
  const logOf = async (table: string, key: string, fieldLike = "%"): Promise<LogRow[]> => (await q<LogRow>(
    `SELECT field, old_value, new_value, seq::int, author FROM structure_log
      WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field LIKE $4 ORDER BY id`, [ws, table, key, fieldLike])).rows;
  /** A write that carries a stamp, as a root write through mutate() does, for the columns no route reaches. */
  const stamped = (write: () => Promise<unknown>) => withEventTransaction(ws, async () => { await stampTransaction(ws, owner.id); await write(); });
  const setJson = (column: string, id: string, value: string | null) =>
    stamped(() => q(`UPDATE content_nodes SET ${column} = $2::jsonb WHERE id = $1`, [id, value]));
  const seqs = (m: Map<string, Stamp>) => Object.fromEntries([...m].map(([k, v]) => [k, v.seq]));

  beforeAll(async () => {
    registerShippedModules();
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    owner = await persistActor(ws, { id: "", name: "S3 Owner", role: "admin", type: "human" });
    other = await persistActor(ws, { id: "", name: "S3 Member", role: "editor", type: "human" });
    space = await makeSpace(ws, `s3 ${Date.now()}`, [{ id: owner.id, permission: "edit" }]);
  });
  afterAll(async () => { await pool.end(); });

  describe("content_nodes.tag_schema: one stamp per key", () => {
    const T = "content_nodes.tag_schema";
    it("create, change one key, remove one key: untouched keys keep their stamp, one transaction shares one stamp", async () => {
      const id = await tag();
      await setJson("tag_schema", id, JSON.stringify({ a: 1, b: { deep: [1, 2] }, c: "x" }));
      const created = await stampsOf(T, id);
      expect([...created.keys()].sort()).toEqual(["key:a", "key:b", "key:c"]);
      expect(new Set([...created.values()].map((s) => s.seq)).size).toBe(1); // three keys, one transaction, one stamp
      expect(created.get("key:a")).toMatchObject({ author: owner.id, device: null, deleted: false });

      await setJson("tag_schema", id, JSON.stringify({ a: 1, b: { deep: [1, 2, 3] }, c: "x" })); // only b changes
      const changed = await stampsOf(T, id);
      expect(changed.get("key:a")).toEqual(created.get("key:a"));
      expect(changed.get("key:c")).toEqual(created.get("key:c"));
      expect(changed.get("key:b")!.seq).toBeGreaterThan(created.get("key:b")!.seq);

      await setJson("tag_schema", id, JSON.stringify({ a: 1, b: { deep: [1, 2, 3] } })); // c removed
      const removed = await stampsOf(T, id);
      expect(removed.get("key:c")).toMatchObject({ deleted: true });
      expect(removed.get("key:c")!.seq).toBeGreaterThan(changed.get("key:c")!.seq);
      expect(removed.get("key:a")).toEqual(created.get("key:a"));

      await setJson("tag_schema", id, JSON.stringify({ a: 1, b: { deep: [1, 2, 3] }, c: "back" })); // the key comes back: the tombstone is replaced
      expect((await stampsOf(T, id)).get("key:c")).toMatchObject({ deleted: false });
    });

    it("the same content in another key order or layout is not a change; a JSON null is a value, not a missing key", async () => {
      const id = await tag();
      await setJson("tag_schema", id, `{"a": 1, "b": {"x": 1, "y": 2}, "n": null}`);
      const before = seqs(await stampsOf(T, id));
      await setJson("tag_schema", id, `{ "n":null,\n  "b": {"y": 2, "x": 1},   "a":1 }`);
      expect(seqs(await stampsOf(T, id))).toEqual(before);
      await setJson("tag_schema", id, `{"a": 1, "b": {"x": 1, "y": 2}}`); // n removed: now a missing key
      expect((await stampsOf(T, id)).get("key:n")).toMatchObject({ deleted: true });
    });

    it("a write that changes nothing takes no stamp at all", async () => {
      const id = await tag();
      await setJson("tag_schema", id, `{"a": 1}`);
      const clock = async () => (await q<{ next_seq: string }>(`SELECT next_seq::text FROM sync_clock WHERE workspace_id = $1`, [ws])).rows[0]!.next_seq;
      const before = await clock();
      await setJson("tag_schema", id, `{"a":   1}`);
      // the stamped() helper takes its own stamp; the trigger must not take another one
      expect(Number(await clock())).toBe(Number(before) + 1);
    });

    it("removing the row leaves a tombstone for every key it had", async () => {
      const id = await tag();
      await setJson("tag_schema", id, JSON.stringify({ a: 1, b: 2 }));
      await stamped(() => q(`DELETE FROM content_nodes WHERE id = $1`, [id]));
      const left = await stampsOf(T, id);
      expect([...left].map(([k, v]) => [k, v.deleted]).sort()).toEqual([["key:a", true], ["key:b", true]]);
    });

    it("the real schema write (PATCH) stamps only the keys it changed", async () => {
      const id = await tag();
      await ok("PATCH", `/api/tags/${id}/schema`, { fields: [{ name: "alpha", type: "text" }] });
      const first = await stampsOf(T, id);
      expect(first.get("key:fields")).toMatchObject({ author: owner.id, device: DEVICE, deleted: false });
      await ok("PATCH", `/api/tags/${id}/schema`, { behaviour: { sub_pages: false } });
      const second = await stampsOf(T, id);
      expect(second.get("key:fields")).toEqual(first.get("key:fields"));
      expect(second.get("key:behaviour")!.seq).toBeGreaterThan(first.get("key:fields")!.seq);
    });

    it("an ordinary body or title save never touches the JSON stamps", async () => {
      const id = await tag();
      await setJson("tag_schema", id, JSON.stringify({ a: 1 }));
      const before = await stampsOf(T, id);
      await ok("PATCH", `/api/nodes/${id}`, { markdown: "a body", title: `renamed ${randomUUID().slice(0, 4)}` });
      expect(await stampsOf(T, id)).toEqual(before);
    });
  });

  describe("content_nodes.collection_views: one stamp per view (the column is frozen since migration 188)", () => {
    const T = "content_nodes.collection_views";
    const view = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, layout: "table", ...extra });
    it("create, change one view, reorder, remove one view, remove the row", async () => {
      const id = await tag();
      await setJson("collection_views", id, JSON.stringify([view("v1", "One"), view("v2", "Two"), view("v3", "Three")]));
      const created = await stampsOf(T, id);
      expect([...created.keys()].sort()).toEqual(["view:v1", "view:v2", "view:v3"]);
      expect(new Set([...created.values()].map((s) => s.seq)).size).toBe(1);

      await setJson("collection_views", id, JSON.stringify([view("v1", "One"), view("v2", "Two!"), view("v3", "Three")]));
      const renamed = await stampsOf(T, id);
      expect(renamed.get("view:v1")).toEqual(created.get("view:v1"));
      expect(renamed.get("view:v3")).toEqual(created.get("view:v3"));
      expect(renamed.get("view:v2")!.seq).toBeGreaterThan(created.get("view:v2")!.seq);

      // the same views in another order, and with the keys of each view in another order: nothing
      await setJson("collection_views", id, `[{"layout":"table","id":"v3","name":"Three"},{"name":"One","id":"v1","layout":"table"},{"id":"v2","layout":"table","name":"Two!"}]`);
      expect(seqs(await stampsOf(T, id))).toEqual(seqs(renamed));

      await setJson("collection_views", id, JSON.stringify([view("v1", "One"), view("v3", "Three")]));
      const removed = await stampsOf(T, id);
      expect(removed.get("view:v2")).toMatchObject({ deleted: true });
      expect(removed.get("view:v1")).toEqual(created.get("view:v1"));

      await stamped(() => q(`DELETE FROM content_nodes WHERE id = $1`, [id]));
      const gone = await stampsOf(T, id);
      expect([...gone].map(([k, v]) => [k, v.deleted]).sort()).toEqual([["view:v1", true], ["view:v2", true], ["view:v3", true]]);
    });

    it("an element without a string id is not a unit and a column that is not an array has none", async () => {
      const id = await tag();
      await setJson("collection_views", id, JSON.stringify([{ name: "no id" }, 7, view("ok", "Fine")]));
      expect([...(await stampsOf(T, id)).keys()]).toEqual(["view:ok"]);
      await setJson("collection_views", id, JSON.stringify({ not: "an array" }));
      expect((await stampsOf(T, id)).get("view:ok")).toMatchObject({ deleted: true });
    });
  });

  describe("spaces: name, deleted state, each capability switch", () => {
    it("rename and delete stamp their own field; the capability switches are stamped one by one and logged old -> new", async () => {
      const id = await sharedSpace();
      const born = await stampsOf("spaces", id);
      expect(born.get("*")).toMatchObject({ author: owner.id, device: DEVICE, deleted: false });
      const caps = await stampsOf("spaces.capabilities", id);
      expect([...caps.keys()].every((k) => k.startsWith("switch:"))).toBe(true);
      const initial = seqs(caps);

      await ok("PATCH", `/api/spaces/${id}`, { name: "renamed space" });
      const renamed = await stampsOf("spaces", id);
      expect(renamed.get("name")!.seq).toBeGreaterThan(born.get("*")!.seq);
      expect(seqs(await stampsOf("spaces.capabilities", id))).toEqual(initial); // a rename touches no switch

      await ok("PATCH", `/api/spaces/${id}`, { capabilities: { publish: true } });
      const after = await stampsOf("spaces.capabilities", id);
      expect(after.get("switch:publish")!.seq).toBeGreaterThan(initial["switch:publish"] ?? 0);
      for (const [k, v] of Object.entries(initial)) if (k !== "switch:publish") expect(after.get(k)!.seq, k).toBe(v); // the other switches keep their stamp
      const log = await logOf("spaces", id, "capability:%");
      const last = log.filter((r) => r.field === "capability:publish").at(-1)!;
      expect(JSON.parse(last.new_value!)).toBe(true);
      expect(last.old_value === null || JSON.parse(last.old_value) === false).toBe(true);

      await ok("PATCH", `/api/spaces/${id}`, { capabilities: { publish: true } }); // the same again
      expect(seqs(await stampsOf("spaces.capabilities", id))).toEqual(seqs(after));

      await ok("DELETE", `/api/spaces/${id}`);
      expect((await stampsOf("spaces", id)).get("deleted")!.seq).toBeGreaterThan(renamed.get("name")!.seq);
      expect(await capabilityProblems(ws, id)).toEqual([]);
    });

    it("a switch removed from the column is a tombstone and a log line with a new value of NULL; removing the row tombstones the rest", async () => {
      const id = (await q<{ id: string }>(`INSERT INTO spaces (workspace_id, name, kind, capabilities) VALUES ($1, 's3 raw', 'shared', $2) RETURNING id::text`, [ws, JSON.stringify({ publish: true, backup: false })])).rows[0]!.id;
      await stamped(() => q(`UPDATE spaces SET capabilities = $2::jsonb WHERE id = $1`, [id, JSON.stringify({ backup: false })]));
      const stamps = await stampsOf("spaces.capabilities", id);
      expect(stamps.get("switch:publish")).toMatchObject({ deleted: true });
      expect(stamps.get("switch:backup")).toMatchObject({ deleted: false });
      expect((await logOf("spaces", id, "capability:publish")).map((r) => [r.old_value, r.new_value])).toEqual([[null, "true"], ["true", null]]);
      await stamped(() => q(`DELETE FROM spaces WHERE id = $1`, [id]));
      expect((await stampsOf("spaces.capabilities", id)).get("switch:backup")).toMatchObject({ deleted: true });
      expect((await stampsOf("spaces", id)).get("*")).toMatchObject({ deleted: true });
      expect(await capabilityProblems(ws, id)).toEqual([]);
    });
  });

  describe("spaces: kind and owner", () => {
    it("a personal space that becomes shared stamps kind and owner, each on its own; the name keeps its stamp", async () => {
      const person = (await q<{ id: string }>(`INSERT INTO actors (workspace_id, name, type) VALUES ($1, 'S3 agent', 'agent') RETURNING id::text`, [ws])).rows[0]!.id; // an agent has no personal space of its own
      const id = (await q<{ id: string }>(`INSERT INTO spaces (workspace_id, name, kind, owner_actor_id) VALUES ($1, 's3 personal', 'personal', $2) RETURNING id::text`, [ws, person])).rows[0]!.id;
      const born = await stampsOf("spaces", id);
      await stamped(() => q(`UPDATE spaces SET kind = 'shared', owner_actor_id = NULL, name = 's3 now shared' WHERE id = $1`, [id]));
      const after = await stampsOf("spaces", id);
      expect([...after.keys()].sort()).toEqual(["*", "kind", "name", "owner"]);
      expect(after.get("kind")!.seq).toBe(after.get("owner")!.seq);
      expect(after.get("kind")!.seq).toBeGreaterThan(born.get("*")!.seq);
      await stamped(() => q(`UPDATE spaces SET name = 's3 renamed' WHERE id = $1`, [id]));
      const renamed = await stampsOf("spaces", id);
      expect(renamed.get("kind")).toEqual(after.get("kind"));
      expect(renamed.get("owner")).toEqual(after.get("owner"));
      expect(renamed.get("name")!.seq).toBeGreaterThan(after.get("name")!.seq);
    });
  });

  describe("a space that is really deleted", () => {
    it("its members get a tombstone and a removed line in the log, and no stamp is left saying they are in", async () => {
      const id = await sharedSpace();
      const third = await persistActor(ws, { id: "", name: "S3 Gone", role: "editor", type: "human" });
      await ok("PUT", `/api/spaces/${id}/members/${other.id}`, { permission: "view" });
      await ok("PUT", `/api/spaces/${id}/members/${third.id}`, { permission: "edit" });
      await ok("PATCH", `/api/spaces/${id}`, { capabilities: { publish: true } });
      await stamped(() => q(`DELETE FROM spaces WHERE id = $1`, [id]));
      for (const m of [other.id, third.id]) {
        const left = await stampsOf("space_members", `${id}/${m}`);
        expect([...left.keys()]).toEqual(["*"]);
        expect(left.get("*")).toMatchObject({ deleted: true, author: owner.id });
        expect((await logOf("space_members", `${id}/${m}`)).at(-1)!.new_value).toBeNull();
      }
      expect(await memberProblems(ws, id)).toEqual([]);
      expect(await capabilityProblems(ws, id)).toEqual([]);
      expect((await stampsOf("spaces", id)).get("*")).toMatchObject({ deleted: true });
      expect((await q(`SELECT 1 FROM space_members WHERE space_id = $1`, [id])).rows).toEqual([]);
    });
  });

  describe("space_members: one stamp per (space, member)", () => {
    it("add, change the permission, remove: stamps, tombstone, and a log that replays to the table", async () => {
      const id = await sharedSpace();
      const key = `${id}/${other.id}`;
      await ok("PUT", `/api/spaces/${id}/members/${other.id}`, { permission: "view" });
      const added = await stampsOf("space_members", key);
      expect(added.get("*")).toMatchObject({ author: owner.id, device: DEVICE, deleted: false });

      await ok("PUT", `/api/spaces/${id}/members/${other.id}`, { permission: "view" }); // the same again
      expect(seqs(await stampsOf("space_members", key))).toEqual(seqs(added));

      await ok("PUT", `/api/spaces/${id}/members/${other.id}`, { permission: "edit" });
      const changed = await stampsOf("space_members", key);
      expect(changed.get("*")).toEqual(added.get("*"));
      expect(changed.get("permission")!.seq).toBeGreaterThan(added.get("*")!.seq);

      await ok("DELETE", `/api/spaces/${id}/members/${other.id}`);
      const removed = await stampsOf("space_members", key);
      expect([...removed.keys()]).toEqual(["*"]); // the field stamps go, the tombstone stays
      expect(removed.get("*")).toMatchObject({ deleted: true, author: owner.id });

      expect((await logOf("space_members", key)).map((r) => [r.field, r.old_value, r.new_value])).toEqual([
        ["permission", null, "view"], ["permission", "view", "edit"], ["permission", "edit", null]]);
      expect(await memberProblems(ws, id)).toEqual([]);

      await ok("PUT", `/api/spaces/${id}/members/${other.id}`, { permission: "view" }); // joins again: the tombstone is replaced
      expect((await stampsOf("space_members", key)).get("*")).toMatchObject({ deleted: false });
      expect(await memberProblems(ws, id)).toEqual([]);
    });

    it("a member added in one transaction and one removed in another get different stamps, and one transaction one stamp", async () => {
      const id = await sharedSpace();
      const third = await persistActor(ws, { id: "", name: "S3 Third", role: "editor", type: "human" });
      await stamped(async () => {
        await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'view'), ($1, $3, 'edit')`, [id, other.id, third.id]);
      });
      const [a, b] = [await stampsOf("space_members", `${id}/${other.id}`), await stampsOf("space_members", `${id}/${third.id}`)];
      expect(a.get("*")!.seq).toBe(b.get("*")!.seq);
      await stamped(() => q(`DELETE FROM space_members WHERE space_id = $1 AND actor_id = $2`, [id, other.id]));
      expect((await stampsOf("space_members", `${id}/${other.id}`)).get("*")!.seq).toBeGreaterThan(a.get("*")!.seq);
      expect(await memberProblems(ws, id)).toEqual([]);
    });
  });

  describe("workspaces: time zone, day-change hour, module switches", () => {
    let original: { time_zone: string | null; day_start_hour: number; modules_off: string[] } | undefined;
    beforeAll(async () => {
      original = (await q<{ time_zone: string | null; day_start_hour: number; modules_off: string[] }>(`SELECT time_zone, day_start_hour, modules_off FROM workspaces WHERE id = $1`, [ws])).rows[0];
    });
    afterAll(async () => {
      if (!original) return;
      await seedQ(`UPDATE workspaces SET time_zone = $2, day_start_hour = $3, modules_off = $4::jsonb WHERE id = $1`, [ws, original.time_zone, original.day_start_hour, JSON.stringify(original.modules_off)]);
    });

    it("time zone and day-change hour are separate stamps; the membership counter is not stamped", async () => {
      // The suite shares one database on real Postgres: another file may have left any time zone or hour here, and a
      // PATCH to the value already stored stamps nothing. Both values are chosen to differ from what is stored now.
      const zone = original!.time_zone === "Asia/Taipei" ? "Europe/Paris" : "Asia/Taipei";
      const hour = original!.day_start_hour === 3 ? 5 : 3;
      await ok("PATCH", "/api/workspace/time", { time_zone: zone, day_start_hour: hour });
      const first = await stampsOf("workspaces", ws);
      expect(first.get("time_zone")).toMatchObject({ author: owner.id, device: DEVICE });
      expect(first.get("day_start")).toMatchObject({ author: owner.id });
      await ok("PATCH", "/api/workspace/time", { day_start_hour: hour + 1 });
      const second = await stampsOf("workspaces", ws);
      expect(second.get("time_zone")).toEqual(first.get("time_zone"));
      expect(second.get("day_start")!.seq).toBeGreaterThan(first.get("day_start")!.seq);
      await ok("PATCH", "/api/workspace/time", { day_start_hour: hour + 1 }); // unchanged
      expect(seqs(await stampsOf("workspaces", ws))).toEqual(seqs(second));
      // the counter every membership change bumps stamps nothing
      await ok("PUT", `/api/spaces/${await sharedSpace()}/members/${other.id}`, { permission: "view" });
      expect(seqs(await stampsOf("workspaces", ws))).toEqual(seqs(second));
    });

    it("each module switch is one unit; turning a module on again is a tombstone of its off switch", async () => {
      // Start from "on", whatever an earlier file left in this shared workspace: when the module was already off (a helper's raw
      // UPDATE, stamped with no author), turning it off again changed nothing and the stamp below was that older one, in some orders.
      await ok("PATCH", "/api/workspace/modules", { module: "external_calendars", imported: true });
      const off = await ok("PATCH", "/api/workspace/modules", { module: "external_calendars", imported: false });
      expect(off.modules).not.toContain("external_calendars");
      const stamps = await stampsOf("workspaces.modules_off", ws);
      expect(stamps.get("off:external_calendars")).toMatchObject({ deleted: false, author: owner.id });
      const before = stamps.get("off:external_calendars")!;
      await ok("PATCH", "/api/workspace/modules", { module: "external_calendars", imported: true });
      const on = (await stampsOf("workspaces.modules_off", ws)).get("off:external_calendars")!;
      expect(on).toMatchObject({ deleted: true });
      expect(on.seq).toBeGreaterThan(before.seq);
    });

    it("module lists written in another order or layout are not a change", async () => {
      await seedQ(`UPDATE workspaces SET modules_off = '["a","b"]'::jsonb WHERE id = $1`, [ws]);
      const before = seqs(await stampsOf("workspaces.modules_off", ws));
      await seedQ(`UPDATE workspaces SET modules_off = ' [ "a" ,"b" ] '::jsonb WHERE id = $1`, [ws]);
      expect(seqs(await stampsOf("workspaces.modules_off", ws))).toEqual(before);
    });
  });

  describe("a board's section frames: one stamp per section as well as the whole-value log", () => {
    it("add two sections, change one, remove one: only the changed ones are stamped; the whole-value log is kept", async () => {
      const board = (await ok("POST", "/api/canvases", { space_id: space })).id as string;
      const T = "node_attributes._canvas_sections";
      await ok("PATCH", `/api/boards/${board}`, { sections: { upsert: [frame("s1", "one"), frame("s2", "two")] } });
      const created = await stampsOf(T, board);
      expect([...created.keys()].sort()).toEqual(["section:s1", "section:s2"]);
      expect(created.get("section:s1")!.seq).toBe(created.get("section:s2")!.seq);
      expect(created.get("section:s1")).toMatchObject({ author: owner.id, device: DEVICE, deleted: false });

      await ok("PATCH", `/api/boards/${board}`, { sections: { upsert: [frame("s2", "two!")] } });
      const changed = await stampsOf(T, board);
      expect(changed.get("section:s1")).toEqual(created.get("section:s1"));
      expect(changed.get("section:s2")!.seq).toBeGreaterThan(created.get("section:s2")!.seq);

      await ok("PATCH", `/api/boards/${board}`, { sections: { upsert: [frame("s2", "two!")] } }); // the same frame again
      expect(seqs(await stampsOf(T, board))).toEqual(seqs(changed));

      await ok("PATCH", `/api/boards/${board}`, { sections: { remove: ["s1"] } });
      const removed = await stampsOf(T, board);
      expect(removed.get("section:s1")).toMatchObject({ deleted: true });
      expect(removed.get("section:s2")).toEqual(changed.get("section:s2"));

      await ok("PATCH", `/api/boards/${board}`, { sections: { remove: ["s2"] } }); // the attribute itself goes
      expect((await stampsOf(T, board)).get("section:s2")).toMatchObject({ deleted: true });
      expect((await logOf("node_attributes", `${board}/_canvas_sections`, "sections")).length).toBe(4); // S2's whole-value lines are all still there
    });

    it("frame text that is not JSON never fails the write", async () => {
      const board = (await ok("POST", "/api/canvases", { space_id: space })).id as string;
      await stamped(() => q(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, '_canvas_sections', 'not json', 'text', 'ui')`, [ws, board]));
      expect([...(await stampsOf("node_attributes._canvas_sections", board)).keys()]).toEqual([]);
    });
  });

  it("stamps and the structure log appear in no response, no sync content, no bootstrap and no backup", async () => {
    const head = (await q<{ n: string }>(`SELECT COALESCE(max(id), 0)::text AS n FROM domain_events`)).rows[0]!.n;
    const id = await sharedSpace();
    await ok("PUT", `/api/spaces/${id}/members/${other.id}`, { permission: "edit" });
    await ok("PATCH", `/api/spaces/${id}`, { capabilities: { publish: true } });
    const t = await tag();
    await ok("PATCH", `/api/tags/${t}/schema`, { fields: [{ name: "visible_field", type: "text" }] });
    const board = (await ok("POST", "/api/canvases", { space_id: space })).id as string;
    await ok("PATCH", `/api/boards/${board}`, { sections: { upsert: [frame("frame-x", "visible frame")] } });
    const origin = (await stampsOf("space_members", `${id}/${other.id}`)).get("*")!.origin;
    expect(origin).toMatch(/\S/);
    const words = ["sync_stamps", "structure_log", "hlc_wall", "hlc_counter", "writes_without_mutate", "row_key", "onden.stamp", "switch:publish", "key:fields", "section:frame-x", origin];
    const notClaimed = (label: string, text: string) => { for (const w of words) expect(text.includes(w), `${label} mentions ${w}`).toBe(false); };
    const claimed = (label: string, text: string, ...needles: string[]) => { for (const n of needles) expect(text.includes(n), `${label} no longer carries ${n}: the check would pass for nothing`).toBe(true); };
    const each: Array<[string, unknown, string[]]> = [
      ["spaces", await ok("GET", "/api/spaces"), [id]],
      ["space members", await ok("GET", `/api/spaces/${id}/members`), [other.id]],
      ["tags", await ok("GET", "/api/tags"), [t]],
      ["board", await ok("GET", `/api/boards/${board}`), ["visible frame"]],
      ["workspace", await ok("PATCH", "/api/workspace/time", {}), []],
    ];
    for (const [label, body, needles] of each) { const text = JSON.stringify(body); claimed(label, text, ...needles); notClaimed(label, text); }
    const boot = JSON.stringify(await ok("GET", "/api/bootstrap"));
    claimed("bootstrap", boot, id, t, "visible_field");
    notClaimed("bootstrap", boot);
    notClaimed("sync membership", JSON.stringify(await ok("GET", "/api/sync/membership")));
    const delta = JSON.stringify(await ok("GET", `/api/sync?since=${head}`));
    notClaimed("sync delta", delta);
    const res = await server.request("/api/backup/full.zip");
    expect(res.status).toBe(200);
    const zip = zipEntries(Buffer.from(await res.arrayBuffer()));
    expect([...zip.values()].some((data) => data.toString("utf8").includes("visible frame"))).toBe(true);
    for (const [name, data] of zip) notClaimed(`backup file ${name}`, data.toString("utf8"));
  });

  it("a write that skips mutate on these tables is stamped without an author and counted", async () => {
    const before = await countWritesWithoutStamp();
    const id = (await q<{ id: string }>(`INSERT INTO spaces (workspace_id, name, kind, capabilities) VALUES ($1, 's3 bypass', 'shared', '{"publish": true}'::jsonb) RETURNING id::text`, [ws])).rows[0]!.id;
    expect((await stampsOf("spaces", id)).get("*")).toMatchObject({ author: null, deleted: false });
    expect((await stampsOf("spaces.capabilities", id)).get("switch:publish")).toMatchObject({ author: null, deleted: false });
    expect(await countWritesWithoutStamp()).toBe(before + 1); // one transaction, one stamp, one count
    await seedQ(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'view')`, [id, other.id]);
    expect(await countWritesWithoutStamp()).toBe(before + 2);
  });

  describe("a database that already has data", () => {
    it("a row from before the migration has no stamp; its first write stamps only what it changes; running the migration again changes nothing", async () => {
      const id = await tag();
      await setJson("tag_schema", id, JSON.stringify({ a: 1, b: 2 }));
      const spaceId = await sharedSpace();
      await ok("PUT", `/api/spaces/${spaceId}/members/${other.id}`, { permission: "view" });
      // what a row written before the migration looks like: no stamps, no log lines
      await seedQ(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND (row_key = $2 OR row_key LIKE $3 OR row_key = $4)`, [ws, id, `${spaceId}/%`, spaceId]);
      expect((await stampsOf("content_nodes.tag_schema", id)).size).toBe(0);

      const snapshot = async () => ({
        stamps: (await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_stamps`)).rows[0]!.n,
        log: (await q<{ n: string }>(`SELECT count(*)::text AS n FROM structure_log`)).rows[0]!.n,
        clock: (await q<{ n: string }>(`SELECT sum(next_seq)::text AS n FROM sync_clock`)).rows[0]!.n,
        rows: (await q<{ h: string }>(`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS h FROM (
            SELECT id, tag_schema::text FROM content_nodes WHERE id = $1 UNION ALL SELECT id, capabilities::text FROM spaces WHERE id = $2) t`, [id, spaceId])).rows[0]!.h,
      });
      const before = await snapshot();
      await pool.query(MIGRATION);
      expect(await snapshot()).toEqual(before); // the migration writes no stamp, no log line and no row of the data it watches
      expect((await stampsOf("content_nodes.tag_schema", id)).size).toBe(0);

      await setJson("tag_schema", id, JSON.stringify({ a: 1, b: 3 }));
      expect([...(await stampsOf("content_nodes.tag_schema", id)).keys()]).toEqual(["key:b"]); // a is unknown until S5, only b was written
      await pool.query(MIGRATION); // again, after the triggers have been used
      await setJson("tag_schema", id, JSON.stringify({ a: 1, b: 3 }));
      expect([...(await stampsOf("content_nodes.tag_schema", id)).keys()]).toEqual(["key:b"]);
    });
  });
});

const frame = (id: string, title: string) => ({ id, title, x: 0, y: 0, width: 100, height: 80 });
