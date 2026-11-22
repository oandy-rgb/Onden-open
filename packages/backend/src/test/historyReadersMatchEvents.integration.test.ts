// THE PROOF of history-replication batch 2 (proposal §9 row 2): on one database, every reader of a note's text, title and drawings that now
// reads the version tables returns what the event reader returned before, row for row. The old readers live only in
// helpers/legacyHistoryReaders.ts (today's queries copied as the oracle); the product readers are the ones the routes call.
//
// The database is the old-copy tool's `history` copy upgraded through migration 220 (PGlite only: the tool makes PGlite tars), then the saves
// people make after the upgrade (an ordinary save, a restore of an old version by key and by the number of its event, an undo, a title-only
// save, two saves in one transaction, a repeat save, a drawing, a task made with text), and, on both engines, a fresh node with the same
// new saves plus a backup carried in with its history.
//
// WHAT IS COMPARED, for every note: the version list (merged, and `?raw=1`), the latest version, "the workspace at T" for every day and every
// version time (title and text then, status), the text and title each version restores to (by key and by the number of its event), a
// drawing's edits and versions (handwriting and whiteboard). Every difference is either a failure or one of INTENDED below, counted and
// printed: the PR lists them.
// realPostgresAlso: the version tables are written on two connections (the blob store commits its own), and a server shows what a single connection hides
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { allowUnstampedWrite, dbDriver, migrate, q, withTransaction } from "../db.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { updateNode } from "../services/nodeUpdate.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import { createTaskNode } from "../services/tasksStore.js";
import { finishNewNote } from "../services/newNoteDerived.js";
import { listNoteVersions } from "../services/history/noteVersions.js";
import type { ActorCtx } from "../types.js";
import { ALIGN_VERSION_TIMES_SQL } from "./helpers/alignVersionTimes.js";
import { intendedDifferences, proof, type Ctx } from "./helpers/historyReadersProof.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, makeCaller, openNode } from "./helpers/stampedWorld.js";
import { seedQ } from "./helpers/seedQ.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const backend = resolve(import.meta.dirname, "../..");
const drawing = (...ids: string[]) => JSON.stringify({ v: 1, strokes: ids.map((id, i) => ({ id, points: [[i, i], [i + 4, i + 4]] })) });

// ---- the fixture ---------------------------------------------------------------------------------------------------------------
const eventsOf = async (noteId: string) => (await q<{ id: string }>(
  `SELECT e.id::text AS id FROM domain_events e WHERE e.target_id = $1 AND (e.payload ? 'body_hash' OR e.payload->>'key' IN ('ink_data','board_ink','note_ink')) ORDER BY e.id`, [noteId])).rows.map((r) => r.id);

/** Give a note's saves times spread over days and minutes (rapid, a pause, a new day), in the order they were made, and move their versions along. */
async function spreadTimes(noteIds: string[]) {
  const gaps = [0, 1, 2, 30, 1, 26 * 60, 3, 6, 40, 24 * 60];
  const moves: Array<[string, Date]> = [];
  for (const id of noteIds) {
    let at = Date.UTC(2026, 2, 1, 9, 0, 0);
    let i = 0;
    for (const eventId of await eventsOf(id)) {
      at += gaps[i++ % gaps.length]! * 60_000;
      moves.push([eventId, new Date(at)]);
    }
  }
  // domain_events is append-only: a test that moves a save in time says so (as the History tests do)
  await allowUnstampedWrite("test: move saves in time", () => withTransaction(async () => {
    await q("SET LOCAL session_replication_role = replica");
    for (const [eventId, at] of moves) await q(`UPDATE domain_events SET created_at = $2 WHERE id = $1::bigint`, [eventId, at]);
    await q(ALIGN_VERSION_TIMES_SQL);
  }));
}

/** The saves people make after the upgrade, on notes `existing` (already holding history) and notes made now. */
async function newSaves(c: Ctx, existing: string[]) {
  const made: string[] = [];
  const note = async (title: string, markdown: string, extra: Record<string, unknown> = {}) => {
    const id = (await c.call("POST", "/api/nodes", { title, markdown, space_id: c.space, ...extra })).id as string;
    made.push(id);
    return id;
  };
  const patch = (id: string, body: Record<string, unknown>) => c.call("PATCH", `/api/nodes/${id}`, body);
  const firstEvent = async (id: string) => (await q<{ id: string }>(`SELECT min(id)::text AS id FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash'`, [id])).rows[0]!.id;

  // ordinary saves, a title-only save, a save by one actor then a pause (several sessions)
  const plain = await note("Ordinary", "# Ordinary\n\nfirst");
  for (const text of ["first, then second", "first, then second\n\nthird", "third only"]) await patch(plain, { markdown: text });
  await patch(plain, { title: "Ordinary (renamed)" }); // changes only the title
  await patch(plain, { markdown: "third only", base_markdown: "third only" }); // nothing changes: no event, no version
  // typed A, B, A (a repeat only joins the one right before it)
  const aba = await note("A B A", "A");
  for (const text of ["B", "A"]) await patch(aba, { markdown: text });
  // a restore of an old version, by its key and by the number of its event
  const byKey = await note("Restore by key", "one");
  await patch(byKey, { markdown: "one two" });
  await patch(byKey, { markdown: "one two three" });
  const keyed = (await listNoteVersions(c.ws, c.actor, byKey, { raw: true }))!;
  await c.call("POST", `/api/nodes/${byKey}/versions/${encodeURIComponent(String(keyed[keyed.length - 1]!.id))}/restore`, { restore_title: true });
  const byNumber = await note("Restore by number", "uno");
  await patch(byNumber, { markdown: "uno dos" });
  await c.call("POST", `/api/nodes/${byNumber}/versions/${await firstEvent(byNumber)}/restore`, {});
  // an undo of the restore, an undo of an ordinary save
  const undoRestore = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_RESTORED'`, [byNumber])).rows[0]!.id;
  expect("code" in (await restoreEvent(undoRestore, { actor: c.actor, workspaceId: c.ws }))).toBe(false);
  const undone = await note("Undo", "before");
  await patch(undone, { markdown: "before and after" });
  const lastSave = (await q<{ id: string }>(`SELECT max(id)::text AS id FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_UPDATED'`, [undone])).rows[0]!.id;
  expect("code" in (await restoreEvent(lastSave, { actor: c.actor, workspaceId: c.ws }))).toBe(false);
  // two saves in one transaction
  const twice = await note("Twice", "a");
  await withEventTransaction(c.ws, async () => {
    await updateNode(c.ws, twice, { markdown: "a b" }, { actor: c.actor });
    await updateNode(c.ws, twice, { markdown: "a b c" }, { actor: c.actor });
  });
  // a task made with a body
  await setModulesOn(c.ws, null);
  const task = await createTaskNode({ workspaceId: c.ws, actor: c.actor, hostId: null, spaceId: c.space, title: "Water plants", markdown: "the ones by the window", finishBody: finishNewNote });
  made.push(task);
  // drawings: handwriting saves (one repeated), a removal, the board's layer
  const sketch = await note("Sketch", "");
  for (const value of [drawing("a"), drawing("a", "b"), drawing("a", "b", "c")]) await c.call("PUT", `/api/nodes/${sketch}/attributes/ink_data`, { value });
  await c.call("PUT", `/api/nodes/${sketch}/attributes/ink_data`, { value: drawing("a", "b", "c") }); // the same drawing again
  await c.call("DELETE", `/api/nodes/${sketch}/attributes/ink_data`);
  await c.call("PUT", `/api/nodes/${sketch}/attributes/ink_data`, { value: drawing("z") });
  for (const value of [drawing("p"), drawing("p", "q")]) await c.call("PUT", `/api/nodes/${sketch}/attributes/board_ink`, { value });
  // a conflict that keeps the note's text puts the other text aside (an AI run's undo, a rewind's undo): set_aside versions, content the note never had
  const keptA = await note("Conflict, text kept", "a\nb\nc");
  await patch(keptA, { markdown: "a\nX\nc" });
  await updateNode(c.ws, keptA, { markdown: "a\nY\nc" }, { actor: c.actor, baseMarkdown: "a\nb\nc", keepOnConflict: "current" }); // nothing but the set-aside is written: it must not become the latest
  const keptB = await note("Conflict, text merged", "a\nb\nc");
  await patch(keptB, { markdown: "a\nX\nc" });
  await updateNode(c.ws, keptB, { markdown: "a\nY\nC" }, { actor: c.actor, baseMarkdown: "a\nb\nc", keepOnConflict: "current" }); // line 3 merges: a save and a set-aside in one transaction
  // a drawing a conflict put aside (migration 220 mints these from old conflict events): newest of all, and in no list of the drawing's saves
  await seedQ(`WITH blob AS (INSERT INTO blobs (hash, content, size_bytes) VALUES (encode(sha256(convert_to($3, 'UTF8')), 'hex'), $3, octet_length($3)) ON CONFLICT DO NOTHING)
               INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, content_hash, at, ordinal, recorded_by, author_kind)
               VALUES ($1::uuid, $2::uuid, 'ink_data', 'g:aside-' || $2, 'set_aside', encode(sha256(convert_to($3, 'UTF8')), 'hex'), note_version_at(now() + interval '1 hour'), 0,
                       (SELECT node_id FROM sync_node WHERE singleton), 'person')`, [c.ws, sketch, drawing("aside")]);
  // an AI's save, and a person's after it
  const agent = await persistActor(c.ws, { id: "", name: "Helper", type: "agent", role: "editor" });
  await seedQ(`UPDATE actors SET write_mode = 'apply' WHERE id = $1`, [agent.id]);
  await seedQ(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'edit') ON CONFLICT DO NOTHING`, [c.space, agent.id]);
  const byAi = await note("Written by an AI", "human line");
  await updateNode(c.ws, byAi, { markdown: "human line\nAI line" }, { actor: agent, baseMarkdown: "human line" });
  await patch(byAi, { markdown: "human line\nAI line\nhuman again" });
  // saves on the notes that already held history (a mix of old and new versions in one list)
  for (const id of existing) {
    await patch(id, { markdown: `${id.slice(0, 4)} after the upgrade` });
    await patch(id, { markdown: `${id.slice(0, 4)} after the upgrade, again` });
  }
  // a save the old server would have logged though nothing changed (an event with the text of the one before it, mapped to that version)
  await seedQ(
    `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta, external, created_at)
     SELECT workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta, external, created_at + interval '1 minute'
       FROM domain_events WHERE id = (SELECT max(id) FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash')`, [plain]);
  return made;
}

const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

// ---- on both engines: a fresh node ---------------------------------------------------------------------------------------------
describe.skipIf(!isTestDatabase())("the readers agree with the event readers: a node that saved after migration 220", () => {
  it("every note: list, latest version, the workspace at every day and version time, each version restored, drawings", async () => {
    const n = await openNode("readers-fresh");
    open.push(n);
    const world = await buildSourceWorld(n);
    await onNode(n, async () => {
      const c: Ctx = { ws: world.ws, actor: world.owner, space: world.spaceA, call: world.call };
      const made = await newSaves(c, []);
      await spreadTimes(made);
      await proof(c, made, "fresh");
    });
  }, 280_000);
});

// ---- PGlite: the copy an older app left, upgraded, then saved on ----------------------------------------------------------------
if (dbDriver === "pglite") describe.skipIf(!isTestDatabase())("the readers agree with the event readers: the old-copy tool's history copy, upgraded", () => {
  let dir = "";
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("the notes the copy holds, with the saves made after the upgrade on top of them", async () => {
    dir = mkdtempSync(join(tmpdir(), "readers-copy-"));
    const file = join(dir, "history.tar.gz");
    await promisify(execFile)("npx", ["tsx", "src/browser/makeOldCopy.ts", file, "history"], { cwd: backend, timeout: 280_000, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1", ONDEN_PGLITE_SNAPSHOT: "" } });
    const node = await RealNode.open("readers-old-copy", undefined, file);
    open.push(node);
    await onNode(node, async () => {
      await migrate({ seedNativeActor: false });
      const person = (await q<{ id: string; name: string; workspace_id: string }>(`SELECT id::text, name, workspace_id::text FROM actors WHERE type = 'human' ORDER BY created_at LIMIT 1`)).rows[0]!;
      const space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [person.id])).rows[0]!.id;
      const actor = { id: person.id, name: person.name, type: "human", role: "admin" } as ActorCtx;
      const c: Ctx = { ws: person.workspace_id, actor, space, call: makeCaller(actor) };
      const old = (await q<{ id: string }>(
        `SELECT n.id::text FROM content_nodes n WHERE n.workspace_id = $1 AND n.node_type IN ('content', 'canvas') AND n.source_type <> 'system' AND n.deleted_at IS NULL ORDER BY n.created_at`, [c.ws])).rows.map((r) => r.id);
      expect(old.length).toBeGreaterThan(5);
      // the copy as it is, before anything is saved on it: the legacy `g:` and `b:` versions alone
      await spreadTimes(old);
      await proof(c, (await q<{ id: string }>(`SELECT DISTINCT note_id::text AS id FROM note_versions WHERE workspace_id = $1`, [c.ws])).rows.map((r) => r.id), "copy");
      // then the saves people make afterwards, on those notes and on new ones
      const made = await newSaves(c, old.slice(0, 4));
      await spreadTimes([...old, ...made]);
      await proof(c, [...old, ...made], "copy + new saves");
    });
  }, 600_000);
});

afterAll(() => console.log(intendedDifferences()));
