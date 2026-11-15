// A note's 手寫 tab and its strokes through a backup and a restore into a new workspace: the tab comes back as a
// stored view of the restored note and the strokes as its attribute `note_ink` (services/backupRestore.ts
// handwritingTabOf). Same harness as boardBackupSections.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { encodeInk, type InkDocument } from "@onden/markdown/ink";
import { q } from "../db.js";

let current = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => current }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import nodesRouter from "../routes/nodes.js";
import type { RestoreJob } from "@onden/contract";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { waitForJob } from "./helpers/restoreJob.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  hono.route("/api/nodes", nodesRouter);
  return hono;
}
const send = (a: ActorCtx, url: string, method: string, body: unknown = {}) =>
  app(a).request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function newWorkspace(name: string) {
  const ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id::text`, [name, `${name}-${randomUUID()}`])).rows[0]!.id;
  current = ws;
  const owner = await persistActor(ws, { id: "", name: `Owner of ${name}`, type: "human", role: "editor" });
  await setWorkspaceOwner(ws, owner.id);
  const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [owner.id])).rows[0]!.id;
  return { ws, owner, personal };
}

const drawing = encodeInk({ version: 1, erased: {}, page: { width: 1000 },
  strokes: [{ id: "back-1", points: [[0, 0], [5, 5]], color: "#112233", size: 2, toolId: "pen" }] } as InkDocument);

describe.skipIf(!isTestDatabase())("a note's 手寫 tab through backup and restore", () => {
  it("comes back with its tab, its strokes and its text", async () => {
    const source = await newWorkspace("hw-src");
    current = source.ws;
    const title = `Lecture ${randomUUID()}`;
    const id = ((await (await send(source.owner, "/api/nodes", "POST", { title, markdown: "typed words\n" })).json()) as { id: string }).id;
    expect((await send(source.owner, `/api/nodes/${id}/views`, "POST", { name: "Handwriting", layout: "handwriting" })).status).toBe(201);
    expect((await send(source.owner, `/api/nodes/${id}/attributes/note_ink`, "PUT", { value: drawing, value_type: "text" })).status).toBeLessThan(300);
    const zip = Buffer.from(await (await app(source.owner).request("/api/backup/full.zip")).arrayBuffer());

    const target = await newWorkspace("hw-dst");
    const up = await app(target.owner).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
    const started = await send(target.owner, `/api/backup/restore/${uploadId}/apply`, "POST", { space_id: target.personal, mode: "workspace" });
    const job = await waitForJob(app(target.owner), ((await started.json()) as { job: RestoreJob }).job);
    expect(job.status, JSON.stringify(job)).toBe("done");

    current = target.ws;
    const restored = (await q<{ id: string; markdown: string }>(`SELECT id::text, markdown FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL`, [target.ws, title])).rows[0]!;
    expect(restored.markdown).toContain("typed words");
    const views = ((await (await app(target.owner).request(`/api/nodes/${restored.id}/views`)).json()) as { views: Array<{ layout: string; name: string }> }).views;
    expect(views).toEqual([expect.objectContaining({ layout: "handwriting", name: "Handwriting" })]);
    const ink = (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'note_ink'`, [restored.id])).rows[0]?.value ?? "";
    expect(ink).toContain("back-1");
  });
});
