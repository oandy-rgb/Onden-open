// D94: a write that changes which field governs a key retypes the stored
// values (services/attributeChange.ts retypeGoverned), so the server's typed
// reads — a saved view's range filter and sort — agree with the app, which
// types values from the current schema:
//   * a #book `pages` field changed from text to number: `pages > 100` finds
//     the books and the sort is numeric (and undoing the change types back);
//   * tagging a note whose date-like value was typed text retypes it as a
//     date; untagging keeps the date (normalize keeps a free-form value's
//     stored type when the value fits it); undoing an untag retypes again;
//   * a tag moved under a parent with typed fields retypes its notes;
//   * merging a tag into one with a typed field retypes its notes and those
//     of its child tags.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import tagsRouter from "../routes/tags.js";
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
let actor: ActorCtx = { id: "d94-admin", name: "D94", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
app.route("/tags", tagsRouter);
const send = async (url: string, method: string, body: unknown = {}) => {
  const res = await app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status, `${method} ${url}: ${await res.clone().text()}`).toBeLessThan(300);
  return res;
};
const create = async (body: Record<string, unknown>) => ((await (await send("/nodes", "POST", body)).json()) as { id: string }).id;
const put = (id: string, key: string, value: string, value_type?: string) =>
  send(`/nodes/${id}/attributes/${key}`, "PUT", { value, ...(value_type ? { value_type } : {}) });
const typeOf = async (id: string, key: string) => (await q<{ value_type: string }>(
  `SELECT value_type FROM node_attributes WHERE node_id = $1 AND key = $2`, [id, key])).rows[0]?.value_type;
const lastEvent = async (type: string, target: string) => (await q<{ id: string }>(
  `SELECT id::text FROM domain_events WHERE event_type = $1 AND target_id = $2 ORDER BY domain_events.id DESC LIMIT 1`, [type, target])).rows[0]!.id;
const tag = async (name: string, fields: unknown[]) => {
  const stamp = randomUUID().slice(0, 8);
  return (await seedClassTag(workspaceId, { name: `${name}-${stamp}`, nodeSlug: `${name}-${stamp}`, fields })).tagId;
};

describe.skipIf(!isTestDb)("stored value types follow the governing field (D94, DB)", () => {
  beforeAll(async () => {
    registerShippedModules();
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('D94',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  it("a text field changed to number: the view filter finds the values and sorts them as numbers", async () => {
    const book = await tag("book", [{ name: "pages", type: "text" }]);
    const ids: Record<string, string> = {};
    for (const pages of ["320", "1000", "50"]) {
      ids[pages] = await create({ title: `book ${pages}`, tag_ids: [book] });
      await put(ids[pages], "pages", pages);
      expect(await typeOf(ids[pages], "pages")).toBe("text");
    }
    const readableIds = Object.values(ids);
    const over100 = async () => (await executeView({
      workspaceId, tagId: book, sorts: [], visibleFields: ["pages"], readableIds,
      filters: [{ field: "pages", op: "gt", value: "100" }],
    })).rows.map((r) => r.id).sort();
    const sorted = async () => (await executeView({
      workspaceId, tagId: book, filters: [], visibleFields: ["pages"], readableIds,
      sorts: [{ field: "pages", dir: "asc" }],
    })).rows.map((r) => r.id);
    expect(await over100()).toEqual([]);
    expect(await sorted()).toEqual([ids["1000"], ids["320"], ids["50"]]); // textual

    const attributeEvents = async () => (await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM domain_events WHERE target_id = ANY($1::text[]) AND event_type LIKE 'ATTRIBUTE_%'`,
      [readableIds])).rows[0]!.n;
    const before = await attributeEvents();
    await send(`/tags/${book}/schema`, "PATCH", { fields: [{ name: "pages", type: "number" }] });
    for (const id of readableIds) expect(await typeOf(id, "pages")).toBe("number");
    expect(await over100()).toEqual([ids["320"], ids["1000"]].sort());
    expect(await sorted()).toEqual([ids["50"], ids["320"], ids["1000"]]);
    // A retype is no edit: no event per row (the values are not touched).
    expect(await attributeEvents()).toBe(before);

    // Undoing the schema change types them back.
    expect(await restoreEvent(await lastEvent("TAG_SCHEMA_UPDATED", book), { actor, workspaceId })).toMatchObject({ restored: true });
    for (const id of readableIds) expect(await typeOf(id, "pages")).toBe("text");
  });

  it("tagging retypes a date-like text value as a date; untagging keeps it; undoing an untag retypes again", async () => {
    const event = await tag("event", [{ name: "when", type: "date" }]);
    const id = await create({ title: "party" });
    await put(id, "when", "2026-10-20", "text"); // free-form, typed text by its writer
    expect(await typeOf(id, "when")).toBe("text");

    await send(`/nodes/${id}/tags/${event}`, "PUT");
    expect(await typeOf(id, "when")).toBe("date");
    const { rows } = await executeView({
      workspaceId, tagId: event, sorts: [], visibleFields: ["when"], readableIds: [id],
      filters: [{ field: "when", op: "gte", value: "2026-10-01" }],
    });
    expect(rows.map((r) => r.id)).toEqual([id]);

    // Free-form again: the stored type is kept as the hint, and the value fits it.
    await send(`/nodes/${id}/tags/${event}`, "DELETE");
    expect(await typeOf(id, "when")).toBe("date");
    await put(id, "when", "2026-10-20", "text");
    expect(await typeOf(id, "when")).toBe("text");
    // Undoing the untag puts the date field back over the value.
    expect(await restoreEvent(await lastEvent("TAG_REMOVED", id), { actor, workspaceId })).toMatchObject({ restored: true });
    expect(await typeOf(id, "when")).toBe("date");
  });

  it("a tag moved under a parent with a typed field retypes its notes", async () => {
    const parent = await tag("shelf", [{ name: "pages", type: "number" }]);
    const child = await tag("paperback", []);
    const id = await create({ title: "paperback", tag_ids: [child] });
    await put(id, "pages", "240", "text");
    expect(await typeOf(id, "pages")).toBe("text");
    await send(`/nodes/${child}`, "PATCH", { parent_id: parent });
    expect(await typeOf(id, "pages")).toBe("number");
  });

  it("merging a tag into one with a typed field retypes its notes and its child tags' notes", async () => {
    const target = await tag("tome", [{ name: "pages", type: "number" }]);
    const source = await tag("volume", [{ name: "pages", type: "text" }]);
    const sub = await tag("sub", []);
    await seedQ(`UPDATE content_nodes SET parent_id = $2 WHERE id = $1`, [sub, source]);
    const member = await create({ title: "volume one", tag_ids: [source] });
    const subMember = await create({ title: "sub one", tag_ids: [sub] });
    await put(member, "pages", "320");
    await put(subMember, "pages", "120");
    expect([await typeOf(member, "pages"), await typeOf(subMember, "pages")]).toEqual(["text", "text"]);

    await send(`/tags/${source}/merge`, "POST", { target_id: target });
    expect(await typeOf(member, "pages")).toBe("number");
    expect(await typeOf(subMember, "pages")).toBe("number");
    const { rows } = await executeView({
      workspaceId, tagId: target, sorts: [], visibleFields: ["pages"], readableIds: [member, subMember],
      filters: [{ field: "pages", op: "gt", value: "100" }],
    });
    expect(rows.map((r) => r.id).sort()).toEqual([member, subMember].sort());
  });
});
