// A tag used only on paragraphs is used. The catalog's block_usage_count (the sidebar's number and its 「沒在用」),
// the delete confirmation's paragraph count and the tag page's paragraph list are one count: the same
// blockNodes.blockQuerySql scope, so a paragraph in a note the reader cannot read counts for none of them.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import { readTagCatalog, blockEventTagUse } from "../services/tagCatalog.js";
import { tagDeletePreview } from "../services/tagReads.js";
import { tagBlocks } from "../services/blockNodes.js";
import { buildSyncDelta } from "../services/sync/delta.js";
import { buildBootstrap } from "../services/sync/bootstrap.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("a tag on paragraphs is counted as used (DB)", () => {
  const stamp = Date.now();
  const alice: ActorCtx = { id: "alice", name: "Alice", role: "admin", type: "human" };
  const bob: ActorCtx = { id: "bob", name: "Bob", role: "editor", type: "human" };
  let actor: ActorCtx = alice;
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/nodes", nodesRouter);

  const entry = async (who: ActorCtx, name: string) => (await readTagCatalog(who, WS) as unknown as Array<{ id: string; name: string; usage_count: number; block_usage_count: number }>).find((tag) => tag.name === name);

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Tag usage', $1) RETURNING id`, [`tag-usage-${stamp}`])).rows[0]!.id;
    for (const who of [alice, bob]) Object.assign(who, await persistActor(WS, who));
    await setModulesOn(WS, null);
    actor = alice;
    const res = await app.request("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "第 9 章", markdown: "第一段 {作業}\n\n第二段 {作業}\n\n第三段 {考點}" }) });
    expect(res.status).toBe(201);
  });

  it("the catalog counts paragraphs beside notes, for a reader who can read the note", async () => {
    expect(await entry(alice, "作業")).toMatchObject({ usage_count: 0, block_usage_count: 2 });
    expect(await entry(alice, "考點")).toMatchObject({ usage_count: 0, block_usage_count: 1 });
  });

  it("the delete confirmation, the tag page's list and the catalog give the same number", async () => {
    const tag = (await entry(alice, "作業"))!;
    const preview = await tagDeletePreview(alice, WS, tag.id);
    expect(preview).toMatchObject({ members: 0, paragraphs: tag.block_usage_count });
    const page = await tagBlocks(alice, WS, tag.id, { limit: 10, offset: 0 });
    expect(page.total).toBe(tag.block_usage_count);
  });

  it("a reader who cannot read the note counts none of it", async () => {
    const tag = (await entry(bob, "作業"))!;
    expect(tag.block_usage_count).toBe(0);
    expect(await tagDeletePreview(bob, WS, tag.id)).toMatchObject({ paragraphs: 0 });
  });

  it("the bootstrap ships the count, and a paragraph gaining a tag makes the next delta ship the catalog again", async () => {
    actor = alice;
    const made = await app.request("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "第 10 章", markdown: "甲 {進度}\n\n乙" }) });
    expect(made.status).toBe(201);
    const noteId = ((await made.json()) as { id: string }).id;
    const boot = await buildBootstrap(alice, WS, { slimBodies: false });
    const shipped = (boot.tags as unknown as Array<{ name: string; block_usage_count: number }>).find((tag) => tag.name === "進度");
    expect(shipped?.block_usage_count).toBe(1);
    const since = Number(boot.last_event_id);
    const res = await app.request(`/api/nodes/${noteId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ markdown: "甲 {進度}\n\n乙 {進度}" }) });
    expect(res.status).toBe(200);
    const delta = await buildSyncDelta(alice, WS, { since, known: [] });
    const tags = (delta as unknown as { tags?: Array<{ name: string; block_usage_count: number }> }).tags;
    expect(tags?.find((tag) => tag.name === "進度")?.block_usage_count).toBe(2);
  });

  it("deleting a note and bringing it back re-ships the catalog, so the sidebar's paragraph count follows", async () => {
    actor = alice;
    const made = await app.request("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "第 11 章", markdown: "甲 {複習日}\n\n乙 {複習日}\n\n丙 {複習日}" }) });
    const noteId = ((await made.json()) as { id: string }).id;
    const countIn = (tags: Array<{ name: string; block_usage_count: number }> | undefined) => tags?.find((tag) => tag.name === "複習日")?.block_usage_count;
    type Shipped = { tags?: Array<{ name: string; block_usage_count: number }> };
    const before = await buildBootstrap(alice, WS, { slimBodies: false });
    expect(countIn(before.tags as unknown as Shipped["tags"])).toBe(3);
    const deleted = await app.request(`/api/nodes/${noteId}`, { method: "DELETE" });
    expect(deleted.status).toBeLessThan(300);
    const afterDelete = await buildSyncDelta(alice, WS, { since: Number(before.last_event_id), known: [] }) as unknown as Shipped;
    expect(countIn(afterDelete.tags)).toBe(0);
    const mid = await buildBootstrap(alice, WS, { slimBodies: false });
    const restored = await app.request(`/api/nodes/${noteId}/undelete`, { method: "POST" });
    expect(restored.status).toBeLessThan(300);
    const afterRestore = await buildSyncDelta(alice, WS, { since: Number(mid.last_event_id), known: [] }) as unknown as Shipped;
    expect(countIn(afterRestore.tags)).toBe(3);
  });

  it("deleting a note with no tagged paragraphs does not re-ship the catalog", async () => {
    actor = alice;
    const made = await app.request("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "沒有標籤的一篇", markdown: "只是文字" }) });
    const noteId = ((await made.json()) as { id: string }).id;
    const boot = await buildBootstrap(alice, WS, { slimBodies: false });
    await app.request(`/api/nodes/${noteId}`, { method: "DELETE" });
    const delta = await buildSyncDelta(alice, WS, { since: Number(boot.last_event_id), known: [] }) as unknown as { tags?: unknown };
    expect(delta.tags).toBeUndefined();
  });

  it("a paragraph cut out and pasted back: the count goes to 0 and returns to its value", async () => {
    actor = alice;
    const body = "前言\n\n唯一一段 {唯一用處}\n\n後記";
    const made = await app.request("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "第 12 章", markdown: body }) });
    const noteId = ((await made.json()) as { id: string }).id;
    type Shipped = { tags?: Array<{ name: string; block_usage_count: number }> };
    const countIn = (shipped: Shipped | undefined) => shipped?.tags?.find((tag) => tag.name === "唯一用處")?.block_usage_count;
    const patch = (markdown: string) => app.request(`/api/nodes/${noteId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ markdown }) });
    const head = async () => Number((await buildBootstrap(alice, WS, { slimBodies: false })).last_event_id);
    let since = await head();
    expect((await patch("前言\n\n後記")).status).toBe(200);
    expect(countIn(await buildSyncDelta(alice, WS, { since, known: [] }) as unknown as Shipped)).toBe(0);
    since = await head();
    expect((await patch(body)).status).toBe(200);
    expect(countIn(await buildSyncDelta(alice, WS, { since, known: [] }) as unknown as Shipped)).toBe(1);
  });

  it("removing a paragraph that has no tags does not re-ship the catalog", async () => {
    actor = alice;
    const made = await app.request("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "第 13 章", markdown: "留下\n\n要刪掉的一段" }) });
    const noteId = ((await made.json()) as { id: string }).id;
    const since = Number((await buildBootstrap(alice, WS, { slimBodies: false })).last_event_id);
    await app.request(`/api/nodes/${noteId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ markdown: "留下" }) });
    const delta = await buildSyncDelta(alice, WS, { since, known: [] }) as unknown as { tags?: unknown };
    expect(delta.tags).toBeUndefined();
  });

  it("which block events say a count moved, and which ask about the block's tags", () => {
    expect(blockEventTagUse("BLOCK_NODE_CREATED", { tag_ids: [] })).toEqual({ moved: false });
    expect(blockEventTagUse("BLOCK_NODE_CREATED", { tag_ids: ["t"] })).toEqual({ moved: true });
    expect(blockEventTagUse("BLOCK_NODE_UPDATED", { before: { tag_ids: ["a"] }, after: { tag_ids: ["a"] } })).toEqual({ moved: false });
    expect(blockEventTagUse("BLOCK_NODE_UPDATED", { before: { tag_ids: ["a"] }, after: { tag_ids: ["a", "b"] } })).toEqual({ moved: true });
    expect(blockEventTagUse("BLOCK_NODE_UPDATED", { block_node_id: "b1", reattached: true, before: { tag_ids: ["a"] }, after: { tag_ids: ["a"] } })).toEqual({ moved: false, check: "b1" });
    expect(blockEventTagUse("BLOCK_NODE_REMOVED", { block_node_id: "b1", kept: true })).toEqual({ moved: false, check: "b1" });
    expect(blockEventTagUse("BLOCK_NODE_RESTORED", { block_node_id: "b2", before: { tag_ids: ["a"] }, after: { tag_ids: ["a"] } })).toEqual({ moved: false, check: "b2" });
    expect(blockEventTagUse("NODE_UPDATED", {})).toEqual({ moved: false });
    expect(blockEventTagUse("SPACE_MEMBER_SET", {})).toEqual({ moved: true });
  });
});
