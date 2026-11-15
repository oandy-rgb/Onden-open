// Pictures on a page (`page_images`, @onden/markdown/page-images): the attribute
// write path every other attribute takes, with the picture-by-picture merge of
// page_text. The same contract as the text boxes:
//   * one save = one ATTRIBUTE_SET event holding the value before it;
//   * two devices that each add or move a different picture both keep it;
//   * the same picture moved on both: the later save wins, the other version is an
//     ATTRIBUTE_CONFLICT the inbox can give back (and nothing else is lost);
//   * the event undoes through restoreEvent, reaches other devices' sync delta,
//     is in the full backup and stays out of a note's frontmatter;
//   * a client that has never heard of the key (an older release) leaves it be;
//   * the picture's file is claimed by the note that holds it, so the note's
//     readers can load it (services/mediaOwners.ts).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import syncRouter from "../routes/sync.js";
import eventsRouter from "../routes/events.js";
import { exportedNoteFile } from "../services/exportZip.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { decodePageImages, encodePageImages, type PageImage } from "@onden/markdown/page-images";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "page-images-admin", name: "Page images", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
app.route("/sync", syncRouter);
app.route("/events", eventsRouter);
const send = (url: string, method: string, body: unknown = {}) => app.request(url, {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

const SRC = "/api/media/0123456789abcdef0123456789abcdef.png";
const box = (id: string, over: Partial<PageImage> = {}): PageImage => ({
  id, x: 10, y: 20, w: 360, h: 240, src: SRC, alt: id, updated_at: "2026-10-28T00:00:00.000Z", ...over,
});
const doc = (...images: PageImage[]) => encodePageImages({ v: 1, pages: { page: { images } } });
const boxesOf = (raw: string) => decodePageImages(raw).pages.page?.images ?? [];

async function newNote(): Promise<string> {
  const res = await send("/nodes", "POST", { title: `typed ${randomUUID().slice(0, 8)}`, markdown: "x" });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
/** The PUT a device sends: its value, and the value it was made from ("" = none). */
async function save(nodeId: string, value: string, base?: string): Promise<{ value: string }> {
  const res = await send(`/nodes/${nodeId}/attributes/page_images`, "PUT", { value, value_type: "text", is_inheritable: false, ...(base !== undefined ? { base_value: base } : {}) });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json() as Promise<{ value: string }>;
}
const stored = async (nodeId: string) =>
  (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'page_images'`, [nodeId])).rows[0]?.value;
const events = async (nodeId: string, type: string) => (await q<{ id: string; payload: Record<string, unknown>; tx_meta: Record<string, unknown> }>(
  `SELECT id::text, payload, tx_meta FROM domain_events WHERE target_id = $1 AND event_type = $2 AND payload->>'key' = 'page_images' ORDER BY domain_events.id`, [nodeId, type])).rows;
const cursor = async () => Number((await q<{ c: string }>(`SELECT coalesce(max(id),0)::text AS c FROM domain_events WHERE workspace_id = $1`, [workspaceId])).rows[0]!.c);

describe.skipIf(!isTestDb)("pictures on a page (page_images)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Page images',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  it("each save is one ATTRIBUTE_SET that holds the value before it", async () => {
    const id = await newNote();
    const first = doc(box("a"));
    const second = doc(box("a"), box("b"));
    await save(id, first, "");
    await save(id, second, first);
    const sets = await events(id, "ATTRIBUTE_SET");
    expect(sets).toHaveLength(2);
    expect(sets[0]!.tx_meta).toMatchObject({ inverse_op: "attribute.deleted" });
    expect(sets[1]!.tx_meta).toMatchObject({ inverse_op: "attribute.set" });
    const before = sets[1]!.tx_meta.prev_field_values as { value?: string };
    expect(before.value).toBe(first);
    expect(await events(id, "ATTRIBUTE_CONFLICT")).toEqual([]);
  });

  it("two devices adding or moving different pictures both keep theirs", async () => {
    const id = await newNote();
    const base = doc(box("a"), box("b"));
    await save(id, base, "");
    await save(id, doc(box("a", { x: 111 }), box("b"), box("laptop")), base); // laptop
    const merged = await save(id, doc(box("a"), box("b", { x: 99 }), box("tablet")), base); // tablet, replayed from its queue
    expect(boxesOf(merged.value).map((b) => b.id).sort()).toEqual(["a", "b", "laptop", "tablet"]);
    const byId = new Map(boxesOf((await stored(id))!).map((b) => [b.id, b]));
    expect(byId.get("a")!.x).toBe(111);
    expect(byId.get("b")!.x).toBe(99);
    expect(await events(id, "ATTRIBUTE_CONFLICT")).toEqual([]);
  });

  it("the same picture moved on both: the later save wins and the other version is a conflict the inbox can give back", async () => {
    const id = await newNote();
    const base = doc(box("a"));
    await save(id, base, "");
    await save(id, doc(box("a", { x: 1 })), base);
    await save(id, doc(box("a", { x: 2 }), box("tablet-extra")), base);
    expect(boxesOf((await stored(id))!).find((b) => b.id === "a")!.x).toBe(2);
    const [conflict, ...more] = await events(id, "ATTRIBUTE_CONFLICT");
    expect(more).toEqual([]);
    expect(conflict!.payload.page_images_conflicts).toEqual([{ pageKey: "page", id: "a" }]);
    // The laptop adds one more picture meanwhile; reverting must keep it.
    const now = (await stored(id))!;
    await save(id, doc(...boxesOf(now), box("later")), now);
    const reverted = await send(`/events/${conflict!.id}/revert-conflict`, "POST");
    expect(reverted.status, await reverted.clone().text()).toBe(200);
    const after = new Map(boxesOf((await stored(id))!).map((b) => [b.id, b]));
    expect(after.get("a")!.x).toBe(1);
    expect([...after.keys()].sort()).toEqual(["a", "later", "tablet-extra"]);
  });

  it("removed on one device and moved on the other keeps the edit, and says so", async () => {
    const id = await newNote();
    const base = doc(box("a"), box("b"));
    await save(id, base, "");
    await save(id, doc(box("b")), base); // a removed
    await save(id, doc(box("a", { x: 500 }), box("b")), base);
    expect(boxesOf((await stored(id))!).map((b) => b.id).sort()).toEqual(["a", "b"]);
    expect((await events(id, "ATTRIBUTE_CONFLICT")).length).toBe(1);
  });

  it("a save without a base overwrites, like any attribute", async () => {
    const id = await newNote();
    await save(id, doc(box("a")));
    await save(id, doc(box("z")));
    expect(boxesOf((await stored(id))!).map((b) => b.id)).toEqual(["z"]);
  });

  it("the event undoes from history, as a new event, and only while nothing changed it since", async () => {
    const id = await newNote();
    const first = doc(box("a"));
    const second = doc(box("a"), box("b"));
    await save(id, first, "");
    await save(id, second, first);
    const [, latest] = await events(id, "ATTRIBUTE_SET");
    expect(await restoreEvent(latest!.id, { actor, workspaceId })).toMatchObject({ restored: true });
    expect(await stored(id)).toBe(first);
    expect((await events(id, "ATTRIBUTE_SET")).length).toBe(3); // the undo is its own event
    // The pictures change again: undoing the first save now would drop that edit, so it is refused.
    await save(id, doc(box("a"), box("c")), first);
    const [firstEvent] = await events(id, "ATTRIBUTE_SET");
    const refused = await restoreEvent(firstEvent!.id, { actor, workspaceId });
    expect(refused).toMatchObject({ code: "state_conflict" });
    expect(boxesOf((await stored(id))!).map((b) => b.id)).toEqual(["a", "c"]);
  });

  it("reaches another device's sync delta, and a client that only knows ink_data leaves it be", async () => {
    const id = await newNote();
    const since = await cursor();
    const value = doc(box("a", { alt: "字 😀" }));
    await save(id, value, "");
    const delta = (await (await app.request(`/sync?since=${since}`)).json()) as { attributes: { upsert: Array<{ node_id: string; key: string; value: string }> } };
    expect(delta.attributes.upsert).toContainEqual(expect.objectContaining({ node_id: id, key: "page_images", value }));
    // An older release saves the drawing and never mentions page_images.
    const ink = JSON.stringify({ version: 1, strokes: [], erased: {}, page: { width: 1000 } });
    expect((await send(`/nodes/${id}/attributes/ink_data`, "PUT", { value: ink, value_type: "text", is_inheritable: false })).status).toBe(200);
    expect(await stored(id)).toBe(value);
  });

  it("a stored picture's file is claimed by the note that holds it", async () => {
    const id = await newNote();
    // media_uploads.filename is unique across workspaces: a fresh name per run.
    const filename = `${crypto.randomUUID().replace(/-/g, "")}.png`;
    await q(`INSERT INTO media_uploads(workspace_id, filename, uploader_actor_id) VALUES ($1, $2, $3)`, [workspaceId, filename, actor.id]);
    await save(id, doc(box("a", { src: `/api/media/${filename}` })), "");
    const owner = (await q<{ node_id: string | null }>(`SELECT node_id::text FROM media_uploads WHERE workspace_id = $1 AND filename = $2`, [workspaceId, filename])).rows[0]!.node_id;
    expect(owner).toBe(id);
  });

  it("stays out of a note's frontmatter in the Markdown export", () => {
    const value = doc(box("a"));
    const file = exportedNoteFile(
      { id: "n1", title: "T", slug: null, tags: [], updated_at: "2026-10-28T00:00:00Z" } as never,
      [{ key: "page_images", value, source: "ui" }, { key: "stage", value: "draft", source: "ui" }], "body",
    );
    expect(file).not.toContain("page_images");
    expect(file).toContain("stage: draft");
  });
});
