// A text a conflict put aside (`set_aside`) is content the note NEVER had. Every reader of note_versions answers a question about the note's states, so none of
// them may show it, cut to it, restore it, count it as a day's edit or carry it in a backup (review of PR #1948, rounds 1 and 2).
// The guarantee is behavioural, not a scan of the source: ONE fixture with a set-aside text as the newest version of a note's text and of its drawing is fed to
// EVERY exported reader (the table READERS below); a reader that forgets the rule (spine/noteVersions.ts STATE_VERSION_SQL) shows the text and the test fails.
// A reader added to services/history without a row here is the reviewer's question to ask; the table is the list.
// Then the one place where the leak is not just a wrong picture but a wrong WRITE: a rewind and its undo (the undo puts back "the version before the step").
// realPostgresAlso: the rewind and its undo run in event transactions on two connections on a server
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { measureHistory, writeHistoryFile } from "../services/backupHistory.js";
import { listNoteVersions } from "../services/history/noteVersions.js";
import { bodyBefore, listBodyVersionHeads } from "../services/history/storedVersions.js";
import { dayInkChanges, inkChangeValues, listInkEdits, restoreInkVersion } from "../services/history/inkChanges.js";
import { noteStatesAt } from "../services/history/pointInTime.js";
import { recentVersions } from "../services/history/recentVersions.js";
import { rewindWorkspace, undoRewind } from "../services/history/rewind.js";
import { saveOnDaySql } from "../services/history/bodyEvents.js";
import { listBodyHistoryRows, listInkVersionRows } from "../services/nodeReads.js";
import { updateNode } from "../services/nodeUpdate.js";
import { loadBodyVersion } from "../spine/noteVersions.js";
import { allowUnstampedWrite, withTransaction } from "../db.js";
import { importNoteHistory } from "../services/backupHistory.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { sha256Hex } from "../utils.js";
import { ALIGN_VERSION_TIMES_SQL } from "./helpers/alignVersionTimes.js";
import { place, type Place } from "./helpers/backupMoveWorld.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { workspaceSwitch } from "./helpers/workspaceSwitch.js";

registerShippedModules();

const HOUR = 3_600_000;
const ASIDE = "a\nY\nc";
const REAL = ["a\nb\nc", "a\nX\nc", "a\nX\nc\nlater"];
const drawing = (...ids: string[]) => JSON.stringify({ v: 1, strokes: ids.map((id, i) => ({ id, points: [[i, i], [i + 4, i + 4]] })) });
const ASIDE_INK = drawing("put-aside");

describe.skipIf(!isTestDatabase())("a text a conflict put aside is in no History reader (review of PR #1948)", () => {
  let here: Place;
  let note = "";
  let sketch = "";
  let asideKey = "";
  let asideInkKey = "";
  let realKeys: string[] = [];
  const T = new Date(Date.now() - HOUR);

  /** The events of `ids` made after T go back to `minutesBeforeT` before T, and their versions follow. */
  const inThePast = (ids: string[], minutesBeforeT: number) => allowUnstampedWrite("test: move saves in time", () => withTransaction(async () => {
    await q("SET LOCAL session_replication_role = replica");
    await q(`UPDATE domain_events SET created_at = $2 WHERE target_id = ANY($1::text[]) AND created_at > $3`, [ids, new Date(T.getTime() - minutesBeforeT * 60_000), T]);
    await q(ALIGN_VERSION_TIMES_SQL);
  }));

  /** A note whose text was REAL[0], REAL[1] (before T), REAL[2] (now), then a conflict that kept the current text and put ASIDE away: the set-aside is the newest version. */
  const asideNote = async (title: string) => {
    const id = (await here.call("POST", "/api/nodes", { title, markdown: REAL[0], space_id: here.personal })).id as string;
    await here.call("PATCH", `/api/nodes/${id}`, { markdown: REAL[1] });
    await inThePast([id], 5); // the note read REAL[1] at T
    await here.call("PATCH", `/api/nodes/${id}`, { markdown: REAL[2] });
    await updateNode(here.ws, id, { markdown: ASIDE }, { actor: here.owner, baseMarkdown: REAL[0], keepOnConflict: "current" });
    return id;
  };

  beforeAll(async () => {
    here = await place("history-set-aside");
    workspaceSwitch.ws = here.ws;
    const call = here.call;
    note = await asideNote("Aside");
    sketch = (await call("POST", "/api/nodes", { title: "Sketch", markdown: "", space_id: here.personal })).id as string;
    for (const value of [drawing("a"), drawing("a", "b")]) await call("PUT", `/api/nodes/${sketch}/attributes/ink_data`, { value });
    await seedQ(`WITH blob AS (INSERT INTO blobs (hash, content, size_bytes) VALUES (encode(sha256(convert_to($3, 'UTF8')), 'hex'), $3, octet_length($3)) ON CONFLICT DO NOTHING)
                 INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, content_hash, at, ordinal, recorded_by, author_kind)
                 VALUES ($1::uuid, $2::uuid, 'ink_data', 'g:aside-' || $2, 'set_aside', encode(sha256(convert_to($3, 'UTF8')), 'hex'), note_version_at(now() + interval '1 hour'), 0,
                         (SELECT node_id FROM sync_node WHERE singleton), 'person')`, [here.ws, sketch, ASIDE_INK]);
    const kinds = async (id: string, unit: string) => (await q<{ key: string; kind: string }>(`SELECT version_key AS key, kind FROM note_versions WHERE note_id = $1 AND unit = $2`, [id, unit])).rows;
    const body = await kinds(note, "body");
    asideKey = body.find((r) => r.kind === "set_aside")!.key;
    realKeys = body.filter((r) => r.kind !== "set_aside").map((r) => r.key);
    asideInkKey = (await kinds(sketch, "ink_data")).find((r) => r.kind === "set_aside")!.key;
    expect(asideKey, "the fixture has a set-aside text").toBeTruthy();
    expect(realKeys.length).toBeGreaterThanOrEqual(3);
  }, 120_000);
  afterAll(async () => { await awaitAllDispatchers(); workspaceSwitch.ws = ""; });

  /** What each reader shows of the note's text or drawing: every string it exposes (a text, a drawing, a key, a hash). Nothing here may be the set-aside one. */
  const READERS: Array<[string, () => Promise<unknown>]> = [
    ["version list, merged", () => listNoteVersions(here.ws, here.owner, note, { raw: false })],
    ["version list, raw", () => listNoteVersions(here.ws, here.owner, note, { raw: true })],
    ["the light list (/:id/history)", () => listBodyHistoryRows(here.owner, here.ws, note)],
    ["the heads of the stored versions", () => listBodyVersionHeads(here.ws, note, 50)],
    ["the version before the newest real one", async () => bodyBefore(here.ws, note, realKeys[realKeys.length - 1]!)],
    ["the note at a time long after (this note)", async () => (await noteStatesAt(here.owner, here.ws, new Date(Date.now() + 2 * HOUR), {}, note)).filter((s) => s.id === note)],
    ["the workspace at a time long after", async () => (await noteStatesAt(here.owner, here.ws, new Date(Date.now() + 2 * HOUR), {})).filter((s) => s.id === note)],
    ["the recent feed", async () => (await recentVersions(here.owner, here.ws, { limit: 200, offset: 0 }) as unknown as { rows: Array<{ node_id: string }> }).rows.filter((r) => r.node_id === note)],
    ["a day's edits", async () => (await q(`SELECT e.* FROM ${saveOnDaySql("$1", "$2::date")} e WHERE e.target_id = $3`, [here.ws, (await q<{ d: string }>(`SELECT current_date::text AS d`)).rows[0]!.d, note])).rows],
    ["the version restored by its key", () => loadBodyVersion(here.ws, note, asideKey)],
    ["the backup's file", async () => {
      const dir = mkdtempSync(join(tmpdir(), "aside-reader-"));
      try { await writeHistoryFile(here.ws, note, join(dir, "h.jsonl")); return readFileSync(join(dir, "h.jsonl"), "utf8"); } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
    ["the backup's measure", async () => measureHistory(here.ws, [note])],
    ["a drawing's versions", () => listInkVersionRows(here.owner, here.ws, sketch, "handwriting")],
    ["a drawing's edits", () => listInkEdits(here.ws, here.owner, sketch, "handwriting")],
    ["a drawing's day change", async () => [...(await dayInkChanges(here.ws, [{ nodeId: sketch, day: (await q<{ d: string }>(`SELECT current_date::text AS d`)).rows[0]!.d }], "handwriting")).values()]],
    ["a drawing's two pictures behind the set-aside key", () => inkChangeValues(here.ws, here.owner, sketch, "handwriting", null, asideInkKey)],
    ["the drawing restored by the set-aside key", () => restoreInkVersion(here.ws, here.owner, sketch, "handwriting", asideInkKey)],
  ];

  it.each(READERS)("%s never shows the text or the key that was put aside", async (_name, read) => {
    const shown = JSON.stringify(await read() ?? null);
    for (const leaked of [ASIDE, JSON.stringify(ASIDE), asideKey, sha256Hex(ASIDE), ASIDE_INK, JSON.stringify(ASIDE_INK), asideInkKey, sha256Hex(ASIDE_INK)]) {
      expect(shown.includes(leaked), `leaked ${leaked.slice(0, 40)}`).toBe(false);
    }
  });

  it("the readers that say how many show only the real states", async () => {
    expect((await listNoteVersions(here.ws, here.owner, note, { raw: true }))!.map((r) => (r as { markdown: string }).markdown)).toEqual([...REAL].reverse());
    expect((await measureHistory(here.ws, [note])).versions).toBe(REAL.length);
    expect(((await recentVersions(here.owner, here.ws, { limit: 200, offset: 0 }) as unknown as { rows: Array<{ node_id: string }> }).rows.filter((r) => r.node_id === note))).toHaveLength(REAL.length);
    // the saves were moved to before T (an hour ago and earlier): in the first hours of a day some of them are on the day before, so the days are
    // counted together (public runs 45300077488 and 45300161640 at 01:05 UTC: 1 of the 3 was on the current day)
    const days = (await q<{ d: string }>(`SELECT (current_date - n)::text AS d FROM generate_series(0, 2) AS n`)).rows.map((r) => r.d);
    let onThoseDays = 0;
    for (const day of days) onThoseDays += (await q(`SELECT 1 FROM ${saveOnDaySql("$1", "$2::date")} e WHERE e.target_id = $3`, [here.ws, day, note])).rows.length;
    expect(onThoseDays).toBe(REAL.length);
    const states = (await noteStatesAt(here.owner, here.ws, new Date(Date.now() + 2 * HOUR), {}, note)).find((s) => s.id === note);
    expect(states?.body_hash_then, "the newest state is the last real save").toBe(sha256Hex(REAL[2]!));
  });

  it("a rewind and its undo put back text the note really had, never the set-aside text", async () => {
    // before the rewind: REAL[2] now, REAL[1] at T; the set-aside text is the newest version by the clock
    const note = await asideNote("Aside, rewound");
    const done = await rewindWorkspace(here.ws, { at: T, restoreIds: [note], undeleteIds: [], deleteIds: [] }, { actor: here.owner });
    expect(done.restored).toEqual([note]);
    const md = async () => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [note])).rows[0]!.markdown;
    expect(await md()).toBe(REAL[1]);
    const undone = await undoRewind(here.ws, done.rewind_id!, [note], { actor: here.owner });
    expect(undone.undone, JSON.stringify(undone)).toEqual([note]);
    const after = await md();
    expect(REAL, "what the undo wrote is a text the note really had").toContain(after);
    expect(after).not.toBe(ASIDE);
    expect(after, "the undo puts back the text from before the rewind").toBe(REAL[2]);
  }, 120_000);

  /** A baseline version put in by hand (migration 220 mints them from the content no version names). */
  const baseline = async (id: string, unit: string, text: string, at: string) => seedQ(
    `WITH blob AS (INSERT INTO blobs (hash, content, size_bytes) VALUES (encode(sha256(convert_to($3, 'UTF8')), 'hex'), $3, octet_length($3)) ON CONFLICT DO NOTHING)
     INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, title, content_hash, at, ordinal, recorded_by, author_kind)
     VALUES ($1::uuid, $2::uuid, $5, 'b:' || encode(sha256(convert_to($2 || $5 || $3, 'UTF8')), 'hex'), 'baseline', $6, encode(sha256(convert_to($3, 'UTF8')), 'hex'), note_version_at($4::timestamptz), 0,
             (SELECT node_id FROM sync_node WHERE singleton), 'automatic')`, [here.ws, id, text, at, unit, unit === "body" ? "Base" : null]);

  it("a baseline that is the oldest state says so; one that came after older saves is an ordinary row (earliest would be wrong); no drawing's baseline is an edit", async () => {
    const oldest = (await here.call("POST", "/api/nodes", { title: "Base", markdown: "now", space_id: here.personal })).id as string;
    await baseline(oldest, "body", "before any save", "2020-01-01T00:00:00Z");
    const first = (await listNoteVersions(here.ws, here.owner, oldest, { raw: false }))! as unknown as Array<{ markdown: string; markers: string[] }>;
    expect(first.map((r) => r.markdown)).toEqual(["now", "before any save"]);
    expect(first.map((r) => r.markers.includes("baseline"))).toEqual([false, true]);
    const late = (await here.call("POST", "/api/nodes", { title: "Base", markdown: "one", space_id: here.personal })).id as string;
    await here.call("PATCH", `/api/nodes/${late}`, { markdown: "one two" });
    await baseline(late, "body", "text no version named", new Date(Date.now() + 60_000).toISOString());
    const second = (await listNoteVersions(here.ws, here.owner, late, { raw: false }))! as unknown as Array<{ markdown: string; markers: string[] }>;
    expect(second[0]!.markdown).toBe("text no version named");
    expect(second.flatMap((r) => r.markers), "no row of this note is the earliest remembered state").not.toContain("baseline");
    // a drawing's baseline is no day's edit and no edit of the list
    const board = (await here.call("POST", "/api/nodes", { title: "Board", markdown: "", space_id: here.personal })).id as string;
    await here.call("PUT", `/api/nodes/${board}/attributes/ink_data`, { value: drawing("a") });
    await baseline(board, "ink_data", drawing("a", "b", "c"), new Date(Date.now() + 60_000).toISOString());
    const edits = (await listInkEdits(here.ws, here.owner, board, "handwriting"))!;
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ added: 1, erased: 0 });
    const day = (await q<{ d: string }>(`SELECT current_date::text AS d`)).rows[0]!.d;
    expect([...(await dayInkChanges(here.ws, [{ nodeId: board, day }], "handwriting")).values()][0]).toMatchObject({ added: 1, erased: 0 });
  });

  it("a backup carries a baseline as a baseline: the file says so, an older reader takes the line as a creation, and the import stores it back as one", async () => {
    const id = (await here.call("POST", "/api/nodes", { title: "Base", markdown: "now", space_id: here.personal })).id as string;
    await baseline(id, "body", "before any save", "2020-01-01T00:00:00Z");
    const dir = mkdtempSync(join(tmpdir(), "aside-baseline-"));
    try {
      await writeHistoryFile(here.ws, id, join(dir, "h.jsonl"));
      const lines = readFileSync(join(dir, "h.jsonl"), "utf8").trim().split("\n");
      const parsed = lines.map((l) => JSON.parse(l) as { kind: string; markdown: string; baseline?: true });
      expect(parsed.map((l) => [l.kind, l.markdown, l.baseline ?? false])).toEqual([["created", "before any save", true], ["created", "now", false]]);
      const target = (await here.call("POST", "/api/nodes", { title: "Carried baseline", markdown: "now", space_id: here.personal })).id as string;
      const read = async function* () { yield* lines; };
      await withEventTransaction(here.ws, () => importNoteHistory(here.owner, here.ws, target, read));
      const kinds = (await q<{ kind: string; md: string }>(`SELECT v.kind, b.content AS md FROM note_versions v JOIN blobs b ON b.hash = v.content_hash WHERE v.note_id = $1 AND v.unit = 'body' ORDER BY v.at`, [target])).rows;
      expect(kinds.find((k) => k.md === "before any save")?.kind).toBe("baseline");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);
});
