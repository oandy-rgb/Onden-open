// A backup made before a module was removed (read_later: migration 192, citations: 193) still holds its module tag: restoring it must
// finish, keep the notes on the tag, and leave an ordinary tag; whatever the retired module's settings cannot
// become is skipped and counted, never a failed restore.
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { rawZip } from "./helpers/rawZip.js";
import { applyAndWait } from "./helpers/restoreJob.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  return hono;
}

describe.skipIf(!isTestDatabase())("restoring a backup that still has a retired module's tag", () => {
  let ws = "";
  let owner: ActorCtx;

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Test', $1) RETURNING id::text`, [`backup-rl-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    owner = await persistActor(ws, { id: "", name: "Owner", type: "human", role: "editor" });
    await setWorkspaceOwner(ws, owner.id);
  });

  it.each([
    { retired: "read_later", title: "稍後讀" },
    { retired: "citations", title: "論文" },
  ])("restores the notes, keeps them on the tag, and does not bring $retired back", async ({ retired, title }) => {
    const space = await makeSpace(ws, `restore target ${retired}`, [{ id: owner.id, permission: "edit" }]); // "empty" mode needs an empty space
    const now = new Date().toISOString();
    const tagId = randomUUID();
    const noteId = randomUUID();
    const base = { slug: null, parent_id: null, space_id: null, hidden: false, sort_order: 0, source_type: "manual", created_at: now, updated_at: now, deleted_at: null, attributes: [], file: null, media: [] };
    const tag = {
      ...base, id: tagId, node_type: "class_tag", title, markdown: "", tags: [],
      tag: {
        path: title, color: null, views: null, reserved_key: null,
        schema: { name: title, slug: "module-x", module: retired, publish_collection: false, fields: [], behaviour: { modules: { [retired]: { enabled: true } } } },
      },
    };
    const note = { ...base, id: noteId, node_type: "content", title: `An article ${retired}`, markdown: "worth reading\n", tags: [tagId] };
    const zip = rawZip([
      { name: `.onden/notes/${tagId}.json`, data: JSON.stringify(tag), deflate: true },
      { name: `.onden/notes/${noteId}.json`, data: JSON.stringify(note), deflate: true },
      { name: ".onden/manifest.json", data: JSON.stringify({ format: "onden-backup", version: 1, created_at: now, counts: {} }) },
    ]);
    const uploadRes = await app(owner).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    expect(uploadRes.status, await uploadRes.clone().text()).toBe(200);
    const uploadId = ((await uploadRes.json()) as { upload_id: string }).upload_id;

    const res = await applyAndWait(app(owner), uploadId, space, "empty");
    expect(res.status, await res.clone().text()).toBe(200);
    const report = await res.json() as { skipped?: Record<string, number> };

    const restored = (await q<{ id: string; tag_schema: Record<string, unknown> | null }>(
      `SELECT id::text, tag_schema FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND title = $2 AND deleted_at IS NULL`, [ws, title])).rows;
    expect(restored).toHaveLength(1);
    expect((await q(`SELECT 1 FROM node_tags nt JOIN content_nodes n ON n.id = nt.node_id WHERE nt.tag_id = $1 AND n.title = $2`, [restored[0]!.id, `An article ${retired}`])).rowCount).toBe(1);
    expect(restored[0]!.tag_schema?.module).not.toBe(retired);
    expect(JSON.stringify(restored[0]!.tag_schema ?? {})).not.toContain(retired);
    expect(typeof (report.skipped?.tag_settings ?? 0)).toBe("number");
  });
});
