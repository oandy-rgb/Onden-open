// A PDF note with many strokes survives a backup and a restore: the whole drawing comes back byte for byte (the chunks of
// its history are not in a backup, the current value is), and the restored note keeps saving: its next stroke is stored
// as chunks of the NEW note.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import { createNote } from "../services/noteCreate.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { INK_CHUNK_THRESHOLD } from "../services/inkChunks.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { applyAndWait } from "./helpers/restoreJob.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { pdfInkSim } from "./helpers/pdfInkEnvelope.js";

registerShippedModules();

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  return hono;
}

describe.skipIf(!isTestDatabase())("a PDF note with many strokes through a backup", () => {
  it("restores the drawing exactly and the restored note keeps saving", async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('PdfInk', $1) RETURNING id::text`, [`pdf-ink-${randomUUID()}`])).rows[0]!.id;
    const ws = await getWorkspaceId();
    const solo = await persistActor(ws, { id: "", name: `Solo ${randomUUID().slice(0, 6)}`, type: "human", role: "editor" });
    await setWorkspaceOwner(ws, solo.id);
    const spaceA = await makeSpace(ws, "A", [{ id: solo.id, permission: "edit" }]);
    const spaceB = await makeSpace(ws, "B", [{ id: solo.id, permission: "edit" }]);
    const title = `Lecture ${randomUUID().slice(0, 6)}`;
    const note = (await createNote({ actor: solo, workspaceId: ws, title, markdown: "slides\n", spaceId: spaceA, event: { uiContext: "test.pdfInkBackup" } })).node.id as string;

    // Draw until the value is chunk-stored, then keep drawing: the history holds many chunked versions.
    const sim = pdfInkSim({ seed: 21 });
    let previous: string | null = null;
    for (let i = 0; i < 400 && (previous === null || previous.length < INK_CHUNK_THRESHOLD * 2); i++) {
      const next = sim.drawStroke();
      await setNodeAttribute({ workspaceId: ws, actor: solo, nodeId: note, attribute: { key: "ink_data", value: next, value_type: "text", ...(previous === null ? {} : { base_value: previous }) } });
      previous = next;
    }
    const drawn = previous!;
    expect(drawn.length).toBeGreaterThanOrEqual(INK_CHUNK_THRESHOLD * 2);
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM ink_manifests WHERE node_id = $1`, [note])).rows[0]!.n)).toBeGreaterThan(1);

    const backup = await app(solo).request("/api/backup/full.zip");
    expect(backup.status).toBe(200);
    const zip = Buffer.from(await backup.arrayBuffer());
    const up = await app(solo).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    expect(up.status, await up.clone().text()).toBe(200);
    const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
    const applied = await applyAndWait(app(solo), uploadId, spaceB, "empty");
    expect(applied.status, await applied.clone().text()).toBe(200);

    const copy = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE space_id = $1 AND title = $2 AND deleted_at IS NULL`, [spaceB, title])).rows[0]!.id;
    const restored = (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'ink_data'`, [copy])).rows[0]!.value;
    expect(restored).toBe(drawn);

    // The copy is its own note: its next stroke is a save of the restored drawing.
    const next = sim.drawStroke();
    const saved = await setNodeAttribute({ workspaceId: ws, actor: solo, nodeId: copy, attribute: { key: "ink_data", value: next, value_type: "text", base_value: restored } });
    expect(saved.value).toBe(next);
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM ink_manifests WHERE node_id = $1`, [copy])).rows[0]!.n)).toBeGreaterThan(0);
  }, 300_000);
});
