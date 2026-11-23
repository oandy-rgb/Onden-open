// A tag's description has versions like a note's text (history-replication batch 8: migration 231; proposal §9 row 8 and §10). The properties:
//   1. editing a tag's description mints exactly one version and sync_clock.version_misses does not grow; creating a tag and renaming it mint none;
//   2. restoring an old description works and mints exactly one version (and the tag's name comes back with it, as it always did);
//   3. after the upgrade the tag's history list equals the list before it, row by row (author, time, merging): the event readers copied in
//      helpers/legacyHistoryReaders.ts are the oracle, run on a server's history from before 231 (real Postgres and PGlite) and on the old-copy
//      tool's copy from before 220 (PGlite), then the saves made afterwards;
//   4. the preview in the migration's header equals what the migration writes, a second pass writes nothing, two copies upgraded apart agree;
//   5. nothing changes for notes: the pass writes no version of a note, and a note's save still mints one.
// No test here moves time relative to now and counts "today" (they fail around UTC midnight): times are compared, never bucketed by the clock.
// realPostgresAlso: the version tables are written on two connections (the blob store commits its own)
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { allowUnstampedWrite, dbDriver, migrate, q, withTransaction } from "../db.js";
import { countVersionMisses } from "../spine/noteVersions.js";
import { putBlob } from "../services/blobs.js";
import { INK_CHUNK_THRESHOLD } from "../services/inkChunks.js";
import { listNoteVersions } from "../services/history/noteVersions.js";
import type { ActorCtx } from "../types.js";
import { proof, type Ctx } from "./helpers/historyReadersProof.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, makeCaller, openNode } from "./helpers/stampedWorld.js";
import { TAG_PREVIEW_SQL } from "./helpers/versionsPreview.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const backend = resolve(import.meta.dirname, "../..");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });
const count = async (text: string, params: unknown[] = []) => Number((await q<{ n: string }>(text, params)).rows[0]!.n);
const versionsOf = async (noteId: string) => (await q<{ version_key: string; kind: string; title: string | null; restored_from: string | null; text: string }>(
  `SELECT v.version_key, v.kind, v.title, v.restored_from, b.content AS text FROM note_versions v JOIN blobs b ON b.hash = v.content_hash
    WHERE v.note_id = $1 AND v.unit = 'body' ORDER BY coalesce(v.clock_wall, 0), coalesce(v.clock_counter, 0), v.ordinal`, [noteId])).rows;
const tagIdentities = () => q(
  `SELECT v.note_id, v.version_key, v.kind, v.title, v.content_hash, CASE WHEN v.version_key LIKE 'b:%' THEN NULL ELSE v.at END AS at, v.ordinal, v.author_kind, v.author_id, v.restored_from
     FROM note_versions v JOIN content_nodes c ON c.id = v.note_id AND c.node_type = 'class_tag' ORDER BY v.note_id, v.unit, v.version_key`).then((r) => r.rows);
const noteIdentities = () => q(
  `SELECT v.note_id, v.unit, v.version_key, v.kind, v.title, v.content_hash, v.at, v.ordinal, v.restored_from
     FROM note_versions v JOIN content_nodes c ON c.id = v.note_id AND c.node_type <> 'class_tag' ORDER BY v.note_id, v.unit, v.version_key`).then((r) => r.rows);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const drawing = (...ids: string[]) => JSON.stringify({ v: 1, strokes: ids.map((id, i) => ({ id, points: [[i, i], [i + 4, i + 4]] })) });

/** The saves people make on tags: descriptions, a restore of an old one, a rename, a rename with a description in one request, a repeat, a description cleared. */
async function tagSaves(c: Ctx, suffix: string): Promise<string[]> {
  const made: string[] = [];
  const tag = async (name: string) => { const id = (await c.call("POST", "/api/tags", { name: `${name}-${suffix}` })).id as string; made.push(id); return id; };
  const setDescription = (id: string, markdown: string) => c.call("PATCH", `/api/nodes/${id}`, { markdown });

  const plain = await tag("plain");
  for (const text of ["# Plain\n\nfirst", "# Plain\n\nfirst, second", "third only"]) await setDescription(plain, text);
  await setDescription(plain, "third only"); // nothing changes: no event, no version
  await c.call("PATCH", `/api/tags/${plain}`, { name: `plain-renamed-${suffix}` }); // the name is no version of the description
  await c.call("PATCH", `/api/nodes/${plain}`, { markdown: "after the rename", title: `plain-again-${suffix}` }); // both in one request

  const restored = await tag("restored");
  for (const text of ["one", "one two", "one two three"]) await setDescription(restored, text);
  const saves = await c.call("GET", `/api/nodes/${restored}/versions?raw=1`) as Array<{ id: string }>;
  await c.call("POST", `/api/nodes/${restored}/versions/${saves[saves.length - 1]!.id}/restore`, {}); // back to "one"
  await setDescription(restored, "one, edited after the restore");

  const cleared = await tag("cleared");
  await setDescription(cleared, "something");
  await setDescription(cleared, "");
  await setDescription(cleared, "and again");

  // a tag's page has a whiteboard (board_ink): drawn, drawn on, erased, drawn again
  const drawn = await tag("drawn");
  await c.call("PUT", `/api/nodes/${drawn}/attributes/board_ink`, { value: drawing("a") });
  await c.call("PUT", `/api/nodes/${drawn}/attributes/board_ink`, { value: drawing("a", "b") });
  await c.call("DELETE", `/api/nodes/${drawn}/attributes/board_ink`);
  await c.call("PUT", `/api/nodes/${drawn}/attributes/board_ink`, { value: drawing("c") });
  await setDescription(drawn, "a page with a whiteboard");

  await tag("empty"); // never described
  return made;
}

// ---- 1, 2, 5: what a local write mints --------------------------------------------------------------------------------------------
describe.skipIf(!isTestDatabase())("a tag's description mints its version", () => {
  it("one version per description change; none for the tag's creation, its name, or a repeat; a restore mints one; version_misses stays 0", async () => {
    const n = await openNode("tag-mints");
    open.push(n);
    const world = await buildSourceWorld(n);
    await onNode(n, async () => {
      const missesBefore = await countVersionMisses();
      const id = (await world.call("POST", "/api/tags", { name: "reading" })).id as string;
      expect(await versionsOf(id), "a new tag has no versions: its history starts at its first description").toEqual([]);

      await world.call("PATCH", `/api/nodes/${id}`, { markdown: "books to read" });
      let versions = await versionsOf(id);
      expect(versions.map((v) => [v.kind, v.title, v.text])).toEqual([["updated", "reading", "books to read"]]);
      expect(versions[0]!.version_key).toMatch(/^s:[^:]+:\d+:1$/);
      expect(await count(`SELECT count(*)::text AS n FROM note_version_events WHERE note_id = $1`, [id]), "its save event is mapped to the version").toBe(1);

      await world.call("PATCH", `/api/nodes/${id}`, { markdown: "books to read" });
      await world.call("PATCH", `/api/tags/${id}`, { name: "to-read" });
      expect(await versionsOf(id), "a repeat and a rename mint nothing").toHaveLength(1);

      await world.call("PATCH", `/api/nodes/${id}`, { markdown: "books and papers" });
      await world.call("PATCH", `/api/nodes/${id}`, { markdown: "books and papers, and talks", title: "to-watch" });
      versions = await versionsOf(id);
      expect(versions.map((v) => v.text)).toEqual(["books to read", "books and papers", "books and papers, and talks"]);

      // restore the first description: one new version, naming the one it put back; the name it had then comes back with it
      const first = versions[0]!;
      await world.call("POST", `/api/nodes/${id}/versions/${first.version_key}/restore`, {});
      versions = await versionsOf(id);
      expect(versions).toHaveLength(4);
      expect(versions[3]).toMatchObject({ kind: "restored", text: "books to read", restored_from: first.version_key });
      expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [id])).rows[0]!.title).toBe(first.title);

      expect(await countVersionMisses(), "no write of a tag description went without its version").toBe(missesBefore);
      // and the same list a person reads
      const listed = await listNoteVersions(world.ws, world.owner, id, { raw: true });
      expect(listed!.map((r) => r.markdown)).toEqual(["books to read", "books and papers, and talks", "books and papers", "books to read"]);
    });
  }, 180_000);

  it("a note still mints exactly one version per save, and the system notes still have none", async () => {
    const n = await openNode("tag-note-unchanged");
    open.push(n);
    const world = await buildSourceWorld(n);
    await onNode(n, async () => {
      const note = (await world.call("POST", "/api/nodes", { title: "Plan", markdown: "one", space_id: world.spaceA })).id as string;
      const before = await versionsOf(note);
      await world.call("PATCH", `/api/nodes/${note}`, { markdown: "one two" });
      expect((await versionsOf(note)).length).toBe(before.length + 1);
      expect(await count(`SELECT count(*)::text AS n FROM note_versions v JOIN content_nodes c ON c.id = v.note_id WHERE c.source_type = 'system'`)).toBe(0);
      expect(await countVersionMisses()).toBe(0);
    });
  }, 120_000);
});

// ---- 3: the list after equals the list before --------------------------------------------------------------------------------------
describe.skipIf(!isTestDatabase())("the tag description list equals the event list", () => {
  it("saves made on a node after migration 231: the readers agree with the event readers, row by row", async () => {
    const n = await openNode("tag-readers-fresh");
    open.push(n);
    const world = await buildSourceWorld(n);
    await onNode(n, async () => {
      const c: Ctx = { ws: world.ws, actor: world.owner, space: world.spaceA, call: world.call };
      await proof(c, await tagSaves(c, "fresh"), "fresh tags");
    });
  }, 280_000);

  // A server before 231 held the tags' saves as events and blobs only. The same starting point is made without the old-copy tool (which makes PGlite
  // databases only): the saves are written through the app, then the tags' version rows are removed, which leaves exactly the events and blobs a server
  // before 231 held; migration 231's own pass (tag_versions_backfill, the function the migration calls per workspace) mints them back.
  it("events alone, then the pass of migration 231 over them, then the saves made after the upgrade (real Postgres and PGlite)", async () => {
    const n = await openNode("tag-readers-events-only");
    open.push(n);
    const world = await buildSourceWorld(n);
    await onNode(n, async () => {
      const c: Ctx = { ws: world.ws, actor: world.owner, space: world.spaceA, call: world.call };
      const tags = await tagSaves(c, "old");
      const note = (await world.call("POST", "/api/nodes", { title: "Note", markdown: "a note", space_id: world.spaceA })).id as string;
      await world.call("PATCH", `/api/nodes/${note}`, { markdown: "a note, edited" });
      const noteVersionsBefore = await noteIdentities();
      // a tag whose description only the tag row holds (written before history was kept): its baseline
      const bare = (await world.call("POST", "/api/tags", { name: "bare-old" })).id as string;
      await allowUnstampedWrite("test: a description no save names", () => withTransaction(async () => {
        await q("SET LOCAL session_replication_role = replica");
        await q(`UPDATE content_nodes SET markdown = 'written before history was kept' WHERE id = $1`, [bare]);
      }));
      tags.push(bare);
      // a tag whose whiteboard only the attribute row holds (drawn before history was kept): its baseline
      const bareDrawn = (await world.call("POST", "/api/tags", { name: "bare-drawn-old" })).id as string;
      await allowUnstampedWrite("test: a drawing no save names", () => withTransaction(async () => {
        await q("SET LOCAL session_replication_role = replica");
        await q(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, $2, 'board_ink', $3, 'ui')`, [world.ws, bareDrawn, drawing("old")]);
      }));
      tags.push(bareDrawn);
      // a save whose text is gone: skipped, the pass does not stop, the preview counts it
      const lost = (await world.call("POST", "/api/tags", { name: "lost-text-old" })).id as string;
      for (const text of ["text that stays", "text that will be gone", "text that comes last"]) await world.call("PATCH", `/api/nodes/${lost}`, { markdown: text });
      await q(`DELETE FROM blobs WHERE hash = encode(sha256(convert_to('text that will be gone', 'UTF8')), 'hex')`);
      tags.push(lost);
      // a drawing save whose value is gone: skipped like a description's, the pass does not stop, the preview counts it
      const lostInk = (await world.call("POST", "/api/tags", { name: "lost-drawing-old" })).id as string;
      for (const value of [drawing("l1"), drawing("l2"), drawing("l3")]) await world.call("PUT", `/api/nodes/${lostInk}/attributes/board_ink`, { value });
      await q(`DELETE FROM blobs WHERE hash = $1`, [sha256(drawing("l2"))]);
      tags.push(lostInk);
      // a drawing stored as chunks (its manifest, no blob): its version names the manifest's hash, and the pass copies no blob for it
      const bigDrawing = JSON.stringify({ v: 1, strokes: Array.from({ length: Math.ceil(INK_CHUNK_THRESHOLD / 20) }, (_, i) => ({ id: `s${i}`, points: [[i, i], [i + 1, i + 2]] })) });
      const chunked = (await world.call("POST", "/api/tags", { name: "chunked-old" })).id as string;
      await world.call("PUT", `/api/nodes/${chunked}/attributes/board_ink`, { value: bigDrawing });
      expect(await count(`SELECT count(*)::text AS n FROM ink_manifests WHERE node_id = $1 AND hash = $2`, [chunked, sha256(bigDrawing)]), "stored as chunks").toBe(1);
      tags.push(chunked);
      // a drawing a conflict set aside, that no version holds
      const asideTag = (await world.call("POST", "/api/tags", { name: "aside-old" })).id as string;
      await world.call("PUT", `/api/nodes/${asideTag}/attributes/board_ink`, { value: drawing("k1") });
      const asideHash = await putBlob(drawing("never held"));
      await allowUnstampedWrite("test: a conflict's event", () => withTransaction(async () => {
        await q("SET LOCAL session_replication_role = replica");
        await q(`INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload)
                  VALUES ($1, 'user', $2, 'ATTRIBUTE_CONFLICT', 'node', $3, jsonb_build_object('key', 'board_ink', 'overridden_value_ref', $4::text))`, [world.ws, world.owner.id, asideTag, asideHash]);
      }));
      tags.push(asideTag);
      // what the saves minted, but for the save whose text is gone (the pass skips it: nothing could be shown or restored)
      const goneHashes = new Set([sha256("text that will be gone"), sha256(drawing("l2"))]);
      const minted = (await tagIdentities()).filter((r) => !((r.note_id === lost || r.note_id === lostInk) && goneHashes.has(String(r.content_hash))));

      const preview = (await q<Record<string, string>>(TAG_PREVIEW_SQL)).rows[0]!; // the operator's read-only block, on the server as it is before the pass
      // a server before 231: no version rows for tags
      await allowUnstampedWrite("test: the server as it was before 231 (no tag version rows)", () => withTransaction(async () => {
        await q("SET LOCAL session_replication_role = replica");
        const ids = `(SELECT id FROM content_nodes WHERE node_type = 'class_tag')`;
        await q(`DELETE FROM note_version_events WHERE note_id IN ${ids}`);
        await q(`DELETE FROM note_version_positions WHERE note_id IN ${ids}`);
        await q(`DELETE FROM note_versions WHERE note_id IN ${ids}`);
      }));
      expect(await count(`SELECT count(*)::text AS n FROM note_version_events ve JOIN content_nodes c ON c.id = ve.note_id WHERE c.node_type = 'class_tag'`), "the preview's premise: no tag event is mapped yet").toBe(0);
      const pass = () => allowUnstampedWrite("test: the migration's data step", () => withTransaction(async () => {
        await q(`SELECT set_config('onden.no_versions', 'on', true)`);
        await q(`SELECT set_config('statement_timeout', '0', true)`);
        return (await q<{ versions: string; baselines: string; set_aside: string; s0: string | null }>(`SELECT b.* FROM workspaces w CROSS JOIN LATERAL tag_versions_backfill(w.id) b`)).rows;
      }));
      const written = await pass();
      const sum = (key: "versions" | "baselines") => written.reduce((total, r) => total + Number(r[key]), 0);
      expect({ versions: String(sum("versions")), baselines: String(sum("baselines")) }, "the preview is what the pass wrote")
        .toEqual({ versions: String(Number(preview.description_versions) + Number(preview.drawing_versions)), baselines: String(Number(preview.description_baselines) + Number(preview.drawing_baselines)) });
      expect(sum("versions")).toBeGreaterThan(12);
      expect([preview.description_baselines, preview.drawing_baselines], "a description and a drawing no save names").toEqual(["1", "1"]);
      expect(Number(preview.drawing_versions), "the whiteboard's saves").toBeGreaterThanOrEqual(4);
      expect(preview.description_saves_without_text, "the save whose text is gone is counted, not written").toBe("1");
      expect(preview.drawing_saves_without_value, "the drawing save whose value is gone is counted, not written").toBe("1");
      expect(preview.drawings_set_aside, "the drawing a conflict set aside").toBe("1");
      expect(written.reduce((total, r) => total + Number(r.set_aside), 0), "the pass wrote it as a set-aside version").toBe(1);
      // the chunked drawing: a version naming the manifest's hash, and no blob copied for it
      expect((await q<{ n: string }>(`SELECT count(*)::text AS n FROM note_versions WHERE note_id = $1 AND unit = 'board_ink' AND content_hash = $2`, [chunked, sha256(bigDrawing)])).rows[0]!.n).toBe("1");
      expect(await count(`SELECT count(*)::text AS n FROM blobs WHERE hash = $1`, [sha256(bigDrawing)]), "no blob is copied for a chunked drawing").toBe(0);
      // the versions minted back are the ones the saves minted, in number and content (the identity of an `s:` version is its stamp, of a `g:` one its content)
      expect((await tagIdentities()).filter((r) => !String(r.version_key).startsWith("b:") && r.kind !== "set_aside").map((r) => [r.note_id, r.kind, r.title, r.content_hash]).sort())
        .toEqual(minted.map((r) => [r.note_id, r.kind, r.title, r.content_hash]).sort());
      expect(await noteIdentities(), "the pass writes no version of a note").toEqual(noteVersionsBefore);

      await proof(c, tags, "server, upgraded");

      // a second pass writes nothing: no row, no sequence number
      const state = async () => [(await q(`SELECT workspace_id, next_seq FROM sync_clock ORDER BY 1`)).rows, await count(`SELECT count(*)::text AS n FROM note_version_positions`), await tagIdentities()];
      const again0 = await pass();
      expect(again0.every((r) => Number(r.versions) + Number(r.baselines) === 0 && r.s0 === null)).toBe(true);
      // ... and not after a save made in between either (it minted its own version: the pass must not mint a second one for the same event)
      await c.call("PATCH", `/api/nodes/${tags[0]}`, { markdown: "saved between two passes" });
      await c.call("PUT", `/api/nodes/${tags[3]}/attributes/board_ink`, { value: drawing("between") });
      const before = await state();
      const again = await pass();
      expect(again.every((r) => Number(r.versions) + Number(r.baselines) === 0 && r.s0 === null)).toBe(true);
      expect(await state()).toEqual(before);

      // then the saves people make afterwards, on those tags and on new ones
      const after = await tagSaves(c, "new");
      await c.call("PATCH", `/api/nodes/${tags[0]}`, { markdown: "an edit after the upgrade" });
      await c.call("PATCH", `/api/nodes/${bare}`, { markdown: "the bare tag, edited" });
      await proof(c, [...tags, ...after], "server, upgraded + new saves");
      expect(await countVersionMisses()).toBe(0);
    });
  }, 600_000);
});

// ---- 3 and 4 on the copy an older app left (PGlite) ---------------------------------------------------------------------------------
if (dbDriver === "pglite") describe.skipIf(!isTestDatabase())("migration 231 on a copy from before migration 220", () => {
  let dir = "";
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("the preview equals what the upgrade writes; two copies upgraded apart agree; the tag lists equal the event lists; the saves made afterwards too", async () => {
    dir = mkdtempSync(join(tmpdir(), "tag-versions-copy-"));
    const file = join(dir, "history.tar.gz");
    await promisify(execFile)("npx", ["tsx", "src/browser/makeOldCopy.ts", file, "history"], { cwd: backend, timeout: 280_000, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1", ONDEN_PGLITE_SNAPSHOT: "" } });
    const [a, b] = [await RealNode.open("tag-old-a", undefined, file), await RealNode.open("tag-old-b", undefined, file)];
    open.push(a, b);
    // the copy is from before 220: tags' history is events only
    const preview = await onNode(a, async () => {
      expect((await q<{ t: string | null }>(`SELECT to_regclass('note_versions')::text AS t`)).rows[0]!.t).toBeNull();
      return (await q<Record<string, string>>(TAG_PREVIEW_SQL)).rows[0]!;
    });
    expect(Number(preview.tags_with_description_saves)).toBeGreaterThan(0);
    expect(Number(preview.description_versions)).toBeGreaterThan(3);
    expect(Number(preview.description_baselines)).toBe(1);
    expect(Number(preview.drawing_versions), "the tag page's whiteboard saves").toBe(2);
    expect(Number(preview.drawing_baselines)).toBe(1);
    await onNode(b, () => migrate({ seedNativeActor: false }));
    const [identA, ctx] = await onNode(a, async () => {
      await migrate({ seedNativeActor: false });
      const tagVersions = (unitIs: string, key: string) => count(`SELECT count(*)::text AS n FROM note_versions v JOIN content_nodes c ON c.id = v.note_id AND c.node_type = 'class_tag'
         WHERE v.version_key LIKE '${key}:%' AND v.unit ${unitIs} AND v.kind <> 'set_aside'`);
      const wrote = {
        description_versions: String(await tagVersions("= 'body'", "g")), description_baselines: String(await tagVersions("= 'body'", "b")),
        drawing_versions: String(await tagVersions("<> 'body'", "g")), drawing_baselines: String(await tagVersions("<> 'body'", "b")),
      };
      console.log(`[migration 231, old copy] preview ${JSON.stringify(preview)}; written ${JSON.stringify(wrote)}`);
      expect(wrote).toEqual({ description_versions: preview.description_versions, description_baselines: preview.description_baselines, drawing_versions: preview.drawing_versions, drawing_baselines: preview.drawing_baselines });

      const person = (await q<{ id: string; name: string; workspace_id: string }>(`SELECT id::text, name, workspace_id::text FROM actors WHERE type = 'human' ORDER BY created_at LIMIT 1`)).rows[0]!;
      const space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [person.id])).rows[0]!.id;
      const actor = { id: person.id, name: person.name, type: "human", role: "admin" } as ActorCtx;
      const c: Ctx = { ws: person.workspace_id, actor, space, call: makeCaller(actor) };
      const tags = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND source_type <> 'system' ORDER BY created_at, id`, [c.ws])).rows.map((r) => r.id);
      await proof(c, tags, "copy tags"); // the lists as they were, row by row
      expect(await count(`SELECT count(*)::text AS n FROM note_versions v JOIN content_nodes c ON c.id = v.note_id WHERE c.source_type = 'system'`)).toBe(0);
      // then the saves people make afterwards
      const made = await tagSaves(c, "after");
      await c.call("PATCH", `/api/nodes/${tags[0]}`, { markdown: "an edit after the upgrade" });
      await proof(c, [...tags, ...made], "copy tags + new saves");
      expect(await countVersionMisses()).toBe(0);
      return [await tagIdentities(), c] as const;
    });
    expect(ctx.ws).toBeTruthy();
    // the other copy, upgraded by itself and given nothing: its tag versions are what the first held right after the upgrade (before the saves above)
    const identB = await onNode(b, tagIdentities);
    const first = identA.filter((r) => identB.some((x) => x.version_key === r.version_key));
    expect(first.length, "every version of the copy upgraded apart is in the other with the same identity").toBe(identB.length);
    for (const r of identB) expect(identA.find((x) => x.version_key === r.version_key), String(r.version_key)).toMatchObject({ note_id: r.note_id, kind: r.kind, title: r.title, content_hash: r.content_hash, restored_from: r.restored_from });
  }, 600_000);
});
