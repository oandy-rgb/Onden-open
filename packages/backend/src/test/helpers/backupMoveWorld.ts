// Two workspaces in one database and a backup moved from one into the other with its history (services/backupRestore.ts mode "workspace"),
// as noteVersionsPaths and historyReadersPaths do. The test file mocks getWorkspaceId with workspaceSwitch (vi.mock in the file itself).
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { expect } from "vitest";
import type { RestoreJob } from "@onden/contract";
import { q } from "../../db.js";
import { apiOnError } from "../../httpError.js";
import backupRouter from "../../routes/backup.js";
import type { ActorCtx } from "../../types.js";
import { waitForJob } from "./restoreJob.js";
import { makeCaller } from "./stampedWorld.js";
import { persistActor } from "./persistActor.js";
import { setWorkspaceOwner } from "./setOwner.js";
import { publishDefaultSpace } from "./spaceFixtures.js";
import { workspaceSwitch } from "./workspaceSwitch.js";

export type Place = { ws: string; owner: ActorCtx; personal: string; call: ReturnType<typeof makeCaller> };
export async function place(name: string): Promise<Place> {
  const ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id::text`, [name, `${name}-${randomUUID()}`])).rows[0]!.id;
  await publishDefaultSpace(ws);
  workspaceSwitch.ws = ws;
  const owner = await persistActor(ws, { id: "", name: `Owner of ${name}`, type: "human", role: "editor" });
  await setWorkspaceOwner(ws, owner.id);
  const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [owner.id])).rows[0]!.id;
  return { ws, owner, personal, call: makeCaller(owner) };
}

/** Move `zip` into the new workspace of `to` (mode "workspace": the only restore that carries history, services/backupRestore.ts). */
export async function moveInto(to: Place, zip: Buffer): Promise<RestoreJob> {
  workspaceSwitch.ws = to.ws;
  const app = new Hono<{ Variables: { actor: ActorCtx } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", to.owner); await next(); });
  app.route("/api/backup", backupRouter);
  const up = await app.request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
  expect(up.status).toBe(200);
  const { upload_id } = await up.json() as { upload_id: string };
  const started = await app.request(`/api/backup/restore/${upload_id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: to.personal, mode: "workspace" }) });
  expect([200, 202]).toContain(started.status);
  return waitForJob(app, ((await started.json()) as { job: RestoreJob }).job);
}

