// A backup made before migration 201 (the ids of the capture tag and the spaces were random then) restores after it, and the backup
// now also carries function_refs (extras.json `functionRefs`), which a workspace move writes into the new workspace; an extras file made
// before this existed still reads.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { derivedIdName } from "@onden/markdown";
import { pool, q, getWorkspaceId } from "../db.js";

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import { collectExtras, importExtras, parseExtras } from "../services/backupExtras.js";
import { derivedId } from "../services/derivedIds.js";
import type { ActorCtx } from "../types.js";
import { applyAndWait } from "./helpers/restoreJob.js";
import { persistActor } from "./helpers/persistActor.js";
import { rerunMigration } from "./helpers/rerunMigration.js";
import { seedQ } from "./helpers/seedQ.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { zipEntries } from "./helpers/zipEntries.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();

describe.skipIf(!isTestDatabase())("backups and the derived ids", () => {
  const tag = randomUUID().slice(0, 8);
  let ws = "";
  let solo!: ActorCtx;
  let spaceA = ""; let spaceB = "";
  const oldCapture = randomUUID();
  const holderTag = randomUUID();
  let zip!: Buffer;

  const app = () => {
    const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
    hono.onError(apiOnError);
    hono.use("*", async (c, next) => { c.set("actor", solo); await next(); });
    hono.route("/api/backup", backupRouter);
    return hono;
  };
  const tags = (workspace: string) => q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND deleted_at IS NULL AND tag_schema->>'module' = 'capture'`, [workspace]);

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Derived backup', $1) RETURNING id::text`, [`derived-backup-${tag}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    solo = await persistActor(ws, { id: "", name: `Solo ${tag}`, type: "human", role: "editor" });
    await setWorkspaceOwner(ws, solo.id);
    spaceA = await makeSpace(ws, `A ${tag}`, [{ id: solo.id, permission: "edit" }]);
    spaceB = await makeSpace(ws, `B ${tag}`, [{ id: solo.id, permission: "edit" }]);
    // as an older server left them: the capture tag under a random id, a note on it, and function references that name it
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, tag_schema, space_id) VALUES ($1, $2, 'manual', 'class_tag', $3, $4, '', $5::jsonb, $6)`,
      [oldCapture, ws, `收件匣${tag}`, `module-${oldCapture}`, JSON.stringify({ module: "capture" }), spaceA]);
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id) VALUES ($1, $2, 'manual', 'class_tag', $3, $4, '', $5)`,
      [holderTag, ws, `Holder ${tag}`, `holder-${tag}`, spaceA]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id, config) VALUES
                   ($1, 'probe', $2, $3::jsonb), ($1, 'tasks', $2, '{}'::jsonb)`, [ws, holderTag, JSON.stringify({ source_tag_id: oldCapture, keep: "yes" })]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, instance, holder_node_id, config) VALUES ($1, 'probe', 'view-1', $2, '{"name":"a view"}'::jsonb)`, [ws, holderTag]);
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_space_id, config) VALUES ($1, 'on_space', $2, '{"on": true}'::jsonb)`, [ws, spaceA]);
    zip = Buffer.from(await (await app().request("/api/backup/full.zip")).arrayBuffer());
  }, 60_000);
  afterAll(async () => { await pool.end(); });

  it("the archive carries the functions a tag or space provides, and not the ones another file of the archive already carries", () => {
    const extras = parseExtras(JSON.parse(zipEntries(zip).get(".onden/extras.json")?.toString("utf8") ?? "null"))!;
    expect(extras).not.toBeNull();
    const mine = extras.functionRefs.filter((r) => r.holder_node_id === holderTag || r.holder_space_id === spaceA);
    expect(mine.map((r) => r.function_id).sort()).toEqual(["on_space", "probe"]);
    expect(mine.find((r) => r.function_id === "probe")!.config).toEqual({ source_tag_id: oldCapture, keep: "yes" });
  });

  it("a backup made before the migration restores after it: one capture tag, under the derived id, and the restore finishes", async () => {
    await rerunMigration("201_derived_ids_function_ref_stamps");
    expect((await tags(ws)).rows.map((r) => r.id)).toEqual([derivedId(derivedIdName.moduleTag(ws, "capture"))]);
    const up = await app().request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    expect(up.status).toBe(200);
    const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
    const done = await applyAndWait(app(), uploadId, spaceB, "empty");
    expect(done.status, await done.clone().text()).toBe(200);
    expect((await tags(ws)).rows).toHaveLength(1);
  });

  it("a workspace move writes them into the new workspace, pointing at the tags and spaces that came across, once", async () => {
    const target = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Derived move', $1) RETURNING id::text`, [`derived-move-${tag}`])).rows[0]!.id;
    const owner = await persistActor(target, { id: "", name: `Mover ${tag}`, type: "human", role: "admin" });
    const holderIds = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2`, [ws, `Holder ${tag}`])).rows.map((r) => r.id);
    const sourceHolder = holderIds.find((id) => id === holderTag) ?? holderIds[0]!;
    // (the tests run in any order: the capture tag has its old id or its derived one, whichever the reference holds now)
    const sourceCapture = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND tag_schema->>'module' = 'capture' AND deleted_at IS NULL AND id IN ($2, $3)`,
      [ws, oldCapture, derivedId(derivedIdName.moduleTag(ws, "capture"))])).rows[0]!.id;
    const extras = await collectExtras(ws, solo.id, false, new Set([sourceHolder, sourceCapture]), [spaceA]);
    const here = (id: string) => (id === sourceHolder ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222");
    const newHolder = here(sourceHolder), newCapture = here(sourceCapture);
    const newSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [target])).rows[0]!.id;
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, $3, 'manual', 'class_tag', 'H', $4, ''), ($2, $3, 'manual', 'class_tag', 'C', $5, '')`,
      [newHolder, newCapture, target, `h-${tag}`, `c-${tag}`]);
    const ids = new Map([[sourceHolder, newHolder], [sourceCapture, newCapture]]);
    for (let round = 0; round < 2; round++) {
      await importExtras(target, owner, extras, ids, new Map([[spaceA, newSpace]]), false);
    }
    const written = (await q<{ function_id: string; holder_node_id: string | null; holder_space_id: string | null; config: Record<string, unknown> }>(
      `SELECT function_id, holder_node_id::text, holder_space_id::text, config FROM function_refs WHERE workspace_id = $1 ORDER BY function_id`, [target])).rows;
    expect(written.map((r) => r.function_id)).toEqual(["on_space", "probe"]);
    expect(written.find((r) => r.function_id === "probe")).toMatchObject({ holder_node_id: newHolder, config: { source_tag_id: newCapture, keep: "yes" } });
    expect(written.find((r) => r.function_id === "on_space")).toMatchObject({ holder_space_id: newSpace });
  });

  it("an extras file made before function references were carried still reads, and writes nothing for them", async () => {
    const old = parseExtras({ version: 1, review: [], focus: [], rss: [], prefs: [], moduleSettings: [], modules: null, site: null })!;
    expect(old.functionRefs).toEqual([]);
    const target = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Derived old', $1) RETURNING id::text`, [`derived-old-${tag}`])).rows[0]!.id;
    const owner = await persistActor(target, { id: "", name: `Old ${tag}`, type: "human", role: "admin" });
    await importExtras(target, owner, old, new Map(), new Map(), false);
    expect((await q(`SELECT 1 FROM function_refs WHERE workspace_id = $1`, [target])).rows).toHaveLength(0);
  });
});
