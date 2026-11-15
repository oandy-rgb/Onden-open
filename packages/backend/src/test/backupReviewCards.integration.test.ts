// A note that is a review card itself (its own review reference, migration 195) is written into a new backup and comes back a card;
// an old backup that made cards through the review module's tag still restores into cards, and the tag itself is not brought back.
// SAFETY: only runs against a *_test database; skips otherwise.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import nodesRouter from "../routes/nodes.js";
import reviewRouter from "../modules/review/routes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { rawZip } from "./helpers/rawZip.js";
import { zipEntries } from "./helpers/zipEntries.js";
import { applyAndWait } from "./helpers/restoreJob.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  hono.route("/api/nodes", nodesRouter);
  hono.route("/api/review", reviewRouter);
  return hono;
}
const send = (actor: ActorCtx, url: string, method: string, body?: unknown) =>
  app(actor).request(url, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe.skipIf(!isTestDatabase())("review cards in a backup", () => {
  let ws = "";
  let owner: ActorCtx;
  const stamp = randomUUID().slice(0, 6);

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Cards', $1) RETURNING id::text`, [`backup-cards-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    owner = await persistActor(ws, { id: "", name: "Owner", type: "human", role: "editor" });
    await setWorkspaceOwner(ws, owner.id);
  });

  const upload = async (zip: Buffer) => {
    const res = await app(owner).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { upload_id: string }).upload_id;
  };
  const isCard = async (title: string, spaceId: string) => (await q(
    `SELECT 1 FROM function_refs r JOIN content_nodes n ON n.id = r.holder_node_id
      WHERE n.workspace_id = $1 AND n.title = $2 AND n.space_id = $3 AND r.function_id = 'review'`, [ws, title, spaceId])).rowCount === 1;

  it("a new backup says which notes are cards, and a restore makes them cards again", async () => {
    const source = await makeSpace(ws, `cards source ${stamp}`, [{ id: owner.id, permission: "edit" }]);
    const target = await makeSpace(ws, `cards target ${stamp}`, [{ id: owner.id, permission: "edit" }]);
    const make = async (title: string) => {
      const res = await send(owner, "/api/nodes", "POST", { title, markdown: "內容\n", space_id: source });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const card = await make(`卡片筆記 ${stamp}`);
    await make(`普通筆記 ${stamp}`);
    expect((await send(owner, `/api/review/cards/${card}`, "PUT")).status).toBe(200);

    const zip = Buffer.from(await (await app(owner).request("/api/backup/full.zip")).arrayBuffer());
    const sidecar = (id: string) => JSON.parse(zipEntries(zip).get(`.onden/notes/${id}.json`)!.toString("utf8")) as { review_card?: true };
    expect(sidecar(card).review_card).toBe(true);
    const plain = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2`, [ws, `普通筆記 ${stamp}`])).rows[0]!.id;
    expect(sidecar(plain).review_card).toBeUndefined();

    const done = await applyAndWait(app(owner), await upload(zip), target, "empty");
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await isCard(`卡片筆記 ${stamp}`, target)).toBe(true);
    expect(await isCard(`普通筆記 ${stamp}`, target)).toBe(false);
  });

  it("an old backup (the review module's tag, and a tag extending it) restores its notes as cards, without the review tag", async () => {
    const target = await makeSpace(ws, `old cards ${stamp}`, [{ id: owner.id, permission: "edit" }]);
    const now = new Date().toISOString();
    const reviewTag = randomUUID(), extending = randomUUID(), cardNote = randomUUID(), extendedNote = randomUUID(), plainNote = randomUUID();
    const base = { slug: null, parent_id: null, space_id: null, hidden: false, sort_order: 0, source_type: "manual", created_at: now, updated_at: now, deleted_at: null, attributes: [], file: null, media: [] };
    const tag = (id: string, title: string, schema: Record<string, unknown>) => ({ ...base, id, node_type: "class_tag", title, markdown: "", tags: [],
      tag: { path: title, color: null, views: null, reserved_key: null, schema: { name: title, slug: `s-${id.slice(0, 6)}`, publish_collection: false, fields: [], ...schema } } });
    const note = (id: string, title: string, tags: string[]) => ({ ...base, id, node_type: "content", title, markdown: "內容\n", tags });
    const entries = [
      tag(reviewTag, "複習", { module: "review", behaviour: { modules: { review: { enabled: true } } } }),
      tag(extending, `課程 ${stamp}`, { extends: [reviewTag] }),
      note(cardNote, `舊卡 ${stamp}`, [reviewTag]), note(extendedNote, `延伸卡 ${stamp}`, [extending]), note(plainNote, `舊普通 ${stamp}`, []),
    ];
    const zip = rawZip([
      ...entries.map((entry) => ({ name: `.onden/notes/${entry.id}.json`, data: JSON.stringify(entry), deflate: true })),
      { name: ".onden/manifest.json", data: JSON.stringify({ format: "onden-backup", version: 1, created_at: now, counts: {} }) },
    ]);
    const done = await applyAndWait(app(owner), await upload(zip), target, "empty");
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await isCard(`舊卡 ${stamp}`, target)).toBe(true);
    expect(await isCard(`延伸卡 ${stamp}`, target)).toBe(true);
    expect(await isCard(`舊普通 ${stamp}`, target)).toBe(false);
    // The review module's tag is not brought back as a tag; the tag that extended it is an ordinary tag with the note still on it.
    expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND tag_schema->>'module' = 'review' AND title = '複習' AND id = $2`, [ws, reviewTag])).rowCount).toBe(0);
    expect((await q(`SELECT 1 FROM node_tags nt JOIN content_nodes t ON t.id = nt.tag_id JOIN content_nodes n ON n.id = nt.node_id WHERE t.title = $1 AND n.title = $2`, [`課程 ${stamp}`, `延伸卡 ${stamp}`])).rowCount).toBe(1);
  });
});
