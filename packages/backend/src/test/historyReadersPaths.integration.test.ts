// History-replication batch 2, the cases the row-for-row proof (historyReadersMatchEvents) does not walk:
//   * history carried in by a backup (importedHistory.ts) reads the same through the version tables as through the events it wrote;
//   * a version made on another device says so (the owner's wording: "on another device", no device names yet) in the list and in the raw list,
//     and restoring it is an ordinary restore that names it;
//   * a tag's description keeps its history list exactly as the event log gave it (the owner's rule: no version rows for tags yet);
//   * the old address of a version (the number of an event) still restores, through the route; a key restores; a stranger is 404;
//   * what the version list costs per request on a note with 500 versions, before (events) and after (versions).
// realPostgresAlso: the measured cost differs by engine, and the restore and the import run across two connections on a server
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHistoryFile } from "../services/backupHistory.js";
import { sha256Hex } from "../utils.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { q } from "../db.js";

vi.mock("../db.js", async (original) => {
  const { workspaceSwitch } = await import("./helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});
vi.mock("../services/workspaceId.js", async (original) => {
  const { workspaceSwitch } = await import("./helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../services/workspaceId.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});
import { putBlob } from "../services/blobs.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { listNoteVersions } from "../services/history/noteVersions.js";
import { listInkEdits } from "../services/history/inkChanges.js";
import { noteStatesAt } from "../services/history/pointInTime.js";
import { loadBodyVersion } from "../spine/noteVersions.js";
import { fullBackup } from "./helpers/roundTripApi.js";
import { moveInto, place, type Place } from "./helpers/backupMoveWorld.js";
import { ALIGN_VERSION_TIMES_SQL } from "./helpers/alignVersionTimes.js";
import { intendedDifferences, proof, type Ctx } from "./helpers/historyReadersProof.js";
import { legacyListNoteVersions, legacyNoteStatesAt } from "./helpers/legacyHistoryReaders.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { workspaceSwitch } from "./helpers/workspaceSwitch.js";
import { allowUnstampedWrite, withTransaction } from "../db.js";
import { saveOnDaySql, bodyEventSql } from "../services/history/bodyEvents.js";
import { sqlDayStart } from "../localDay.js";
import { recentVersions } from "../services/history/recentVersions.js";
import { listBodyHistoryRows } from "../services/nodeReads.js";
import { hasVersionList } from "../spine/noteVersions.js";

registerShippedModules();

const ctxOf = (p: Place): Ctx => ({ ws: p.ws, actor: p.owner, space: p.personal, call: (method, path, body) => { workspaceSwitch.ws = p.ws; return p.call(method, path, body); } });
const idOf = async (ws: string, title: string) =>
  (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL`, [ws, title])).rows[0]!.id;
type Listed = Array<{ id: string; markdown: string; title: string | null; on_another_device?: boolean; restored_from: string | null; markers: string[]; actor_kind: string }>;
const listed = async (p: Place, id: string, raw = false) => (await listNoteVersions(p.ws, p.owner, id, { raw }))! as unknown as Listed;

/** Move a note's saves in time: the events (append-only, so the test says so) and the versions that recorded them. */
const moveSaves = (pairs: Array<[string, Date]>) => allowUnstampedWrite("test: move saves in time", () => withTransaction(async () => {
  await q("SET LOCAL session_replication_role = replica");
  for (const [eventId, at] of pairs) await q(`UPDATE domain_events SET created_at = $2 WHERE id = $1::bigint`, [eventId, at]);
  await q(ALIGN_VERSION_TIMES_SQL);
}));

describe.skipIf(!isTestDatabase())("History reads the version tables (batch 2): carried history, other devices, tags, old numbers, cost", () => {
  let here: Place;
  beforeAll(async () => { here = await place("history-readers"); });
  afterAll(async () => { await awaitAllDispatchers(); workspaceSwitch.ws = ""; console.log(intendedDifferences()); });

  it("history a backup carried in reads as the events it wrote do: list, raw list, the workspace at each time, each version restored", async () => {
    const source = await place("readers-backup-source");
    const ids: string[] = [];
    for (const [title, texts] of [["Carried one", ["first", "first, second", "third"]], ["Carried two", ["alpha", "alpha beta"]]] as const) {
      const id = (await source.call("POST", "/api/nodes", { title, markdown: texts[0], space_id: source.personal })).id as string;
      for (const markdown of texts.slice(1)) await source.call("PATCH", `/api/nodes/${id}`, { markdown });
      ids.push(id);
    }
    await source.call("PATCH", `/api/nodes/${ids[0]}`, { title: "Carried one, renamed" });
    const first = (await q<{ id: string }>(`SELECT min(id)::text AS id FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash'`, [ids[1]])).rows[0]!.id;
    await source.call("POST", `/api/nodes/${ids[1]}/versions/${first}/restore`, {});
    const target = await place("readers-backup-target");
    const job = await moveInto(target, await fullBackup(source.ws, source.owner, "history=1"));
    expect(job.status, JSON.stringify(job.error)).toBe("done");
    const carried = [await idOf(target.ws, "Carried one, renamed"), await idOf(target.ws, "Carried two")];
    workspaceSwitch.ws = target.ws;
    // the carried saves keep the source's author names (a source name, not the person who moved them in), as the list always said
    expect((await listed(target, carried[0]!, true)).length).toBeGreaterThanOrEqual(3);
    await proof(ctxOf(target), carried, "carried history");
  }, 240_000);

  it("a version made on another device says so, in the list and in the raw list; restoring it names it, and the restore is this device's", async () => {
    const c = ctxOf(here);
    const id = (await c.call("POST", "/api/nodes", { title: "Two devices", markdown: "written here", space_id: here.personal })).id as string;
    await c.call("PATCH", `/api/nodes/${id}`, { markdown: "written here, again" });
    // a version another device minted, between this device's two saves (nothing arrives from another device yet: it is put in by hand, as a received one will be)
    const hash = await putBlob("written on the other device");
    const key = "s:other-node:7:1";
    await seedQ(
      `INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, title, content_hash, at, clock_wall, clock_counter, ordinal, recorded_by, author_kind)
       SELECT workspace_id, note_id, 'body', $2, 'updated', 'Two devices', $3, note_version_at(min(at::timestamptz) + (max(at::timestamptz) - min(at::timestamptz)) / 2),
              min(clock_wall) + 1, 5, 1, 'other-node', 'person' FROM note_versions WHERE note_id = $1 GROUP BY workspace_id, note_id`, [id, key, hash]);
    const merged = await listed(here, id);
    expect(merged.map((r) => [r.markdown, r.on_another_device ?? false])).toEqual([["written here, again", false], ["written on the other device", true], ["written here", false]]);
    expect(merged[1]!.id).toBe(key);
    const raw = await listed(here, id, true);
    expect(raw.map((r) => [r.id === key, r.on_another_device ?? false])).toEqual([[false, false], [true, true], [false, false]]);
    // the recent feed says it too, and so does a drawing's edit list (review of PR #1948, B8)
    const recentRows = (await recentVersions(here.owner, here.ws, { limit: 200, offset: 0 }) as unknown as { rows: Array<{ id: string; on_another_device: boolean }> }).rows;
    expect(recentRows.find((r) => r.id === key)?.on_another_device).toBe(true);
    expect(recentRows.filter((r) => r.id !== key && r.on_another_device)).toEqual([]);
    const drawn = JSON.stringify({ v: 1, strokes: [{ id: "a", points: [[0, 0], [4, 4]] }] });
    await c.call("PUT", `/api/nodes/${id}/attributes/ink_data`, { value: drawn });
    const elsewhereDrawing = JSON.stringify({ v: 1, strokes: [{ id: "a", points: [[0, 0], [4, 4]] }, { id: "z", points: [[1, 1], [9, 9]] }] });
    const inkHash = await putBlob(elsewhereDrawing);
    await seedQ(`INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, content_hash, at, clock_wall, clock_counter, ordinal, recorded_by, author_kind)
                 SELECT workspace_id, note_id, 'ink_data', 's:other-node:9:1', 'updated', $2, note_version_at(now() + interval '30 minutes'), max(coalesce(clock_wall, 0)) + 10, 0, 1, 'other-node', 'person'
                   FROM note_versions WHERE note_id = $1 AND unit = 'ink_data' GROUP BY workspace_id, note_id`, [id, inkHash]);
    const edits = (await listInkEdits(here.ws, here.owner, id, "handwriting"))!;
    expect(edits.map((e) => e.on_another_device ?? false)).toEqual([true, false]);
    // it restores like any other version: the restore is written here, names it, and carries no mark
    await c.call("POST", `/api/nodes/${id}/versions/${encodeURIComponent(key)}/restore`, {});
    const after = await listed(here, id);
    expect(after[0]).toMatchObject({ markdown: "written on the other device", restored_from: key, markers: expect.arrayContaining(["restored"]) });
    expect(after[0]!.on_another_device).toBeUndefined();
    expect(after[2]!.id).toBe(key);
    // the event it left names no event of the other device (it has none here), and the version it minted names the version it put back
    const restoreEvent = (await q<{ payload: Record<string, unknown> }>(`SELECT payload FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_RESTORED'`, [id])).rows[0]!;
    expect(restoreEvent.payload.version_id).toBeUndefined();
    expect((await q<{ restored_from: string }>(`SELECT restored_from FROM note_versions WHERE note_id = $1 AND kind = 'restored'`, [id])).rows[0]!.restored_from).toBe(key);
  }, 120_000);

  it("a tag's description keeps its history list exactly as the event log gave it, and has no version rows", async () => {
    const c = ctxOf(here);
    const tag = (await c.call("POST", "/api/tags", { name: `described-${randomUUID().slice(0, 6)}` })).id as string;
    for (const markdown of ["a tag is a word", "a tag is a word that groups notes", "a tag is a word that groups notes together"]) await c.call("PATCH", `/api/nodes/${tag}`, { markdown });
    const firstSave = (await q<{ id: string }>(`SELECT min(id)::text AS id FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash'`, [tag])).rows[0]!.id;
    await c.call("POST", `/api/nodes/${tag}/versions/${firstSave}/restore`, {}); // by the number of an event, as for a tag always
    await c.call("PATCH", `/api/nodes/${tag}`, { markdown: "after the restore" });
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM note_versions WHERE note_id = $1`, [tag])).rows[0]!.n)).toBe(0);
    for (const raw of [false, true]) {
      const before = await legacyListNoteVersions(here.ws, tag, { raw });
      const now = (await listNoteVersions(here.ws, here.owner, tag, { raw }))!;
      expect(before.length).toBeGreaterThanOrEqual(3);
      expect(now, raw ? "raw list" : "merged list").toEqual(before); // every field, ids included: the numbers of events
      expect(now.every((r) => /^\d+$/.test(String(r.id)))).toBe(true);
      expect(now.every((r) => !("on_another_device" in r))).toBe(true);
    }
    // the other readers of a tag's description keep reading its events: the light history, the recent feed, a day's edits
    const heads = await listBodyHistoryRows(here.owner, here.ws, tag);
    const eventHeads = (await q<{ id: string; title: string | null }>(`SELECT e.id::text AS id, e.payload->>'title' AS title FROM domain_events e WHERE e.target_id = $1 AND ${bodyEventSql("e")} ORDER BY e.created_at DESC, e.id DESC LIMIT 50`, [tag])).rows;
    expect(heads!.map((r) => [String(r.id), r.title]), "/:id/history of a tag").toEqual(eventHeads.map((r) => [r.id, r.title]));
    expect(eventHeads.length).toBeGreaterThanOrEqual(3);
    const recent = await recentVersions(here.owner, here.ws, { limit: 200, offset: 0 }) as unknown as { rows: Array<{ id: string; node_id: string }> };
    expect(recent.rows.filter((r) => r.node_id === tag).map((r) => r.id).sort(), "the recent feed lists a tag's saves by event number").toEqual(eventHeads.map((r) => r.id).sort());
    const today = (await q<{ d: string }>(`SELECT current_date::text AS d`)).rows[0]!.d;
    expect((await q(`SELECT 1 FROM ${saveOnDaySql("$1", "$2::date")} e WHERE e.target_id = $3`, [here.ws, today, tag])).rows.length, "a day's edits count a tag's saves").toBeGreaterThanOrEqual(3);
    // a system note (a content note the system owns): no version rows either; its saves are events
    const sys = (await seedQ<{ id: string }>(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, 'system', 'content', 'System text', $2, 'second') RETURNING id::text`, [here.ws, `sys-${randomUUID()}`])).rows[0]!.id;
    for (const text of ["first", "second"]) {
      const hash = await putBlob(text);
      await seedQ(`INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload) VALUES ($1, 'user', $2, 'NODE_UPDATED', 'node', $3, jsonb_build_object('title', 'System text', 'body_hash', $4::text))`, [here.ws, here.owner.id, sys, hash]);
    }
    expect(await hasVersionList(here.ws, sys), "a system note has no version list").toBe(false);
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM note_versions WHERE note_id = $1`, [sys])).rows[0]!.n)).toBe(0);
    const sysRecent = (await recentVersions(here.owner, here.ws, { limit: 200, offset: 0 }) as unknown as { rows: Array<{ node_id: string }> }).rows.filter((r) => r.node_id === sys);
    expect(sysRecent, "the recent feed lists a system note's saves").toHaveLength(2);
    expect((await q(`SELECT 1 FROM ${saveOnDaySql("$1", "$2::date")} e WHERE e.target_id = $3`, [here.ws, today, sys])).rows.length, "a day's edits count a system note's saves").toBe(2);
    const sysList = await listNoteVersions(here.ws, here.owner, sys, { raw: true });
    if (sysList !== null) expect(sysList, "a system note's list").toEqual(await legacyListNoteVersions(here.ws, sys, { raw: true }));
    expect((await listBodyHistoryRows(here.owner, here.ws, sys))?.length ?? 2, "/:id/history of a system note").toBe(2);
  }, 120_000);

  it("a baseline says what it is and is no day's edit; a set-aside text is in no reader that answers what the note was like (review of PR #1948, A1, B4)", async () => {
    const c = ctxOf(here);
    const id = (await c.call("POST", "/api/nodes", { title: "Aside", markdown: "one", space_id: here.personal })).id as string;
    await c.call("PATCH", `/api/nodes/${id}`, { markdown: "one two" });
    const base = await putBlob("the content before any save");
    const aside = await putBlob("one TWO, a text the note never had");
    const stored = (hash: string, key: string, kind: string, at: string) => seedQ(
      `INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, title, content_hash, at, ordinal, recorded_by, author_kind)
       VALUES ($1::uuid, $2::uuid, 'body', $3, $4, 'Aside', $5, note_version_at($6::timestamptz), 0, (SELECT node_id FROM sync_node WHERE singleton), $7)`,
      [here.ws, id, key, kind, hash, at, kind === "baseline" ? "automatic" : "person"]);
    await stored(base, "b:test-baseline", "baseline", "2020-01-01T00:00:00Z");
    await stored(aside, "g:test-aside", "set_aside", new Date(Date.now() + 3_600_000).toISOString());
    // the list: the baseline is the oldest row and says so; the set-aside text is nowhere, and the newest row is the note's own
    const merged = await listed(here, id);
    expect(merged.map((r) => r.markdown)).toEqual(["one two", "one", "the content before any save"]);
    expect(merged[2]!.markers).toContain("baseline");
    expect((await listed(here, id, true)).map((r) => r.markdown)).toEqual(["one two", "one", "the content before any save"]);
    expect((await listBodyHistoryRows(here.owner, here.ws, id))!.map((r) => r.id)).not.toContain("g:test-aside");
    // "the note at T": now, and a day long ago (the baseline's own time), never the set-aside
    const nowStates = await noteStatesAt(here.owner, here.ws, new Date(Date.now() + 7_200_000), {}, id);
    expect(nowStates.find((s) => s.id === id)?.title_then).toBe("Aside");
    const hashes = (at: Date) => noteStatesAt(here.owner, here.ws, at, {}, id).then((rows) => rows.find((s) => s.id === id)?.body_hash_then);
    expect(await hashes(new Date(Date.now() + 7_200_000))).toBe(sha256Hex("one two"));
    expect(await hashes(new Date("2020-06-01T00:00:00Z"))).toBe(sha256Hex("the content before any save"));
    // the recent feed and a day's edits: only the two real saves
    const recent = (await recentVersions(here.owner, here.ws, { limit: 200, offset: 0 }) as unknown as { rows: Array<{ id: string; node_id: string }> }).rows.filter((r) => r.node_id === id);
    expect(recent).toHaveLength(2);
    const today = (await q<{ d: string }>(`SELECT current_date::text AS d`)).rows[0]!.d;
    expect((await q(`SELECT 1 FROM ${saveOnDaySql("$1", "$2::date")} e WHERE e.target_id = $3`, [here.ws, today, id])).rows).toHaveLength(2);
    // a backup carries the note's states, not the put-aside text
    const dir = mkdtempSync(join(tmpdir(), "aside-"));
    try {
      await writeHistoryFile(here.ws, id, join(dir, "h.jsonl"));
      const texts = readFileSync(join(dir, "h.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { markdown: string }).markdown);
      expect(texts).toEqual(["the content before any save", "one", "one two"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);

  it("an undo whose result names no version still has its own row in the list, as it had when the events were read (review of PR #1948, round 3)", async () => {
    const c = ctxOf(here);
    const id = (await c.call("POST", "/api/nodes", { title: "Undo row", markdown: "one", space_id: here.personal })).id as string;
    await c.call("PATCH", `/api/nodes/${id}`, { markdown: "one two" });
    // the second save is an undo's write (tx_meta.restored_from) whose text no earlier version holds: migration 220 and the local write path give it no `restored_from`
    const undoEvent = (await q<{ id: string }>(`SELECT max(id)::text AS id FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash'`, [id])).rows[0]!.id;
    await allowUnstampedWrite("test: an undo's event", () => withTransaction(async () => {
      await q("SET LOCAL session_replication_role = replica");
      await q(`UPDATE domain_events SET tx_meta = tx_meta || '{"restored_from": "1"}'::jsonb WHERE id = $1::bigint`, [undoEvent]);
    }));
    await c.call("PATCH", `/api/nodes/${id}`, { markdown: "one two three" }); // the same author, within five minutes
    const stored = (await q<{ restored_from: string | null; kind: string }>(`SELECT restored_from, kind FROM note_versions WHERE note_id = $1 AND unit = 'body' ORDER BY ordinal`, [id])).rows;
    expect(stored.every((v) => v.restored_from === null), "no version names what the undo put back").toBe(true);
    const merged = await listed(here, id);
    expect(merged.map((r) => r.markdown), "the undo is a row of its own").toEqual(["one two three", "one two", "one"]);
    expect(merged.map((r) => r.markers.includes("restored")), "and it says it is a restore").toEqual([false, true, false]);
    await proof(c, [id], "an undo that names no version");
  }, 120_000);

  it("the old address of a version still restores through the route (the number of its event); a key restores; an unknown name is 404", async () => {
    const c = ctxOf(here);
    const id = (await c.call("POST", "/api/nodes", { title: "Addresses", markdown: "one", space_id: here.personal })).id as string;
    await c.call("PATCH", `/api/nodes/${id}`, { markdown: "two" });
    await c.call("PATCH", `/api/nodes/${id}`, { markdown: "three" });
    const [firstEvent, secondEvent] = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash' ORDER BY domain_events.id`, [id])).rows.map((r) => r.id);
    const byNumber = await c.call("POST", `/api/nodes/${id}/versions/${firstEvent}/restore`, {});
    expect(byNumber.markdown).toBe("one");
    const keys = (await listed(here, id, true)).map((r) => r.id);
    const keyOfTwo = (await loadBodyVersion(here.ws, id, secondEvent!))!.key;
    expect(keys).toContain(keyOfTwo);
    const byKey = await c.call("POST", `/api/nodes/${id}/versions/${encodeURIComponent(keyOfTwo)}/restore`, {});
    expect(byKey.markdown).toBe("two");
    // the restore event names the number of the event that recorded the version, as before; the version names the version
    const events = (await q<{ payload: { version_id?: string } }>(`SELECT payload FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_RESTORED' ORDER BY domain_events.id`, [id])).rows;
    expect(events.map((e) => e.payload.version_id)).toEqual([firstEvent, secondEvent]);
    for (const stranger of ["s:nobody:1:1", "g:0000", "999999999", "not-a-version", `${firstEvent}`.replace(/\d/, "9") + "0000"]) {
      await expect(c.call("POST", `/api/nodes/${id}/versions/${encodeURIComponent(stranger)}/restore`, {}), stranger).rejects.toThrow(/404/);
    }
    // another note's version is no version of this one (the key is the note's own address)
    const other = (await c.call("POST", "/api/nodes", { title: "Another", markdown: "elsewhere", space_id: here.personal })).id as string;
    const otherKey = (await listed(here, other, true))[0]!.id;
    await expect(c.call("POST", `/api/nodes/${id}/versions/${encodeURIComponent(otherKey)}/restore`, {})).rejects.toThrow(/404/);
  }, 120_000);

  it("what the version list costs per request on a note with 500 versions: events before, versions after", async () => {
    const c = ctxOf(here);
    const id = (await c.call("POST", "/api/nodes", { title: "Five hundred", markdown: "0", space_id: here.personal })).id as string;
    for (let i = 1; i < 500; i++) await c.call("PATCH", `/api/nodes/${id}`, { markdown: `version ${i} of the note\n\n${"line of text ".repeat(i % 7)}` });
    // 500 versions in 7-minute steps (a session each, with a few merged), over about two and a half days
    const events = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash' ORDER BY domain_events.id`, [id])).rows.map((r) => r.id);
    expect(events).toHaveLength(500);
    let clock = Date.UTC(2026, 2, 1, 9, 0, 0);
    await moveSaves(events.map((e, i) => [e, new Date(clock += (i % 5 === 0 ? 7 : 2) * 60_000)] as [string, Date]));
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM note_versions WHERE note_id = $1 AND unit = 'body'`, [id])).rows[0]!.n)).toBe(500);
    const timed = async (label: string, work: () => Promise<unknown>) => {
      await work(); // a first call warms the plan and the cache
      const runs: number[] = [];
      for (let i = 0; i < 7; i++) { const t = performance.now(); await work(); runs.push(performance.now() - t); }
      runs.sort((a, b) => a - b);
      return { label, median: Math.round(runs[3]! * 10) / 10, slowest: Math.round(runs[6]! * 10) / 10 };
    };
    const rows = [
      { ...await timed("version list, merged  — events (before)", () => legacyListNoteVersions(here.ws, id, { raw: false })), reader: "before" },
      { ...await timed("version list, merged  — versions (after)", () => listNoteVersions(here.ws, here.owner, id, { raw: false })), reader: "after" },
      { ...await timed("raw list (newest 50) — events (before)", () => legacyListNoteVersions(here.ws, id, { raw: true })), reader: "before" },
      { ...await timed("raw list (newest 50) — versions (after)", () => listNoteVersions(here.ws, here.owner, id, { raw: true })), reader: "after" },
      { ...await timed("the workspace at T, this note — events (before)", () => legacyNoteStatesAt(here.owner, here.ws, new Date(Date.UTC(2026, 2, 2)), {}, id)), reader: "before" },
      { ...await timed("the workspace at T, this note — versions (after)", () => noteStatesAt(here.owner, here.ws, new Date(Date.UTC(2026, 2, 2)), {}, id)), reader: "after" },
    ];
    console.log(`[history readers] per-request cost, a note with 500 versions, ms (median / slowest of 7), ${process.env.ONDEN_DB_DRIVER === "pglite" || !process.env.DATABASE_URL?.startsWith("postgres://") ? "PGlite" : "real Postgres"}:\n${rows.map((r) => `  ${r.label}: ${r.median} / ${r.slowest}`).join("\n")}`);
    // the answers agree (the proof test checks every note; this one pins the note the numbers are for)
    const [before, after] = [(await legacyListNoteVersions(here.ws, id, { raw: false })) as Array<{ markdown: string; saves: number }>, (await listNoteVersions(here.ws, here.owner, id, { raw: false }))! as Array<{ markdown: string; saves: number }>];
    expect(after.map((r) => [r.markdown, r.saves])).toEqual(before.map((r) => [r.markdown, r.saves]));
    for (const r of rows.filter((x) => x.reader === "after")) expect(r.median, r.label).toBeLessThan(2000); // a sanity bound, not the measurement
  }, 280_000);

  it("what the reads that cut by time cost over a whole workspace of 15,000 saves: events before, versions after (no index on the time: migration 220 has none)", async () => {
    const p = await place("history-scale");
    const c = ctxOf(p);
    workspaceSwitch.ws = p.ws;
    const run = (text: string, params: unknown[] = []) => q(text, params);
    await allowUnstampedWrite("test: 1,500 notes with ten saves each", () => withTransaction(async () => {
      // rows by the thousand, written with the triggers off (the commit checks run per row and are measured elsewhere); the event map is written below
      await run("SET LOCAL session_replication_role = replica");
      await run(`CREATE TEMP TABLE scale_notes ON COMMIT DROP AS
                 WITH made AS (INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
                               SELECT $1, 'manual', 'content', 'scale ' || i, 'scale-' || i || '-' || $2, '' FROM generate_series(1, 1500) i RETURNING id, title)
                 SELECT id, title FROM made`, [p.ws, randomUUID().slice(0, 8)]);
      await run(`CREATE TEMP TABLE scale_saves ON COMMIT DROP AS
                 SELECT n.id AS note, n.title, k, 'text of ' || n.title || ' at ' || k AS txt,
                        timestamptz '2026-03-01 09:00:00+00' + (k * interval '1 day') + ((abs(hashtext(n.id::text)) % 600) * interval '1 minute') AS at
                   FROM scale_notes n CROSS JOIN generate_series(1, 10) k`);
      await run(`INSERT INTO blobs (hash, content, size_bytes) SELECT DISTINCT encode(sha256(convert_to(txt, 'UTF8')), 'hex'), txt, octet_length(txt) FROM scale_saves ON CONFLICT (hash) DO NOTHING`);
      await run(`INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, title, content_hash, at, ordinal, recorded_by, author_kind, author_id)
                 SELECT $1::uuid, note, 'body', note_version_legacy_key(note, 'body', 'updated', encode(sha256(convert_to(txt, 'UTF8')), 'hex'), title, note_version_at(at)), 'updated', title,
                        encode(sha256(convert_to(txt, 'UTF8')), 'hex'), note_version_at(at), k, (SELECT node_id FROM sync_node WHERE singleton), 'person', $2::uuid FROM scale_saves`, [p.ws, p.owner.id]);
      await run(`INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, created_at)
                 SELECT $1::uuid, 'user', $2, 'NODE_UPDATED', 'node', note::text, jsonb_build_object('title', title, 'body_hash', encode(sha256(convert_to(txt, 'UTF8')), 'hex')), at FROM scale_saves ORDER BY at`, [p.ws, p.owner.id]);
      await run(`INSERT INTO note_version_events (event_id, note_id, unit, version_key)
                 SELECT e.id, e.target_id::uuid, 'body', v.version_key FROM domain_events e
                   JOIN note_versions v ON v.note_id = e.target_id::uuid AND v.unit = 'body' AND v.content_hash = e.payload->>'body_hash' WHERE e.workspace_id = $1::uuid AND e.target_id IN (SELECT note::text FROM scale_saves)`, [p.ws]);
    }));
    // what autovacuum does on a server before anyone reads: the planner knows how many rows these tables hold
    for (const table of ["content_nodes", "blobs", "domain_events", "note_versions", "note_version_events"]) await q(`ANALYZE ${table}`);
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM note_version_events ve JOIN note_versions v ON v.note_id = ve.note_id AND v.version_key = ve.version_key WHERE v.workspace_id = $1`, [p.ws])).rows[0]!.n)).toBe(15_000);
    const timed = async (label: string, work: () => Promise<unknown>) => {
      await work();
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) { const t = performance.now(); await work(); runs.push(performance.now() - t); }
      runs.sort((a, b) => a - b);
      return `  ${label}: ${Math.round(runs[2]! * 10) / 10} / ${Math.round(runs[4]! * 10) / 10}`;
    };
    const cut = new Date(Date.UTC(2026, 2, 6, 12));
    const day = "2026-03-06";
    const oldDay = `SELECT n.id, max(e.created_at) FROM domain_events e JOIN content_nodes n ON n.id::text = e.target_id AND n.workspace_id = e.workspace_id
                    WHERE e.workspace_id = $1 AND e.target_type = 'node' AND ${bodyEventSql("e")} AND e.created_at >= ${sqlDayStart("$2::date")} AND e.created_at < ${sqlDayStart("$2::date + 1")} GROUP BY n.id`;
    const newDay = `SELECT n.id, max(e.created_at) FROM ${saveOnDaySql("$1", "$2::date")} e JOIN content_nodes n ON n.id::text = e.target_id AND n.workspace_id = e.workspace_id
                    WHERE e.workspace_id = $1 AND e.target_type = 'node' GROUP BY n.id`;
    expect((await q(oldDay, [p.ws, day])).rows.length).toBe((await q(newDay, [p.ws, day])).rows.length);
    const oldRecent = `SELECT e.id, e.target_id AS node_id, (e.payload->>'title') AS title, e.created_at AS changed_at, n.title AS current_title, n.slug FROM domain_events e JOIN content_nodes n ON n.id::text = e.target_id
                       WHERE e.workspace_id = $1 AND ${bodyEventSql("e")} ORDER BY e.created_at DESC, e.id DESC LIMIT 51`;
    const lines = [
      await timed("the workspace at T, all 1,500 notes — events (before)", () => legacyNoteStatesAt(c.actor, p.ws, cut)),
      await timed("the workspace at T, all 1,500 notes — versions (after)", () => noteStatesAt(c.actor, p.ws, cut)),
      await timed("a day's edited notes (day lens) — events (before)", () => q(oldDay, [p.ws, day])),
      await timed("a day's edited notes (day lens) — versions (after)", () => q(newDay, [p.ws, day])),
      await timed("recent versions, one page of 50 — events (before)", () => q(oldRecent, [p.ws])),
      await timed("recent versions, one page of 50 — versions (after)", () => recentVersions(c.actor, p.ws, { limit: 50, offset: 0 })),
    ];
    console.log(`[history readers] per-request cost over a workspace of 1,500 notes x 10 saves, ms (median / slowest of 5), ${process.env.DATABASE_URL?.startsWith("postgres://x@") || process.env.ONDEN_DB_DRIVER === "pglite" ? "PGlite" : "real Postgres"}:\n${lines.join("\n")}`);
    // the answer agrees (the proof compares every note; here the workspace the numbers are for)
    expect(JSON.stringify(await noteStatesAt(c.actor, p.ws, cut))).toBe(JSON.stringify(await legacyNoteStatesAt(c.actor, p.ws, cut)));
  }, 280_000);
});
