// Text boxes on a page (`page_text`, @onden/markdown/page-text): the attribute
// write path every other attribute takes, with the box-by-box merge of ink_data.
//   * one save = one ATTRIBUTE_SET event holding the value before it;
//   * two devices that each add or edit a different box both keep it;
//   * the same box edited on both: the later save wins, the other version is an
//     ATTRIBUTE_CONFLICT the inbox can give back (and nothing else is lost);
//   * the event undoes through restoreEvent, reaches other devices' sync delta,
//     is in the full backup and stays out of a note's frontmatter;
//   * a client that has never heard of the key (an older release) leaves it be.
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
import { decodePageText, encodePageText, type PageTextBox } from "@onden/markdown/page-text";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "page-text-admin", name: "Page text", role: "admin", type: "human" };
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

const box = (id: string, over: Partial<PageTextBox> = {}): PageTextBox => ({
  id, x: 10, y: 20, w: 300, text: id, size: 22, color: "#15130d", align: "left", updated_at: "2026-10-28T00:00:00.000Z", ...over,
});
const doc = (...boxes: PageTextBox[]) => encodePageText({ v: 1, pages: { "pdf:1": { boxes } } });
const boxesOf = (raw: string) => decodePageText(raw).pages["pdf:1"]?.boxes ?? [];

async function newNote(): Promise<string> {
  const res = await send("/nodes", "POST", { title: `typed ${randomUUID().slice(0, 8)}`, markdown: "x" });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
/** The PUT a device sends: its value, and the value it was made from ("" = none). */
async function save(nodeId: string, value: string, base?: string): Promise<{ value: string }> {
  const res = await send(`/nodes/${nodeId}/attributes/page_text`, "PUT", { value, value_type: "text", is_inheritable: false, ...(base !== undefined ? { base_value: base } : {}) });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json() as Promise<{ value: string }>;
}
const stored = async (nodeId: string) =>
  (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'page_text'`, [nodeId])).rows[0]?.value;
const events = async (nodeId: string, type: string) => (await q<{ id: string; payload: Record<string, unknown>; tx_meta: Record<string, unknown> }>(
  `SELECT id::text, payload, tx_meta FROM domain_events WHERE target_id = $1 AND event_type = $2 AND payload->>'key' = 'page_text' ORDER BY domain_events.id`, [nodeId, type])).rows;
const cursor = async () => Number((await q<{ c: string }>(`SELECT coalesce(max(id),0)::text AS c FROM domain_events WHERE workspace_id = $1`, [workspaceId])).rows[0]!.c);

describe.skipIf(!isTestDb)("text boxes on a page (page_text)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Page text',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
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

  it("two devices adding or editing different boxes both keep theirs", async () => {
    const id = await newNote();
    const base = doc(box("a"), box("b"));
    await save(id, base, "");
    await save(id, doc(box("a", { text: "laptop edit" }), box("b"), box("laptop")), base); // laptop
    const merged = await save(id, doc(box("a"), box("b", { x: 99 }), box("tablet")), base); // tablet, replayed from its queue
    expect(boxesOf(merged.value).map((b) => b.id).sort()).toEqual(["a", "b", "laptop", "tablet"]);
    const byId = new Map(boxesOf((await stored(id))!).map((b) => [b.id, b]));
    expect(byId.get("a")!.text).toBe("laptop edit");
    expect(byId.get("b")!.x).toBe(99);
    expect(await events(id, "ATTRIBUTE_CONFLICT")).toEqual([]);
  });

  it("the same box edited on both: the later save wins and the other version is a conflict the inbox can give back", async () => {
    const id = await newNote();
    const base = doc(box("a"));
    await save(id, base, "");
    await save(id, doc(box("a", { text: "from the laptop" })), base);
    await save(id, doc(box("a", { text: "from the tablet" }), box("tablet-extra")), base);
    expect(boxesOf((await stored(id))!).find((b) => b.id === "a")!.text).toBe("from the tablet");
    const [conflict, ...more] = await events(id, "ATTRIBUTE_CONFLICT");
    expect(more).toEqual([]);
    expect(conflict!.payload.page_text_conflicts).toEqual([{ pageKey: "pdf:1", id: "a" }]);
    // The laptop draws one more box meanwhile; reverting must keep it.
    const now = (await stored(id))!;
    await save(id, doc(...boxesOf(now), box("later")), now);
    const reverted = await send(`/events/${conflict!.id}/revert-conflict`, "POST");
    expect(reverted.status, await reverted.clone().text()).toBe(200);
    const after = new Map(boxesOf((await stored(id))!).map((b) => [b.id, b]));
    expect(after.get("a")!.text).toBe("from the laptop");
    expect([...after.keys()].sort()).toEqual(["a", "later", "tablet-extra"]);
  });

  it("removed on one device and edited on the other keeps the edit, and says so", async () => {
    const id = await newNote();
    const base = doc(box("a"), box("b"));
    await save(id, base, "");
    await save(id, doc(box("b")), base); // a removed
    await save(id, doc(box("a", { text: "still wanted" }), box("b")), base);
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
    // The text changes again: undoing the first save now would drop that edit, so it is refused.
    await save(id, doc(box("a"), box("c")), first);
    const [firstEvent] = await events(id, "ATTRIBUTE_SET");
    const refused = await restoreEvent(firstEvent!.id, { actor, workspaceId });
    expect(refused).toMatchObject({ code: "state_conflict" });
    expect(boxesOf((await stored(id))!).map((b) => b.id)).toEqual(["a", "c"]);
  });

  it("reaches another device's sync delta, and a client that only knows ink_data leaves it be", async () => {
    const id = await newNote();
    const since = await cursor();
    const value = doc(box("a", { text: "字 😀" }));
    await save(id, value, "");
    const delta = (await (await app.request(`/sync?since=${since}`)).json()) as { attributes: { upsert: Array<{ node_id: string; key: string; value: string }> } };
    expect(delta.attributes.upsert).toContainEqual(expect.objectContaining({ node_id: id, key: "page_text", value }));
    // An older release saves the drawing and never mentions page_text.
    const ink = JSON.stringify({ version: 1, strokes: [], erased: {}, page: { width: 1000 } });
    expect((await send(`/nodes/${id}/attributes/ink_data`, "PUT", { value: ink, value_type: "text", is_inheritable: false })).status).toBe(200);
    expect(await stored(id)).toBe(value);
  });

  it("stays out of a note's frontmatter in the Markdown export", () => {
    const value = doc(box("a"));
    const file = exportedNoteFile(
      { id: "n1", title: "T", slug: null, tags: [], updated_at: "2026-10-28T00:00:00Z" } as never,
      [{ key: "page_text", value, source: "ui" }, { key: "stage", value: "draft", source: "ui" }], "body",
    );
    expect(file).not.toContain("page_text");
    expect(file).toContain("stage: draft");
  });
});
