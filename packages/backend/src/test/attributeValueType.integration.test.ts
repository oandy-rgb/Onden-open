// D21: the stored value_type of a schema field's value comes from the field,
// not from whichever writer sent it (services/attributeChange.ts,
// @onden/markdown attributeValue).
//   * a date typed into a collection table cell (the table sent value_type
//     'text') is found by the view's date filter and date sort;
//   * a rating set from the editor (sent as 'text') and rating/boolean field
//     defaults are stored as number/bool, so numeric reads see them;
//   * a free-form key keeps the writer's hint, a field-invalid date is refused;
//   * two tags declaring a key with different storage types leave it free-form;
//   * a date Postgres cannot cast is never stored as a date (no 500 filter);
//   * undo restores a value under the rule's type, also after the repair;
//   * migration 105 retypes rows written under the old rules, idempotently.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import importRouter from "../modules/importers/routes.js";
import { executeView } from "../services/collectionViewQuery.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { seedQ } from "./helpers/seedQ.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "d21-admin", name: "D21", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
app.route("/import", importRouter);
const send = (url: string, method: string, body: unknown = {}) => app.request(url, {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const create = async (body: Record<string, unknown>) => {
  const res = await send("/nodes", "POST", body);
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
};
const migration105 = () => readFile(fileURLToPath(new URL("../../db/migrations/105_attribute_value_type_repair.sql", import.meta.url)), "utf-8");
const stored = async (id: string, key: string) => (await q<{ value: string; value_type: string }>(
  `SELECT value, value_type FROM node_attributes WHERE node_id = $1 AND key = $2`, [id, key])).rows[0];

describe.skipIf(!isTestDb)("attribute value_type follows the schema field (DB)", () => {
  let tagId = "";

  beforeAll(async () => {
    registerShippedModules();
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('D21',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
    const stamp = randomUUID().slice(0, 8);
    tagId = (await seedClassTag(workspaceId, {
      name: `typed-${stamp}`, nodeSlug: `typed-${stamp}`,
      fields: [
        { name: "due", type: "date" },
        { name: "stars", type: "rating", max: 5 },
        { name: "score", type: "rating", default: "3" },
        { name: "done", type: "boolean", default: "false" },
      ],
    })).tagId;
  });

  it("a date edited in a table cell is found by the date filter and sorted by date", async () => {
    const early = await create({ title: "early", tag_ids: [tagId] });
    const late = await create({ title: "late", tag_ids: [tagId] });
    // What the table sent before D21: a non-numeric draft as 'text'.
    for (const [id, due] of [[late, "2026-12-01"], [early, "2026-03-01"]] as const) {
      const res = await send(`/nodes/${id}/attributes/due`, "PUT", { value: due, value_type: "text" });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(((await res.json()) as { value_type: string }).value_type).toBe("date");
    }
    expect(await stored(early, "due")).toEqual({ value: "2026-03-01", value_type: "date" });

    const readableIds = [early, late];
    const after = await executeView({
      workspaceId, tagId, sorts: [], visibleFields: ["due"], readableIds,
      filters: [{ field: "due", op: "gte", value: "2026-06-01" }],
    });
    expect(after.rows.map((r) => r.id)).toEqual([late]);
    const sorted = await executeView({
      workspaceId, tagId, filters: [], visibleFields: ["due"], readableIds,
      sorts: [{ field: "due", dir: "desc" }],
    });
    expect(sorted.rows.map((r) => r.id)).toEqual([late, early]);
  });

  it("a rating set from the editor is stored as a number and found by a numeric filter", async () => {
    const id = await create({ title: "rated", tag_ids: [tagId] });
    // The editor's old copy of the rule had no rating case: it sent 'text'.
    expect((await send(`/nodes/${id}/attributes/stars`, "PUT", { value: "4", value_type: "text" })).status).toBe(200);
    expect(await stored(id, "stars")).toEqual({ value: "4", value_type: "number" });
    const { rows } = await executeView({
      workspaceId, tagId, sorts: [], visibleFields: ["stars"], readableIds: [id],
      filters: [{ field: "stars", op: "gte", value: "3" }],
    });
    expect(rows.map((r) => r.id)).toEqual([id]);
  });

  it("rating and boolean field defaults are stored under their field types", async () => {
    const id = await create({ title: "defaults", tag_ids: [tagId] });
    expect(await stored(id, "score")).toEqual({ value: "3", value_type: "number" });
    expect(await stored(id, "done")).toEqual({ value: "false", value_type: "bool" });
  });

  it("refuses a date the calendar does not have, and keeps a free-form key's hint", async () => {
    const id = await create({ title: "checks", tag_ids: [tagId] });
    const bad = await send(`/nodes/${id}/attributes/due`, "PUT", { value: "2026-13-45" });
    expect(bad.status).toBe(422);
    expect((await send(`/nodes/${id}/attributes/budget`, "PUT", { value: "12", value_type: "number" })).status).toBe(200);
    expect(await stored(id, "budget")).toEqual({ value: "12", value_type: "number" });
    // No hint: the type is inferred from the value, not kept from the old row.
    expect((await send(`/nodes/${id}/attributes/when`, "PUT", { value: "2026-10-16" })).status).toBe(200);
    expect(await stored(id, "when")).toEqual({ value: "2026-10-16", value_type: "date" });
    expect((await send(`/nodes/${id}/attributes/when`, "PUT", { value: "TBD" })).status).toBe(200);
    expect(await stored(id, "when")).toEqual({ value: "TBD", value_type: "text" });
    // A hint the value does not fit is not trusted.
    expect((await send(`/nodes/${id}/attributes/when`, "PUT", { value: "soon", value_type: "date" })).status).toBe(200);
    expect(await stored(id, "when")).toEqual({ value: "soon", value_type: "text" });
  });

  it("a key two tags declare with different storage types is free-form, whichever tag came first", async () => {
    const stamp = randomUUID().slice(0, 8);
    const a = (await seedClassTag(workspaceId, { name: `a-${stamp}`, nodeSlug: `a-${stamp}`, fields: [{ name: "slot", type: "date" }] })).tagId;
    const b = (await seedClassTag(workspaceId, { name: `b-${stamp}`, nodeSlug: `b-${stamp}`, fields: [{ name: "slot", type: "text" }] })).tagId;
    for (const tags of [[a, b], [b, a]]) {
      const id = await create({ title: `both ${tags[0]}`, tag_ids: tags });
      const res = await send(`/nodes/${id}/attributes/slot`, "PUT", { value: "after lunch" });
      expect(res.status, await res.clone().text()).toBe(200); // the date field does not refuse it
      expect(await stored(id, "slot")).toEqual({ value: "after lunch", value_type: "text" });
      expect((await send(`/nodes/${id}/attributes/slot`, "PUT", { value: "2026-10-16", value_type: "text" })).status).toBe(200);
      expect(await stored(id, "slot")).toEqual({ value: "2026-10-16", value_type: "text" }); // the hint, not either field
    }
  });

  it("never stores a date Postgres cannot cast, so a date filter does not fail", async () => {
    const id = await create({ title: "zones", tag_ids: [tagId] });
    expect((await send(`/nodes/${id}/attributes/due`, "PUT", { value: "2026-10-16T10:00+16:00" })).status).toBe(422);
    expect((await send(`/nodes/${id}/attributes/due`, "PUT", { value: "2026-10-16T10:00+15:59" })).status).toBe(200);
    expect((await send(`/nodes/${id}/attributes/due`, "PUT", { value: "2026-10-16T10:00+05:99", value_type: "date" })).status).toBe(422);
    const free = await create({ title: "free zone", tag_ids: [tagId] });
    expect((await send(`/nodes/${free}/attributes/due`, "PUT", { value: "2026-10-01" })).status).toBe(200);
    expect((await send(`/nodes/${free}/attributes/at`, "PUT", { value: "2026-10-16T10:00+9999", value_type: "date" })).status).toBe(200);
    expect(await stored(free, "at")).toMatchObject({ value_type: "text" });
    const { rows } = await executeView({
      workspaceId, tagId, sorts: [], visibleFields: ["at"], readableIds: [id, free],
      filters: [{ field: "at", op: "gte", value: "2026-01-01" }],
    });
    expect(rows).toEqual([]);
  });

  it("undo restores a value under the rule's type, even after the repair retyped it", async () => {
    const id = await create({ title: "undo" });
    // Free-form, typed text by the writer (as the old table did)...
    expect((await send(`/nodes/${id}/attributes/due`, "PUT", { value: "2026-03-01", value_type: "text" })).status).toBe(200);
    expect((await send(`/nodes/${id}/attributes/due`, "PUT", { value: "2026-04-01", value_type: "text" })).status).toBe(200);
    const second = (await q<{ id: string }>(
      `SELECT id::text FROM domain_events WHERE target_id = $1 AND event_type = 'ATTRIBUTE_SET' AND payload->>'key' = 'due'
        ORDER BY domain_events.id DESC LIMIT 1`, [id])).rows[0]!.id;
    // ...then the date tag arrives and the repair retypes the row.
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id, tagId]);
    await seedQ(await readFile(fileURLToPath(new URL("../../db/migrations/105_attribute_value_type_repair.sql", import.meta.url)), "utf-8"));
    expect(await stored(id, "due")).toEqual({ value: "2026-04-01", value_type: "date" });
    expect(await restoreEvent(second, { actor, workspaceId })).toMatchObject({ restored: true });
    expect(await stored(id, "due")).toEqual({ value: "2026-03-01", value_type: "date" });
  });

  it("a note imported before D21 still re-imports after migration 105 retyped one of its values", async () => {
    const from = { id: randomUUID(), name: "d21-vault" }, path = `d21/${randomUUID().slice(0, 6)}.md`;
    const upload = async (content: string) => {
      const res = await send("/import/obsidian", "POST", { source: from, upsert: true, files: [{ path, content }] });
      expect(res.status, await res.clone().text()).toBe(200);
      return res.json();
    };
    expect(await upload("---\ndue: 2026-05-01\n---\nv1")).toMatchObject({ imported: 1 });
    const id = (await q<{ node_id: string }>(
      `SELECT node_id FROM node_attributes WHERE key = '_import_path' AND value = $1`, [path])).rows[0]!.node_id;
    // Frontmatter values are derived as the import commits; wait for it.
    await expect.poll(async () => (await stored(id, "due"))?.value, { timeout: 5000 }).toBe("2026-05-01");
    // The state before D21: the date tag applied, the value typed text by the
    // old writer, and the baseline stamped the old way (hashing value_type).
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [id, tagId]);
    await seedQ(`UPDATE node_attributes SET value_type = 'text' WHERE node_id = $1 AND key = 'due'`, [id]);
    const node = (await q(`SELECT title,markdown,parent_id,node_type FROM content_nodes WHERE id=$1`, [id])).rows[0];
    const attrs = (await q<{ source: string }>(`SELECT key,value,value_type,is_inheritable,source FROM node_attributes
      WHERE node_id=$1 AND left(key,8)<>'_import_' ORDER BY key`, [id])).rows.filter((a) => a.source !== "markdown" && a.source !== "dispatcher");
    const tags = (await q(`SELECT tag_id FROM node_tags WHERE node_id=$1 ORDER BY tag_id`, [id])).rows;
    const oldStamp = createHash("sha256").update(JSON.stringify({ node, attrs, tags })).digest("hex");
    await seedQ(`UPDATE node_attributes SET value = $2 WHERE node_id = $1 AND key = '_import_baseline'`, [id, oldStamp]);

    await seedQ(await migration105());
    expect(await stored(id, "due")).toMatchObject({ value_type: "date" });
    expect(await upload("---\ndue: 2026-05-01\n---\nv2")).toMatchObject({ updated: 1 });
    expect(await stored(id, "_import_retyped")).toBeUndefined(); // the new stamp no longer needs it
    expect(await upload("---\ndue: 2026-05-01\n---\nv3")).toMatchObject({ updated: 1 });
  });

  it("migration 105 leaves no uncastable value typed as a date or number, governed or not", async () => {
    const id = await create({ title: "uncastable" });
    const put = (key: string, value: string, type: string) => seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1,$2,$3,$4,$5,'ui')`,
      [workspaceId, id, key, value, type]);
    await put("feb", "2026-02-30", "date");
    await put("zone", "2026-02-01T10:00+16:00", "date");
    await put("padded", " 5 ", "number");
    await put("fine", "2026-02-28", "date");
    await seedQ(await migration105());
    expect(await stored(id, "feb")).toMatchObject({ value_type: "text" });
    expect(await stored(id, "zone")).toMatchObject({ value_type: "text" });
    expect(await stored(id, "padded")).toMatchObject({ value_type: "text" });
    expect(await stored(id, "fine")).toMatchObject({ value_type: "date" });
  });

  it("migration 105 retypes rows stored under the old rules, idempotently", async () => {
    const id = await create({ title: "legacy", tag_ids: [tagId] });
    const free = await create({ title: "free" });
    const put = (node: string, key: string, value: string, type: string) => seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1,$2,$3,$4,$5,'ui')
       ON CONFLICT (node_id, key) DO UPDATE SET value = EXCLUDED.value, value_type = EXCLUDED.value_type`,
      [workspaceId, node, key, value, type]);
    await put(id, "due", "2026-05-01", "text");
    await put(id, "stars", "4", "text");
    await put(id, "score", "3.0", "text");    // three stars, as the runtime rule reads it
    await put(id, "done", "true", "text");
    await put(free, "due", "2026-05-01", "text"); // no governing field: left alone
    const odd = await create({ title: "odd", tag_ids: [tagId] });
    await put(odd, "due", "2026-05-01T10:00+16:00", "date"); // Postgres cannot cast it: text
    await put(odd, "stars", "9", "number");                // over the scale: text
    await put(odd, "score", "", "number");                 // empty: text
    const imported = await create({ title: "imported", tag_ids: [tagId] });
    await put(imported, "due", "2026-05-01", "text");
    await put(imported, "_import_baseline", "abc", "text"); // retyped, the old type kept for its old baseline
    const sql = await readFile(fileURLToPath(new URL("../../db/migrations/105_attribute_value_type_repair.sql", import.meta.url)), "utf-8");
    await seedQ(sql);
    expect(await stored(id, "due")).toMatchObject({ value_type: "date" });
    expect(await stored(id, "stars")).toMatchObject({ value_type: "number" });
    expect(await stored(id, "score")).toMatchObject({ value_type: "number" });
    expect(await stored(id, "done")).toMatchObject({ value_type: "bool" });
    expect(await stored(free, "due")).toMatchObject({ value_type: "text" });
    expect(await stored(odd, "due")).toMatchObject({ value_type: "text" });
    expect(await stored(odd, "stars")).toMatchObject({ value_type: "text" });
    expect(await stored(odd, "score")).toMatchObject({ value_type: "text" });
    expect(await stored(imported, "due")).toMatchObject({ value_type: "date" });
    expect(await stored(imported, "_import_retyped")).toMatchObject({ value: '{"due": "text"}' });
    await seedQ(sql); // a second run changes nothing and does not fail
    expect(await stored(id, "due")).toMatchObject({ value_type: "date" });
  });
});
