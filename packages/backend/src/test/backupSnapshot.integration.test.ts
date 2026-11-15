// The full backup reads the database in ONE snapshot and in a handful of
// statements, however many notes there are (services/backupArchive.ts):
//
//   * every read is inside one read-only REPEATABLE READ transaction, none after
//     it ends (the zip is compressed and its media read with no transaction open);
//   * a write that commits while the backup is being read is not in it, so no
//     note names a tag, an anchor or a link the backup itself does not hold
//     (needs a second connection: skipped on PGlite, see helpers/pgliteSkips.ts);
//   * the statements do not grow with the number of notes (before: five or more
//     queries per note);
//   * what each note's sidecar holds is what reading that note on its own gives.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { STORE } from "../git.js";
import { pool, q } from "../db.js";

// Counts every statement and tells whether it ran inside the read snapshot.
const probe = { statements: 0, snapshots: 0, insideSnapshot: false, afterSnapshot: 0, snapshotEnded: false };
vi.mock("../db.js", async (original) => {
  const real = await original<typeof import("../db.js")>();
  const count = () => { probe.statements++; if (probe.snapshotEnded) probe.afterSnapshot++; };
  return {
    ...real,
    q: (...args: Parameters<typeof real.q>) => { count(); return real.q(...args); },
    pool: new Proxy(real.pool, { get: (target, key, receiver) => (key === "query" ? (...args: unknown[]) => { count(); return (target.query as (...a: unknown[]) => unknown)(...args); } : Reflect.get(target, key, receiver)) }),
    withReadSnapshot: async (fn: () => Promise<unknown>) => {
      probe.snapshots++;
      probe.insideSnapshot = true;
      try { return await real.withReadSnapshot(fn); } finally { probe.insideSnapshot = false; probe.snapshotEnded = true; }
    },
  };
});

// Runs once the backup's note list is read: the point where a write on another
// connection used to leak into the rows read after it.
let afterIndex: (() => Promise<void>) | null = null;
vi.mock("../services/exportZip.js", async (original) => {
  const real = await original<typeof import("../services/exportZip.js")>();
  return {
    ...real,
    vaultIndex: async (...args: Parameters<typeof real.vaultIndex>) => {
      const index = await real.vaultIndex(...args);
      const hook = afterIndex;
      afterIndex = null;
      if (hook) await hook();
      return index;
    },
  };
});

import { buildFullBackup, type BackupNote } from "../services/backupArchive.js";
import { createNote } from "../services/noteCreate.js";
import { createTag } from "../services/tagHierarchy.js";
import { applyTagToNode } from "../services/tagMembershipWrites.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { freshWorkspace } from "./helpers/roundTripWorld.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";
import { zipEntries } from "./helpers/zipEntries.js";
import type { ActorCtx } from "../types.js";
import type { BackupManifest } from "@onden/contract";

registerShippedModules();

const enabled = isTestDatabase();

async function backup(actor: ActorCtx, ws: string): Promise<Map<string, Buffer>> {
  probe.statements = 0; probe.snapshots = 0; probe.afterSnapshot = 0; probe.snapshotEnded = false;
  const chunks: Buffer[] = [];
  for await (const chunk of await buildFullBackup(actor, ws)) chunks.push(chunk as Buffer);
  return zipEntries(Buffer.concat(chunks));
}

const sidecars = (zip: Map<string, Buffer>) => new Map([...zip]
  .filter(([name]) => name.startsWith(".onden/notes/"))
  .map(([, data]) => { const n = JSON.parse(data.toString("utf8")) as BackupNote; return [n.id, n] as const; }));

/** `count` notes, each with the kinds of rows a sidecar carries beyond the note: a tag, a typed link, a `[[link]]`, a
 *  board card, a paragraph anchor and a link bound to it. The tags are the same few for any `count`. */
async function seedWorld(ws: string, actor: ActorCtx, count: number): Promise<{ ids: string[]; tags: string[] }> {
  const tags = [await createTag({ actor, workspaceId: ws, name: `alpha-${randomUUID().slice(0, 6)}` }), await createTag({ actor, workspaceId: ws, name: `beta-${randomUUID().slice(0, 6)}` })];
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const body = `Paragraph of note ${i}.\n`;
    ids.push(String((await createNote({ actor, workspaceId: ws, title: `Note ${String(i).padStart(3, "0")}`, markdown: body, event: { uiContext: "test.backupSnapshot" } })).node.id));
  }
  for (const [i, id] of ids.entries()) {
    await applyTagToNode({ workspaceId: ws, actor, nodeId: id, tagId: tags[i % 2]!.id });
    await seedQ(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) VALUES ($1,$2,$3,'related','active','manual')`, [ws, id, ids[(i + 1) % ids.length]]);
    await seedQ(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) VALUES ($1,$2,$3,'knowledge_link','active','wikilink')`, [ws, id, ids[(i + 2) % ids.length]]);
    await seedQ(`INSERT INTO node_positions (workspace_id, node_id, surface, x, y, width, height, folded) VALUES ($1,$2,'graph',$3,$4,NULL,NULL,false)`, [ws, id, i, i * 2]);
    await seedQ(
      `INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote) VALUES ($1,$2,$3,0,10,'h',$4)`,
      [ws, `a${i}x${randomUUID().slice(0, 5)}`, id, "Paragraph"],
    );
    const anchor = (await q<{ anchor_id: string }>(`SELECT anchor_id FROM block_anchors WHERE note_id = $1`, [id])).rows[0]!.anchor_id;
    await seedQ(`INSERT INTO block_link_bindings (workspace_id, note_id, link_text, anchor_id) VALUES ($1,$2,$3,$4)`, [ws, id, `Note/${i}`, anchor]);
  }
  return { ids, tags: tags.map((t) => t.id) };
}

describe.skipIf(!enabled)("the full backup reads one snapshot, in few statements", () => {
  let ws = "";
  let actor: ActorCtx;
  beforeAll(async () => { ({ ws, actor } = await freshWorkspace("backup-snapshot")); });

  it("reads inside one read snapshot and touches the database no more once it is over", async () => {
    await seedWorld(ws, actor, 6);
    const scratch = () => { try { return readdirSync(join(STORE, "backup-scratch")).length; } catch { return 0; } };
    const leftBefore = scratch();
    const zip = await backup(actor, ws);
    expect(zip.has(".onden/manifest.json")).toBe(true);
    // The entries waited in a scratch folder (not in memory); it is gone once the zip is read.
    await vi.waitFor(() => expect(scratch()).toBe(leftBefore));
    expect(probe.snapshots).toBe(1);
    expect(probe.statements).toBeGreaterThan(5);
    // The zip is compressed and the media read after the snapshot: no statement then.
    expect(probe.afterSnapshot).toBe(0);
  });

  it("drops the scratch folder a crashed backup left, and keeps one that may still be running", async () => {
    const root = join(STORE, "backup-scratch");
    const old = join(root, `old-${randomUUID()}`), fresh = join(root, `fresh-${randomUUID()}`);
    mkdirSync(old, { recursive: true }); mkdirSync(fresh, { recursive: true });
    const daysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    utimesSync(old, daysAgo, daysAgo);
    await backup(actor, ws);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("uses as many statements for forty notes as for ten", async () => {
    const small = await freshWorkspace("backup-count-small");
    const large = await freshWorkspace("backup-count-large");
    await seedWorld(small.ws, small.actor, 10);
    await seedWorld(large.ws, large.actor, 40);
    await backup(small.actor, small.ws); // the first run loads modules and caches
    await backup(small.actor, small.ws);
    const ten = probe.statements;
    await backup(large.actor, large.ws);
    expect(probe.statements).toBe(ten);
  }, 120_000);

  it("holds for each note what reading that note on its own gives", async () => {
    const world = await freshWorkspace("backup-reference");
    const { ids } = await seedWorld(world.ws, world.actor, 8);
    const notes = sidecars(await backup(world.actor, world.ws));
    const inBackup = new Set(notes.keys());
    for (const id of ids) {
      const note = notes.get(id)!;
      const edges = (await q<{ id: string; target_node_id: string; edge_type: string; status: string }>(
        `SELECT id::text, target_node_id::text, edge_type, status FROM node_edges WHERE workspace_id = $1 AND source_node_id = $2 AND origin = 'manual' ORDER BY created_at, id`, [world.ws, id])).rows;
      const positions = (await q<Record<string, unknown>>(
        `SELECT surface, x, y, width, height, color, folded, sub_canvas_id::text FROM node_positions WHERE workspace_id = $1 AND node_id = $2 ORDER BY surface`, [world.ws, id])).rows;
      const wikilinks = (await q<{ target_node_id: string }>(
        `SELECT target_node_id::text FROM node_edges WHERE workspace_id = $1 AND source_node_id = $2 AND origin = 'wikilink' ORDER BY created_at, id`, [world.ws, id])).rows.map((r) => r.target_node_id);
      const anchors = (await q<{ anchor_id: string; from_utf16: number; to_utf16: number }>(
        `SELECT anchor_id, from_utf16, to_utf16 FROM block_anchors WHERE workspace_id = $1 AND note_id = $2 AND status = 'valid' ORDER BY from_utf16`, [world.ws, id])).rows
        .map((a) => ({ id: a.anchor_id, from: a.from_utf16, to: a.to_utf16 }));
      const bindings = (await q<{ link_text: string; anchor_id: string }>(
        `SELECT link_text, anchor_id FROM block_link_bindings WHERE workspace_id = $1 AND note_id = $2 ORDER BY link_text`, [world.ws, id])).rows
        .map((b) => ({ text: b.link_text, anchor: b.anchor_id }));
      expect(note.edges, `edges of ${id}`).toEqual(edges.filter((e) => inBackup.has(e.target_node_id)));
      expect(note.positions, `positions of ${id}`).toEqual(positions);
      expect(note.wikilinks, `wikilinks of ${id}`).toEqual(wikilinks.filter((t) => inBackup.has(t)));
      expect(note.anchors, `anchors of ${id}`).toEqual(anchors);
      expect(note.link_bindings, `bindings of ${id}`).toEqual(bindings);
    }
  });

  // The rows a writer commits between the backup's first and later reads: a new tag on a note, a longer body with
  // its anchor, a note deleted for good that others link to. Read one statement at a time, the backup held a note
  // whose tag, anchor or link the backup did not.
  it.skipIf(needsSecondConnection)("is the state of one moment: a write made while it runs is not in it, and it agrees with itself", async () => {
    const world = await freshWorkspace("backup-consistency");
    const { ids } = await seedWorld(world.ws, world.actor, 6);
    const [edited, linkedTo] = [ids[0]!, ids[3]!];
    const before = sidecars(await backup(world.actor, world.ws)).get(edited)!;
    let newTag = "";
    afterIndex = async () => {
      newTag = (await pool.query<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1,'manual','class_tag','late tag',$2,'') RETURNING id::text`,
        [world.ws, `late-tag-${randomUUID()}`])).rows[0]!.id;
      await pool.query(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [edited, newTag]);
      const longer = `${before.markdown}A paragraph written during the backup.\n`;
      await pool.query(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [edited, longer]);
      await pool.query(
        `INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote) VALUES ($1,$2,$3,$4,$5,'h','A paragraph')`,
        [world.ws, `late${randomUUID().slice(0, 6)}`, edited, before.markdown.length, longer.length]);
      await pool.query(`DELETE FROM content_nodes WHERE id = $1`, [linkedTo]);
    };
    const zip = await backup(world.actor, world.ws);
    expect(afterIndex).toBeNull();
    const notes = sidecars(zip);
    const note = notes.get(edited)!;
    // Not in it: the moment is the one the note list was read at.
    expect(note.markdown).toBe(before.markdown);
    expect(note.tags).not.toContain(newTag);
    expect(notes.has(newTag)).toBe(false);
    expect(notes.has(linkedTo)).toBe(true);
    // And it agrees with itself, whatever the moment was.
    for (const n of notes.values()) {
      for (const t of n.tags) expect(notes.has(t), `tag ${t} of ${n.title}`).toBe(true);
      for (const a of n.anchors ?? []) expect(a.to, `anchor ${a.id} of ${n.title}`).toBeLessThanOrEqual(n.markdown.length);
      for (const e of n.edges ?? []) expect(notes.has(e.target_node_id)).toBe(true);
      for (const w of n.wikilinks ?? []) expect(notes.has(w)).toBe(true);
    }
    const manifest = JSON.parse(zip.get(".onden/manifest.json")!.toString("utf8")) as BackupManifest;
    expect(manifest.counts.notes + manifest.counts.tags + manifest.counts.deleted_notes + manifest.counts.tasks + manifest.counts.canvases).toBe(notes.size);
  }, 120_000);
});
