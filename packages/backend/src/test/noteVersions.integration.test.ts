// A note's versions as local writes mint them (migration 220, spine/noteVersions.ts; docs/architecture/proposals/history-replication-2026-11-22.md
// batch 1, §4.1 and §4.4; review of PR #1935 round 2). Each test names the review point whose property it pins. Both engines: every node is a
// database of its own (helpers/stampedWorld.ts openNode), a PGlite or a database of the real server.
// realPostgresAlso: the commit-time checks read content putBlob committed on its own connection, and the save path spans two connections on a server
import { afterEach, describe, expect, it } from "vitest";
import { migrate, q } from "../db.js";
import { listMigrations, useMigrationSource } from "../dbMigrations.js";
import { mutate } from "../spine/mutate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { standAsideForImport } from "../spine/stamps.js";
import { countVersionMisses, recordVersion } from "../spine/noteVersions.js";
import { updateNode } from "../services/nodeUpdate.js";
import { putBlob } from "../services/blobs.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import { createTaskNode } from "../services/tasksStore.js";
import { finishNewNote } from "../services/newNoteDerived.js";
import { updateTask } from "../modules/tasks/update.js";
import { INK_CHUNK_THRESHOLD } from "../services/inkChunks.js";
import { collectOrphanBlobs } from "../services/maintenance/prune.js";
import { purgeDeleted, trashNode } from "../services/nodeTrash.js";
import { seedQ } from "./helpers/seedQ.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, exchange, peerOf } from "./helpers/stampedBundleWorld.js";
import { setModulesOn } from "./helpers/setModulesOn.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });
const node = async (name: string) => { const n = await openNode(name); open.push(n); return n; };

type Version = { unit: string; version_key: string; kind: string; title: string | null; content_hash: string | null; ordinal: number; author_kind: string; restored_from: string | null };
const versionsOf = async (noteId: string, unit = "body"): Promise<Version[]> => (await q<Version>(
  `SELECT unit, version_key, kind, title, content_hash, ordinal, author_kind, restored_from FROM note_versions
    WHERE note_id = $1 AND unit = $2 ORDER BY clock_wall NULLS FIRST, clock_counter, ordinal`, [noteId, unit])).rows;
const count = async (sqlText: string, params: unknown[] = []) => Number((await q<{ n: string }>(sqlText, params)).rows[0]!.n);
/** Root writes that changed a note or drawing and minted nothing (migration 220 sync_clock.version_misses): none on a production path. */
// countVersionMisses is the total the server logs at boot (server.ts), so the operator sees the same number these tests assert.
const misses = () => countVersionMisses();
const sha = async (text: string) => (await q<{ h: string }>(`SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS h`, [text])).rows[0]!.h;

describe.skipIf(!isTestDb)("a local write mints its version (round 2, points 1 and 10)", () => {
  it("every save that changes the title or the text mints one version naming stored content; a save that changes nothing mints none", async () => {
    const n = await node("saves");
    const world = await buildSourceWorld(n);
    await onNode(n, async () => {
      const id = (await world.call("POST", "/api/nodes", { title: "Plan", markdown: "one", space_id: world.spaceA })).id as string;
      await world.call("PATCH", `/api/nodes/${id}`, { markdown: "one two" });
      await world.call("PATCH", `/api/nodes/${id}`, { title: "Plan B" });
      await world.call("PATCH", `/api/nodes/${id}`, { markdown: "one two" }); // nothing changes: no event, no version
      await world.call("PATCH", `/api/nodes/${id}`, { hidden: false }); // not the title or the text
      const versions = await versionsOf(id);
      expect(versions.map((v) => [v.kind, v.title])).toEqual([["created", "Plan"], ["updated", "Plan"], ["updated", "Plan B"]]);
      expect(versions.every((v) => /^s:[^:]+:\d+:1$/.test(v.version_key))).toBe(true);
      expect(versions.map((v) => v.author_kind)).toEqual(["person", "person", "person"]);
      // each names content that is stored, the very text the note had then
      const texts = await Promise.all(versions.map(async (v) => (await q<{ content: string }>(`SELECT content FROM blobs WHERE hash = $1`, [v.content_hash])).rows[0]?.content));
      expect(texts).toEqual(["one", "one two", "one two"]);
      // the note's save events are mapped to them, one each (this node's own map)
      expect(await count(`SELECT count(*)::text AS n FROM note_version_events WHERE note_id = $1`, [id])).toBe(3);
      expect(await misses()).toBe(0);
    });
  }, 120_000);

  it("a root write that changes a note's text without minting its version is counted; with it, not; a version naming content that is not stored fails the commit (point 1)", async () => {
    const n = await node("unminted");
    const world = await buildSourceWorld(n);
    await onNode(n, async () => {
      const id = (await world.call("POST", "/api/nodes", { title: "Kept", markdown: "as it was", space_id: world.spaceA })).id as string;
      expect(await misses()).toBe(0); // buildSourceWorld's writes and the create above went through the production paths
      const write = (text: string, version: "none" | "stored" | "not stored") => withEventTransaction(world.ws, () => mutate({
        actor: world.owner, workspaceId: world.ws, authority: { kind: "node", nodeId: id, op: "write_node" },
        event: { type: "NODE_UPDATED", targetType: "node", targetId: id, payload: { title: "Kept" } },
        apply: async () => {
          await q(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [id, text]);
          if (version === "stored") await recordVersion({ workspaceId: world.ws, noteId: id, unit: "body", contentHash: await putBlob(text), kind: "updated", title: "Kept" });
          if (version === "not stored") await recordVersion({ workspaceId: world.ws, noteId: id, unit: "body", contentHash: "0".repeat(64), kind: "updated", title: "Kept" });
        },
      }));
      await write("changed behind the versions", "none");
      expect(await misses()).toBe(1);
      expect(await countVersionMisses(world.ws)).toBe(1); // per workspace too; another workspace's count is its own
      expect(await countVersionMisses("00000000-0000-4000-8000-000000000000")).toBe(0);
      await write("changed with its version", "stored");
      expect(await misses()).toBe(1);
      expect((await versionsOf(id)).map((v) => v.kind)).toEqual(["created", "updated"]);
      await expect(write("a version of nothing", "not stored")).rejects.toThrow(/note_version_content_missing/);
      expect((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown).toBe("changed with its version");
      expect(await versionsOf(id)).toHaveLength(2);
    });
  }, 120_000);

  it("a drawing's save mints a version naming the value_ref its event names (whole and chunked); a removal mints `removed`; a write without one is counted", async () => {
    const n = await node("ink");
    const world = await buildSourceWorld(n);
    await onNode(n, async () => {
      const id = (await world.call("POST", "/api/nodes", { title: "Sketch", markdown: "", space_id: world.spaceA })).id as string;
      const small = JSON.stringify({ v: 1, strokes: [{ id: "a", points: [[0, 0], [1, 1]] }] });
      const big = JSON.stringify({ v: 1, strokes: Array.from({ length: Math.ceil(INK_CHUNK_THRESHOLD / 20) }, (_, i) => ({ id: `s${i}`, points: [[i, i], [i + 1, i + 2]] })) });
      for (const value of [small, big]) await world.call("PUT", `/api/nodes/${id}/attributes/ink_data`, { value });
      await world.call("DELETE", `/api/nodes/${id}/attributes/ink_data`);
      const versions = await versionsOf(id, "ink_data");
      expect(versions.map((v) => v.kind)).toEqual(["created", "updated", "removed"]);
      const refs = (await q<{ ref: string | null }>(
        `SELECT payload->>'value_ref' AS ref FROM domain_events WHERE target_id = $1 AND payload->>'key' = 'ink_data' ORDER BY id`, [id])).rows.map((r) => r.ref);
      expect(versions.map((v) => v.content_hash)).toEqual(refs);
      expect(versions[0]!.content_hash).toBe(await sha(small));
      // the big one is stored as chunks of the note (a manifest), the small one whole
      expect(await count(`SELECT count(*)::text AS n FROM blobs WHERE hash = $1`, [versions[0]!.content_hash])).toBe(1);
      expect(await count(`SELECT count(*)::text AS n FROM ink_manifests WHERE node_id = $1 AND hash = $2`, [id, versions[1]!.content_hash])).toBe(1);
      expect(await misses()).toBe(0);
      await withEventTransaction(world.ws, () => mutate({
        actor: world.owner, workspaceId: world.ws, authority: { kind: "node", nodeId: id, op: "write_node" },
        event: { type: "ATTRIBUTE_SET", targetType: "node", targetId: id, payload: { key: "ink_data" } },
        apply: async () => { await q(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, $2, 'ink_data', 'x', 'ui')`, [world.ws, id]); },
      }));
      expect(await misses()).toBe(1);
    });
  }, 120_000);
});

describe.skipIf(!isTestDb)("two writes of one note in one transaction, restores and the writes that are not edits (round 2, points 3, 4, 10)", () => {
  it("one transaction that writes a note twice mints two keys, ordinal 1 and 2 in write order, both of that transaction's sequence number", async () => {
    const n = await node("twice");
    const world = await buildSourceWorld(n);
    await onNode(n, async () => {
      const id = (await world.call("POST", "/api/nodes", { title: "Twice", markdown: "a", space_id: world.spaceA })).id as string;
      await withEventTransaction(world.ws, async () => {
        await updateNode(world.ws, id, { markdown: "a b" }, { actor: world.owner });
        await updateNode(world.ws, id, { markdown: "a b c" }, { actor: world.owner });
      });
      const [, first, second] = await versionsOf(id);
      expect([first!.ordinal, second!.ordinal]).toEqual([1, 2]);
      expect(first!.version_key.replace(/:1$/, "")).toBe(second!.version_key.replace(/:2$/, ""));
      expect(await Promise.all([first, second].map(async (v) => (await q<{ content: string }>(`SELECT content FROM blobs WHERE hash = $1`, [v!.content_hash])).rows[0]!.content))).toEqual(["a b", "a b c"]);
      expect(await misses()).toBe(0);
    });
  }, 120_000);

  it("a save that keeps the note's text where both changed sets the text it was putting back aside, as a version of its own (round 1, point 10)", async () => {
    const n = await node("set-aside");
    const world = await buildSourceWorld(n);
    await onNode(n, async () => {
      const id = (await world.call("POST", "/api/nodes", { title: "Both", markdown: "a\nb\nc", space_id: world.spaceA })).id as string;
      await world.call("PATCH", `/api/nodes/${id}`, { markdown: "a\nX\nc" }); // what a person wrote since
      // an undo-like save based on the first text that changes the same line, keeping the note's text there
      const saved = await updateNode(world.ws, id, { markdown: "a\nY\nc" }, { actor: world.owner, baseMarkdown: "a\nb\nc", keepOnConflict: "current" });
      expect(saved.bodyConflicts.length).toBeGreaterThan(0);
      const versions = await versionsOf(id);
      const aside = versions.filter((v) => v.kind === "set_aside");
      expect(aside).toHaveLength(1);
      expect((await q<{ content: string }>(`SELECT content FROM blobs WHERE hash = $1`, [aside[0]!.content_hash])).rows[0]!.content).toBe("a\nY\nc");
      // the note keeps "X": no version names the set-aside text as the note's body, and the save's event maps to the save, not to it
      expect((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown).toContain("X");
      expect(await count(`SELECT count(*)::text AS n FROM note_version_events WHERE version_key = $1`, [aside[0]!.version_key])).toBe(0);
      expect(await misses()).toBe(0);
    });
  }, 120_000);

  it("a version restore names the version it puts back; an event undo names the version before the undone event; putting back what is there mints nothing", async () => {
    const n = await node("restores");
    const world = await buildSourceWorld(n);
    await onNode(n, async () => {
      const id = (await world.call("POST", "/api/nodes", { title: "R", markdown: "first", space_id: world.spaceA })).id as string;
      await world.call("PATCH", `/api/nodes/${id}`, { markdown: "second" });
      const firstEvent = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_CREATED'`, [id])).rows[0]!.id;
      await world.call("POST", `/api/nodes/${id}/versions/${firstEvent}/restore`, {});
      let versions = await versionsOf(id);
      expect(versions.map((v) => v.kind)).toEqual(["created", "updated", "restored"]);
      expect(versions[2]!.restored_from).toBe(versions[0]!.version_key);
      // undo the restore: the note goes back to "second", the version the restore replaced
      const restoreEventId = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_RESTORED'`, [id])).rows[0]!.id;
      const undone = await restoreEvent(restoreEventId, { actor: world.owner, workspaceId: world.ws });
      expect("code" in undone ? undone : null).toBeNull();
      versions = await versionsOf(id);
      expect(versions.map((v) => v.kind)).toEqual(["created", "updated", "restored", "updated"]);
      expect(versions[3]!.restored_from).toBe(versions[1]!.version_key);
      // restoring the version the note already holds: refused as a no-op or written as an unchanged save, either way no new version
      const latest = (await q<{ id: string }>(`SELECT max(id)::text AS id FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash'`, [id])).rows[0]!.id;
      await world.call("POST", `/api/nodes/${id}/versions/${latest}/restore`, {}).catch(() => undefined);
      expect(await versionsOf(id)).toHaveLength(4);
      // every save event of the note maps to a version
      expect(await count(`SELECT count(*)::text AS n FROM domain_events e WHERE e.target_id = $1 AND e.payload ? 'body_hash'
                            AND NOT EXISTS (SELECT 1 FROM note_version_events ve WHERE ve.event_id = e.id)`, [id])).toBe(0);
      expect(await misses()).toBe(0);
    });
  }, 120_000);

  it("a task made with text, its rename, the next occurrence of a repeating one and a board's rename each mint their version; a tag mints none", async () => {
    const n = await node("tasks");
    const world = await buildSourceWorld(n);
    await onNode(n, async () => {
      await setModulesOn(world.ws, null);
      const yesterday = (await q<{ d: string }>(`SELECT (current_date - 3)::text AS d`)).rows[0]!.d;
      const task = await createTaskNode({ workspaceId: world.ws, actor: world.owner, hostId: null, spaceId: world.spaceA, title: "Water plants",
        markdown: "the ones by the window", finishBody: finishNewNote, recur: "1d", when: yesterday });
      expect((await versionsOf(task)).map((v) => [v.kind, v.title])).toEqual([["created", "Water plants"]]);
      expect((await q<{ content: string }>(`SELECT content FROM blobs WHERE hash = $1`, [(await versionsOf(task))[0]!.content_hash])).rows[0]!.content).toBe("the ones by the window");
      await updateTask(world.owner, task, { title: "Water the plants" });
      expect((await versionsOf(task)).map((v) => v.title)).toEqual(["Water plants", "Water the plants"]);
      const { drainDueTasks } = await import("../modules/tasks/scheduler.js");
      await drainDueTasks();
      const next = (await q<{ id: string }>(`SELECT target_id AS id FROM domain_events WHERE event_type = 'NODE_CREATED' AND payload->>'rolled_from' = $1`, [task])).rows[0]?.id;
      expect(next).toBeTruthy();
      const rolled = await versionsOf(next!);
      expect(rolled.map((v) => [v.kind, v.author_kind])).toEqual([["created", "automatic"]]);
      expect((await q<{ content: string }>(`SELECT content FROM blobs WHERE hash = $1`, [rolled[0]!.content_hash])).rows[0]!.content).toBe("the ones by the window");

      const board = (await world.call("POST", "/api/canvases", { title: "Board" })).id as string;
      await world.call("PATCH", `/api/canvases/${board}`, { title: "Board two" });
      expect((await versionsOf(board)).map((v) => v.title)).toEqual(["Board", "Board two"]);

      const tag = (await world.call("POST", "/api/tags", { name: "versionless" })).id as string;
      await world.call("PATCH", `/api/tags/${tag}`, { name: "still versionless" });
      await world.call("PATCH", `/api/nodes/${tag}`, { markdown: "a tag's description, saved through the ordinary save" });
      expect(await count(`SELECT count(*)::text AS n FROM note_versions WHERE note_id = $1`, [tag])).toBe(0);
      expect(await misses()).toBe(0);
    });
  }, 180_000);
});

describe.skipIf(!isTestDb)("nothing is minted where nothing is written by this node (round 2, points 5, 6, 11)", () => {
  it("an untouched shell holds no version and no blob", async () => {
    const n = await node("shell");
    await onNode(n, async () => {
      // the shell holds notes: the seeded tags and the system's Site Config; none has a version list (note_version_in_scope), so migration
      // 220's pass gives them no baseline and nothing else writes one
      expect(await count(`SELECT count(*)::text AS n FROM content_nodes WHERE source_type = 'system'`)).toBeGreaterThan(0);
      expect(await count(`SELECT count(*)::text AS n FROM content_nodes WHERE node_type = 'class_tag'`)).toBeGreaterThan(0);
      expect(await count(`SELECT count(*)::text AS n FROM note_versions`)).toBe(0);
      expect(await misses()).toBe(0);
      expect(await count(`SELECT count(*)::text AS n FROM blobs`)).toBe(0);
      expect(await count(`SELECT count(*)::text AS n FROM note_version_positions`)).toBe(0);
    });
  }, 60_000);

  it("a snapshot join mints none (the joined node holds no version it did not write); a received bundle mints none; minting inside an import is refused", async () => {
    const [na, nb] = [await node("source"), await node("joiner")];
    const world = await buildSourceWorld(na);
    const sourceVersions = await onNode(na, () => count(`SELECT count(*)::text AS n FROM note_versions WHERE workspace_id = $1`, [world.ws]));
    expect(sourceVersions).toBeGreaterThan(0);
    await fillFrom(nb, world, await capture(na, world));
    const a = peerOf("A", na, world), b = peerOf("B", nb, world);
    expect(await onNode(nb, () => count(`SELECT count(*)::text AS n FROM note_versions`))).toBe(0);
    // the join wrote every note and drawing, and minted nothing: the check stood aside (note_version_exempt 'import'), it counted no miss
    expect(await onNode(nb, misses)).toBe(0);
    await admit(a, b);
    await onNode(na, async () => {
      const id = (await a.call("POST", "/api/nodes", { title: "After the join", markdown: "new on A", space_id: a.space })).id as string;
      await a.call("PATCH", `/api/nodes/${id}`, { markdown: "newer on A" });
    });
    const taken = await exchange(a, b);
    expect(taken.rejected).toEqual([]);
    expect(await onNode(nb, () => count(`SELECT count(*)::text AS n FROM note_versions`))).toBe(0);
    expect(await onNode(nb, () => count(`SELECT count(*)::text AS n FROM content_nodes WHERE title = 'After the join'`))).toBe(1);
    expect(await onNode(nb, misses)).toBe(0); // the received bundle wrote a note and two saves of it: no miss either
    // the joined node's own writes mint as any node's do
    await onNode(nb, async () => {
      const id = (await b.call("POST", "/api/nodes", { title: "Written on B", markdown: "b", space_id: b.space })).id as string;
      expect((await versionsOf(id)).map((v) => v.kind)).toEqual(["created"]);
      await expect(withEventTransaction(b.ws, async () => { await standAsideForImport(b.ws, "merge"); await recordVersion({ workspaceId: b.ws, noteId: id, unit: "body", contentHash: "x", kind: "updated" }); }))
        .rejects.toThrow(/no version is minted here \(import\)/);
    });
  }, 300_000);

  it("a data migration that rewrites titles mints no version and passes the commit check", async () => {
    const n = await node("data-migration");
    const world = await buildSourceWorld(n);
    await onNode(n, async () => {
      const id = (await world.call("POST", "/api/nodes", { title: "Before the migration", markdown: "x", space_id: world.spaceA })).id as string;
      const before = await count(`SELECT count(*)::text AS n FROM note_versions`);
      const real = await listMigrations();
      useMigrationSource(async () => [...real, { version: "999_test_retitle", sql: `UPDATE content_nodes SET title = 'Retitled by a migration' WHERE id = '${id}'` }]);
      try { await migrate({ seedNativeActor: false }); } finally { useMigrationSource(async () => real); }
      expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [id])).rows[0]!.title).toBe("Retitled by a migration");
      expect(await count(`SELECT count(*)::text AS n FROM note_versions`)).toBe(before);
      expect(await misses()).toBe(0);
      // A migration (and the shell) write no note through a root write, so there is no check to stand aside from and nothing calls
      // recordVersion: the property above holds by structure. What onden.no_versions adds is that a write path called from one of them by
      // mistake fails instead of minting a version each node would mint differently:
      await expect(withEventTransaction(world.ws, async () => {
        await q(`SELECT set_config('onden.no_versions', 'on', true)`);
        await recordVersion({ workspaceId: world.ws, noteId: id, unit: "body", contentHash: await putBlob("x"), kind: "updated", title: "x" });
      })).rejects.toThrow(/no version is minted here \(off\)/);
    });
  }, 120_000);
});

describe.skipIf(!isTestDb)("the cleanup and versions (proposal §6)", () => {
  it("the orphan sweep keeps content only a version names (a received version, a baseline) and takes it once no version does", async () => {
    const n = await node("sweep");
    const world = await buildSourceWorld(n);
    await onNode(n, async () => {
      const id = (await world.call("POST", "/api/nodes", { title: "Swept", markdown: "x", space_id: world.spaceA })).id as string;
      // a version this node has no event for, as a received one or a baseline is, naming content put long ago
      const text = "only a version names this";
      const hash = await sha(text);
      await seedQ(`INSERT INTO blobs (hash, content, size_bytes, created_at) VALUES ($1, $2, octet_length($2), now() - interval '30 days')`, [hash, text]);
      await seedQ(`INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, title, content_hash, at, ordinal, recorded_by, author_kind)
                   VALUES ($1, $2, 'body', 'b:test', 'baseline', 'Swept', $3, '2026-01-01T00:00:00.000000Z', 0, 'elsewhere', 'automatic')`, [world.ws, id, hash]);
      await collectOrphanBlobs();
      expect(await count(`SELECT count(*)::text AS n FROM blobs WHERE hash = $1`, [hash])).toBe(1);
      await seedQ(`DELETE FROM note_versions WHERE version_key = 'b:test'`);
      await collectOrphanBlobs();
      expect(await count(`SELECT count(*)::text AS n FROM blobs WHERE hash = $1`, [hash])).toBe(0);
    });
  }, 120_000);

  it("deleting a note for good takes its versions and the content only they named; content another note's version names stays", async () => {
    const n = await node("purge");
    const world = await buildSourceWorld(n);
    await onNode(n, async () => {
      const shared = "the same words in two notes";
      const gone = (await world.call("POST", "/api/nodes", { title: "Gone", markdown: shared, space_id: world.spaceA })).id as string;
      await world.call("PATCH", `/api/nodes/${gone}`, { markdown: "words only this note had" });
      const kept = (await world.call("POST", "/api/nodes", { title: "Kept", markdown: shared, space_id: world.spaceA })).id as string;
      // a baseline-like version of the purged note whose content no event names
      const onlyVersion = "named by a version of Gone only";
      const onlyHash = await sha(onlyVersion);
      await seedQ(`INSERT INTO blobs (hash, content, size_bytes) VALUES ($1, $2, octet_length($2))`, [onlyHash, onlyVersion]);
      await seedQ(`INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, title, content_hash, at, ordinal, recorded_by, author_kind)
                   VALUES ($1, $2, 'body', 'b:gone', 'baseline', 'Gone', $3, '2026-01-01T00:00:00.000000Z', 0, 'elsewhere', 'automatic')`, [world.ws, gone, onlyHash]);
      await trashNode(world.owner, world.ws, gone);
      await purgeDeleted(world.owner, world.ws, gone);
      expect(await count(`SELECT count(*)::text AS n FROM note_versions WHERE note_id = $1`, [gone])).toBe(0);
      expect(await count(`SELECT count(*)::text AS n FROM blobs WHERE hash = $1`, [onlyHash])).toBe(0);
      expect(await count(`SELECT count(*)::text AS n FROM blobs WHERE hash = $1`, [await sha("words only this note had")])).toBe(0);
      expect(await count(`SELECT count(*)::text AS n FROM blobs WHERE hash = $1`, [await sha(shared)])).toBe(1);
      expect((await versionsOf(kept)).map((v) => v.kind)).toEqual(["created"]);
    });
  }, 120_000);
});
