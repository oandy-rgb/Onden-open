// The full backup a person downloads (GET /api/backup/full.zip,
// services/backupArchive.ts): a Markdown vault plus the .onden/ sidecar,
// bounded by what the downloader may read, streamed with bounded memory.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { q, getWorkspaceId } from "../db.js";

// A workspace of its own: a backup or export reads the whole workspace, so in
// the shared default workspace its cost would grow with every other test's
// notes (on a reused DB the export query alone took 1–2 s).
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import { buildFullBackup, type BackupNote, type BackupSpace } from "../services/backupArchive.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import { storeMedia } from "../services/media.js";
import { createNote } from "../services/noteCreate.js";
import { trashNode } from "../services/nodeTrash.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { createTag } from "../services/tagHierarchy.js";
import { applyTagToNode } from "../services/tagMembershipWrites.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { zipEntries } from "./helpers/zipEntries.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";
import type { BackupManifest } from "@onden/contract";

registerShippedModules();

const enabled = isTestDatabase();
const TEXT_BOXES = JSON.stringify({ v: 1, pages: { "pdf:1": { boxes: [{ id: "b1", x: 1, y: 2, w: 300, text: "字 😀", size: 22, color: "#15130d", align: "left", updated_at: "" }] } } });

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  return hono;
}

async function download(actor: ActorCtx): Promise<Map<string, Buffer>> {
  const res = await app(actor).request("/api/backup/full.zip");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toMatch(/onden-backup-\d{8}\.zip/);
  return zipEntries(Buffer.from(await res.arrayBuffer()));
}

const sidecars = (zip: Map<string, Buffer>) => new Map([...zip]
  .filter(([name]) => name.startsWith(".onden/notes/"))
  .map(([, data]) => { const n = JSON.parse(data.toString("utf8")) as BackupNote; return [n.id, n] as const; }));

describe.skipIf(!enabled)("full backup download", () => {
  let ws: string;
  const stamp = randomUUID().slice(0, 8);
  let owner: ActorCtx;
  let editor: ActorCtx;
  const ids: Record<string, string> = {};
  let image = "";
  let privateSpace = "";

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Test', $1) RETURNING id::text`, [`backup-dl-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    owner = await persistActor(ws, { id: "", name: `Owner ${stamp}`, type: "human", role: "admin" });
    editor = await persistActor(ws, { id: "", name: `Editor ${stamp}`, type: "human", role: "editor" });
    // A team space of their own stands in for 共用: out of the default space,
    // their backups hold this test's notes and not every other test's in the
    // shared database (whose size would otherwise set the cost of each run).
    const defaultSpace = await makeSpace(ws, `Team ${stamp}`, [{ id: owner.id, permission: "edit" }, { id: editor.id, permission: "edit" }]);
    await q(`DELETE FROM space_members m USING spaces s WHERE s.id = m.space_id AND s.workspace_id = $1 AND s.is_default AND m.actor_id = ANY($2::uuid[])`, [ws, [owner.id, editor.id]]);
    privateSpace = await makeSpace(ws, `Owner only ${stamp}`, [{ id: owner.id, permission: "edit" }]);
    const stored = await storeMedia(Buffer.from(`%PDF-1.4 ${stamp}`), ".pdf", { actor: owner, workspaceId: ws, origin: "upload" });
    if (!stored.ok) throw new Error(stored.reason);
    image = stored.filename;
    const note = async (name: string, markdown: string, spaceId: string, parentId: string | null = null) => {
      ids[name] = String((await createNote({ actor: owner, workspaceId: ws, title: `${name} ${stamp}`, markdown, spaceId, parentId, event: { uiContext: "test.backup" } })).node.id);
    };
    await note("Shared", `Shared with a [file](/api/media/${image}).\n`, defaultSpace);
    await note("Child", "Under shared.\n", defaultSpace, ids.Shared);
    await note("Secret", "Owner only.\n", privateSpace);
    await note("Gone", "Deleted, still in History.\n", defaultSpace);
    await note("Typed", "A page with only text boxes on it.\n", defaultSpace);
    await setNodeAttribute({ workspaceId: ws, actor: owner, nodeId: ids.Typed!, attribute: { key: "page_text", value: TEXT_BOXES } });
    await trashNode(owner, ws, ids.Gone!);
    await setNodeAttribute({ workspaceId: ws, actor: owner, nodeId: ids.Shared!, attribute: { key: "ink_data", value: `{"v":1,"strokes":["${stamp}"]}` } });
    await setNodeAttribute({ workspaceId: ws, actor: owner, nodeId: ids.Shared!, attribute: { key: "rating", value: "4" } });
    const tag = await createTag({ actor: owner, workspaceId: ws, name: `topic${stamp}` });
    ids.tag = tag.id;
    await applyTagToNode({ workspaceId: ws, actor: owner, nodeId: ids.Shared!, tagId: tag.id });
  });

  it("holds the vault, the sidecar, the attachments, deleted notes, spaces and a manifest", async () => {
    const zip = await download(owner);
    const notes = sidecars(zip);
    const shared = notes.get(ids.Shared!)!;
    expect(shared.markdown).toContain(`/api/media/${image}`);
    expect(shared.tags).toEqual([ids.tag]);
    expect(shared.attributes).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "ink_data", value: `{"v":1,"strokes":["${stamp}"]}` }),
      expect.objectContaining({ key: "rating", value: "4" }),
    ]));
    expect(shared.media).toEqual([image]);
    expect(zip.get(`attachments/${image}`)).toEqual(readFileSync(join(MEDIA_DIR, image)));
    // The vault half: a plain Markdown file with frontmatter and the
    // attachment link rewritten.
    const md = zip.get(shared.file!)!.toString("utf8");
    expect(md).toContain(`title: Shared ${stamp}`);
    expect(md).toContain(`./attachments/${image}`);
    expect(notes.get(ids.Child!)!.parent_id).toBe(ids.Shared);
    // Deleted: flagged in the sidecar, filed under .trash/.
    const gone = notes.get(ids.Gone!)!;
    expect(gone.deleted_at).not.toBeNull();
    expect(gone.file).toMatch(/^\.trash\//);
    expect(zip.has(gone.file!)).toBe(true);
    // A tag definition travels with its path.
    expect(notes.get(ids.tag!)!.tag).toEqual(expect.objectContaining({ path: `topic${stamp}` }));
    const spaces = JSON.parse(zip.get(".onden/spaces.json")!.toString("utf8")) as BackupSpace[];
    expect(spaces.find((s) => s.id === privateSpace)?.members).toEqual([expect.objectContaining({ id: owner.id, permission: "edit" })]);
    const manifest = JSON.parse(zip.get(".onden/manifest.json")!.toString("utf8")) as BackupManifest;
    expect(manifest).toEqual(expect.objectContaining({ format: "onden-backup", version: 2 }));
    expect(manifest.counts.deleted_notes).toBeGreaterThanOrEqual(1);
    // A page with only text boxes counts too (the note with a drawing and this one).
    expect(manifest.counts.drawings).toBeGreaterThanOrEqual(2);
    expect(notes.get(ids.Typed!)!.attributes).toEqual([expect.objectContaining({ key: "page_text", value: TEXT_BOXES })]);
    expect(manifest.counts.notes).toBe([...notes.values()].filter((n) => n.node_type === "content" && !n.deleted_at && !n.hidden).length);
    expect(zip.get("README.txt")!.toString("utf8")).toContain("不包含");
  });

  it("leaves the empty day notes the app makes by itself and the empty tag pages out of the Markdown, keeps the tags in .onden/", async () => {
    const day = async (title: string, markdown: string) => String((await createNote({ actor: owner, workspaceId: ws, title, markdown, event: { uiContext: "test.backup" } })).node.id);
    const emptyDay = await day("2031-03-04", "");
    const writtenDay = await day("2031-03-05", "今天寫了一點。\n");
    const taggedDay = await day("2031-03-06", "");
    await applyTagToNode({ workspaceId: ws, actor: owner, nodeId: taggedDay, tagId: ids.tag! });
    const zip = await download(owner);
    const notes = sidecars(zip);
    expect(notes.has(emptyDay)).toBe(false);
    expect([...zip.keys()].some((name) => name.endsWith("2031-03-04.md"))).toBe(false);
    // A day with text, or with a tag on it, is a note like any other.
    expect(notes.get(writtenDay)!.file).toMatch(/2031-03-05\.md$/);
    expect(notes.has(taggedDay)).toBe(true);
    // The tag definition is data: no `topic….md` file of its own, but the sidecar a restore reads is there.
    expect(notes.get(ids.tag!)!.file).toBeNull();
    expect([...zip.keys()].some((name) => /^[^.].*\.md$/.test(name) && name.includes(`topic${stamp}`))).toBe(false);
    expect(notes.get(ids.tag!)!.tag).toEqual(expect.objectContaining({ path: `topic${stamp}` }));
  });

  it("an editor's backup leaves out notes and spaces they cannot read", async () => {
    // A readable note on a canvas of a space the editor is not in, linked to
    // a note there: neither the canvas nor the note is named.
    const canvas = String((await createNote({ actor: owner, workspaceId: ws, title: `Board ${stamp}`, markdown: "", nodeType: "canvas", spaceId: privateSpace, event: { uiContext: "test.backup" } })).node.id);
    await q(`INSERT INTO node_positions (node_id, surface, x, y, sub_canvas_id, workspace_id) VALUES ($1, $2, 1, 2, $3, $4)`, [ids.Shared, canvas, canvas, ws]);
    await q(`INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, 'graph', 3, 4, $2)`, [ids.Shared, ws]);
    await seedQ(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) VALUES ($1, $2, $3, 'related', 'active', 'manual')`, [ws, ids.Shared, ids.Secret]);
    const zip = await download(editor);
    expect(sidecars(zip).get(ids.Shared!)!.positions).toEqual([expect.objectContaining({ surface: "graph" })]);
    expect([...zip.values()].some((data) => data.toString("utf8").includes(canvas))).toBe(false);
    const notes = sidecars(zip);
    expect(notes.has(ids.Shared!)).toBe(true);
    expect(notes.has(ids.Secret!)).toBe(false);
    expect([...zip.values()].some((data) => data.toString("utf8").includes(`Secret ${stamp}`))).toBe(false);
    const spaces = JSON.parse(zip.get(".onden/spaces.json")!.toString("utf8")) as BackupSpace[];
    expect(spaces.some((s) => s.id === privateSpace)).toBe(false);
    expect([...zip.values()].some((data) => data.toString("utf8").includes(ids.Secret!))).toBe(false);
    // Nor another member's personal space.
    expect(spaces.every((s) => s.kind !== "personal" || s.members.every((m) => m.id === editor.id))).toBe(true);
  });

  it("refuses a delegated token", async () => {
    const res = await app({ ...owner, tokenScope: { tokenId: "t", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null } }).request("/api/backup/full.zip");
    expect(res.status).toBe(403);
  });

  it("streams a large backup with bounded memory", async () => {
    // ~120 MB of drawings (ink_data, the big payload notes carry; the full
    // text index makes bulk bodies slow to seed): an archive built in memory
    // would hold all of it.
    // Big's alone: were the owner in it, the owner's backups in the other
    // tests would carry these 600 drawings whenever this test ran first.
    const big = await persistActor(ws, { id: "", name: `Big ${stamp}`, type: "human", role: "editor" });
    const space = await makeSpace(ws, `Big ${stamp}`, [{ id: big.id, permission: "edit" }]);
    await q(`DELETE FROM space_members WHERE actor_id = $1 AND space_id <> $2`, [big.id, space]);
    const count = 600;
    const ink = () => randomBytes(150 * 1024).toString("base64");
    for (let i = 0; i < count; i += 50) {
      const rows = Array.from({ length: Math.min(50, count - i) }, (_, k) => ({ id: randomUUID(), slug: `big-${stamp}-${i + k}`, ink: ink() }));
      await seedQ(`WITH r AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(id uuid, slug text, ink text)),
                    n AS (INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id)
                          SELECT r.id, $1, 'manual', 'content', r.slug, r.slug, 'drawing', $2::uuid FROM r)
               INSERT INTO node_attributes (workspace_id, node_id, key, value, source) SELECT $1, r.id, 'ink_data', r.ink, 'ui' FROM r`,
        [ws, space, JSON.stringify(rows)]);
    }
    const total = count * 200 * 1024;
    // Live memory, not garbage not yet collected: measure after a full GC.
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const live = () => { gc(); const m = process.memoryUsage(); return m.heapUsed + m.external; };
    const before = live();
    let peak = 0;
    let bytes = 0;
    let chunks = 0;
    const archive = await buildFullBackup(big, ws);
    for await (const chunk of archive) {
      bytes += (chunk as Buffer).length;
      if (++chunks % 100 === 0) peak = Math.max(peak, live() - before);
      // A slow reader: the producer must wait for it, not run ahead.
      await new Promise((resolve) => setImmediate(resolve));
    }
    // ~120 MB is too much to leave behind in the shared database.
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND space_id = $2`, [ws, space]);
    expect(bytes).toBeGreaterThan(total / 2);
    expect(peak).toBeLessThan(total / 2);
  }, 240_000);
});
