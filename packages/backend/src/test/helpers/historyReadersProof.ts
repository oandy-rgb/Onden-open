// The comparison behind historyReadersMatchEvents.integration.test.ts and historyReadersPaths.integration.test.ts (history-replication batch 2):
// one database, the event readers of helpers/legacyHistoryReaders.ts (the oracle) against the product's readers, row for row.
import { expect } from "vitest";
import { INK_KIND_ATTR, INK_KINDS } from "@onden/markdown/ink";
import { q } from "../../db.js";
import { noteStatesAt } from "../../services/history/pointInTime.js";
import { listNoteVersions } from "../../services/history/noteVersions.js";
import { listInkEdits } from "../../services/history/inkChanges.js";
import { loadBodyVersion } from "../../spine/noteVersions.js";
import { VERSION_ORDER_DESC_SQL, listBodyVersions } from "../../services/history/storedVersions.js";
import { listInkVersionRows } from "../../services/nodeReads.js";
import type { ActorCtx } from "../../types.js";
import { legacyListInkEdits, legacyInkVersionRows, legacyListNoteVersions, legacyLoadVersion, legacyNoteStatesAt } from "./legacyHistoryReaders.js";

export type Ctx = { ws: string; actor: ActorCtx; space: string; call: (method: string, path: string, body?: unknown) => Promise<any> };

// ---- what a difference may be --------------------------------------------------------------------------------------------------
// Each key is a reason the new reader legitimately differs; the comparison counts them and the test prints the table. A difference that
// fits none fails the test with the note, the reader and the two rows.
export const INTENDED = {
  noSaveEvent: "a version no save event names: a note's baseline `b:` (its current text, which no save names) and a task made with text (its creation event carries no body_hash): the old list had no row for it",
  textGone: "a save whose text is gone from `blobs` has no version: the old list counted it in `saves` of the row it belonged to, and \"the workspace at T\" named it (a text that could be neither shown nor restored); now it names the last version whose text is kept",
  repeatRaw: "`?raw=1` listed a save that repeated the one before it; it minted no version, so the version list has no row for it",
  repeatInk: "a drawing save that repeated the previous drawing minted no version: the old edit counted it in `saves` and dated the edit by it",
  undoTarget: "an undo (eventRestore) names the version it put back (migration 220, §4.4 point 4); the old list pointed at the save it undid",
} as const;
type Reason = keyof typeof INTENDED;
export const seen = new Map<Reason, number>();
export const unreadable = new Set<string>();
const intended = (reason: Reason) => seen.set(reason, (seen.get(reason) ?? 0) + 1);

// ---- the comparison ------------------------------------------------------------------------------------------------------------
type Row = Record<string, any>;
const day = (d: unknown) => new Date(d as string).toISOString();
const stripNames = ({ actor_name, ...row }: Row) => row; // the name is compared where it can be told: see names()

/** A version list as the screen reads it: the rows' content, author, time, markers; `restored_from` as the time of the row it names. */
function shape(rows: Row[], restoredAt: (row: Row) => string | null) {
  return rows.map((r) => ({
    markdown: r.markdown, title: r.title, saves: r.saves, actor_kind: r.actor_kind, actor_type: r.actor_type, actor_name: r.actor_name,
    changed_at: day(r.changed_at), markers: [...(r.markers ?? [])].sort(), restored_at: restoredAt(r),
    summary: r.summary ? JSON.stringify(r.summary) : undefined,
  }));
}

async function compareNote(c: Ctx, noteId: string, label: string) {
  const fail = async (what: string, a: unknown, b: unknown): Promise<never> => {
    const events = (await q(`SELECT e.id, e.event_type, e.created_at, left(e.payload->>'body_hash', 6) AS h, e.payload->>'title' AS title, e.tx_meta ? 'restored_from' AS undo FROM domain_events e WHERE e.target_id = $1 AND e.payload ? 'body_hash' ORDER BY e.created_at, e.id`, [noteId])).rows;
    const versions = (await q(`SELECT left(v.version_key, 8) AS k, v.kind, v.at, left(v.content_hash, 6) AS h, v.clock_wall, v.ordinal, left(v.restored_from, 8) AS rf FROM note_versions v WHERE v.note_id = $1 AND v.unit = 'body' ORDER BY v.at, v.ordinal`, [noteId])).rows;
    throw new Error(`${label}: ${what}\n--- before (events)\n${JSON.stringify(a)}\n--- now (versions)\n${JSON.stringify(b)}\n--- events\n${events.map((r) => JSON.stringify(r)).join("\n")}\n--- versions\n${versions.map((r) => JSON.stringify(r)).join("\n")}`);
  };
  // versions that no save event of this node names (baselines, a task's creation): the old list had no row for them
  const orphans = new Set((await q<{ version_key: string }>(
    `SELECT v.version_key FROM note_versions v WHERE v.note_id = $1 AND v.unit = 'body' AND v.kind <> 'set_aside'
        AND NOT EXISTS (SELECT 1 FROM note_version_events ve WHERE ve.note_id = v.note_id AND ve.unit = v.unit AND ve.version_key = v.version_key)`, [noteId])).rows.map((r) => r.version_key));
  const hasBaseline = orphans.size > 0;
  // text a conflict put aside: content the note never had; no reader that answers "what was the note like" may show it
  const asideTexts = (await q<{ content: string; real: boolean }>(
    `SELECT b.content, EXISTS (SELECT 1 FROM note_versions r WHERE r.note_id = v.note_id AND r.unit = 'body' AND r.kind <> 'set_aside' AND r.content_hash = v.content_hash) AS real
       FROM note_versions v JOIN blobs b ON b.hash = v.content_hash WHERE v.note_id = $1 AND v.unit = 'body' AND v.kind = 'set_aside'`, [noteId])).rows.filter((r) => !r.real).map((r) => r.content);
  const textGone = (await q(
    `SELECT 1 FROM domain_events e WHERE e.target_id = $1 AND e.payload ? 'body_hash' AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.hash = e.payload->>'body_hash') LIMIT 1`, [noteId])).rows.length > 0;

  // ---- the version list, merged
  const before = (await legacyListNoteVersions(c.ws, noteId, { raw: false })) as Row[];
  const listed = (await listNoteVersions(c.ws, c.actor, noteId, { raw: false })) as Row[] | null;
  if (listed === null) { // a note in the trash: the list is for a live note (the gate, canReadNode, is the same as before), so the stored reader under it is compared with the old one directly
    unreadable.add(noteId);
    await compareTrashed(c, noteId, label);
    return;
  }
  const nowRows = listed;
  const nowByKey = new Map(nowRows.map((r) => [r.id as string, r]));
  const beforeShape = shape(before, (r) => r.restored_from as string | null);
  const nowShape = shape(nowRows, (r) => (r.restored_from ? day(nowByKey.get(r.restored_from)?.changed_at) : null));
  if (hasBaseline) {
    // The old list had no row for a version no save event names (a baseline, a task's or a board's creation or rename). Each class is asserted on its own:
    // the extra rows are exactly those versions, and every other row is the old row, field for field (the summary and the markers of a row next to an
    // extra one are worked out against it, so those two are left out for that row only).
    intended("noSaveEvent");
    const isExtra = (r: Row) => orphans.has(r.id as string);
    const extras = nowRows.filter(isExtra);
    expect(extras.length, `${label}: the version(s) no event names are in the list`).toBeGreaterThan(0);
    const kinds = (await q<{ kind: string }>(`SELECT DISTINCT kind FROM note_versions WHERE note_id = $1 AND unit = 'body' AND version_key = ANY($2::text[])`, [noteId, extras.map((r) => r.id)])).rows.map((r) => r.kind);
    expect(kinds.every((k) => ["baseline", "created", "updated"].includes(k)), `${label}: extra rows are baselines or the first save of a note or board`).toBe(true);
    const rest = nowRows.filter((r) => !isExtra(r));
    expect(rest.length, `${label}: the other rows are the old rows`).toBe(before.length);
    const field = (r: Row, adjacent: boolean, restoredAt: string | null) => ({
      markdown: r.markdown, title: r.title, saves: r.saves, actor_kind: r.actor_kind, actor_type: r.actor_type, actor_name: r.actor_name, changed_at: day(r.changed_at), restored_at: restoredAt,
      ...(adjacent ? {} : { markers: [...(r.markers ?? [])].sort(), summary: r.summary ? JSON.stringify(r.summary) : undefined }),
    });
    for (const [j, old] of before.entries()) {
      const mine = rest[j]!;
      const at = nowRows.indexOf(mine);
      const adjacent = isExtra(nowRows[at - 1] ?? {}) || isExtra(nowRows[at + 1] ?? {});
      const [a, b] = [field(old, adjacent, old.restored_from as string | null), field(mine, adjacent, mine.restored_from ? day(nowByKey.get(mine.restored_from)?.changed_at) : null)];
      if (JSON.stringify(a) !== JSON.stringify(b)) await fail(`row ${j} of the merged version list differs (next to an extra version: ${adjacent})`, a, b);
    }
    // the latest version: the old one, unless an extra version is newer
    if (!isExtra(nowRows[0]!)) expect(nowRows[0]?.markdown, `${label}: latest version`).toBe(before[0]?.markdown);
  } else {
    let a = beforeShape, b = nowShape;
    if (textGone && JSON.stringify(a.map((r) => r.saves)) !== JSON.stringify(b.map((r) => r.saves))) {
      intended("textGone");
      a = a.map(({ saves, ...r }) => r as never); b = b.map(({ saves, ...r }) => r as never);
    }
    // an undo's "restored from": the version it put back, one row older than the save it undid
    const times = a.map((r) => r.changed_at);
    b = b.map((r, i) => {
      const was = a[i];
      if (was && r.restored_at !== was.restored_at && r.restored_at !== null && was.restored_at !== null) {
        const undone = times.indexOf(was.restored_at);
        if (undone >= 0 && times[undone + 1] === r.restored_at) { intended("undoTarget"); return { ...r, restored_at: was.restored_at }; }
      }
      return r;
    });
    if (JSON.stringify(a) !== JSON.stringify(b)) await fail("the merged version list differs", a, b);
    // the latest version
    expect(nowRows[0]?.markdown, `${label}: latest version`).toBe(before[0]?.markdown);
  }

  // ---- `?raw=1`: one row per save before; one row per version now (a repeat save has none)
  const rawBefore = (await legacyListNoteVersions(c.ws, noteId, { raw: true })) as Row[];
  const rawNow = (await listNoteVersions(c.ws, c.actor, noteId, { raw: true }))! as Row[];
  const withoutRepeats = rawBefore.filter((r, i) => !(i + 1 < rawBefore.length && rawBefore[i + 1]!.title === r.title && rawBefore[i + 1]!.markdown === r.markdown));
  if (withoutRepeats.length !== rawBefore.length) intended("repeatRaw");
  if (!textGone) {
    const f = (rows: Row[]) => rows.map((r) => ({ title: r.title, markdown: r.markdown, changed_at: day(r.changed_at), actor_type: r.actor_type, actor_kind: r.actor_kind, actor_name: r.actor_name }));
    const rawRest = rawNow.filter((r) => !orphans.has(r.id as string));
    if (JSON.stringify(f(withoutRepeats)) !== JSON.stringify(f(rawRest))) await fail("the raw version list differs", f(withoutRepeats), f(rawRest));
  }

  // ---- what a conflict put aside is in no list
  for (const text of asideTexts) {
    for (const rows of [nowRows, rawNow]) expect(rows.map((r) => r.markdown), `${label}: a set-aside text is not a version of the note`).not.toContain(text);
  }

  // ---- restoring each version: the title and text a version comes back as, by the number of its event and by its key
  for (const e of await q<{ id: string }>(`SELECT id::text AS id FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash' ORDER BY domain_events.id`, [noteId]).then((r) => r.rows)) {
    const old = await legacyLoadVersion(c.ws, noteId, e.id);
    const viaNumber = await loadBodyVersion(c.ws, noteId, e.id);
    if (!old) { expect(viaNumber, `${label}: event ${e.id} has no text and no version`).toBeNull(); continue; }
    if (!viaNumber) await fail(`the number of event ${e.id} no longer restores a version`, old, viaNumber);
    expect({ title: viaNumber!.title, markdown: viaNumber!.markdown }, `${label}: event ${e.id} by number`).toEqual({ title: old.title, markdown: old.markdown });
    const viaKey = await loadBodyVersion(c.ws, noteId, viaNumber!.key);
    expect(viaKey, `${label}: event ${e.id} by key`).toEqual(viaNumber);
  }
  for (const r of rawNow) { // every version listed restores, by its key
    expect(await loadBodyVersion(c.ws, noteId, String(r.id)), `${label}: ${r.id}`).toMatchObject({ markdown: r.markdown, title: r.title });
  }
}

/** A note in the trash has no list (the gate says so, as before), but its versions are what a rewind's undelete and the trash's "restore together" read: the stored reader under the gate
 *  against the event reader, as for a live note, text by text (adjacent repeats and set-aside texts are not states; a version no event names is `noSaveEvent`). */
async function compareTrashed(c: Ctx, noteId: string, label: string) {
  const states = (rows: Array<{ title: string | null; markdown: string }>) => rows.map((r) => JSON.stringify([r.title, r.markdown])).filter((x, i, all) => i === 0 || x !== all[i - 1]);
  const before = states(((await legacyListNoteVersions(c.ws, noteId, { raw: true })) as Array<{ title: string | null; markdown: string }>).reverse()).reverse();
  const now = states((await listBodyVersions(c.ws, noteId, 50)).reverse()).reverse();
  if (JSON.stringify(now) !== JSON.stringify(before)) {
    const orphan = (await q(`SELECT 1 FROM note_versions v WHERE v.note_id = $1 AND v.unit = 'body' AND v.kind <> 'set_aside' AND NOT EXISTS (SELECT 1 FROM note_version_events ve WHERE ve.note_id = v.note_id AND ve.unit = v.unit AND ve.version_key = v.version_key) LIMIT 1`, [noteId])).rows.length > 0;
    if (!orphan) expect(now, `${label}: the trashed note's texts`).toEqual(before);
    intended("noSaveEvent");
    expect(before.every((x) => now.includes(x)), `${label}: every text the events gave is still a version of the trashed note`).toBe(true);
  } else expect(now, `${label}: the trashed note's texts`).toEqual(before);
}

/** "The workspace at T", for every note of the workspace the actor reads, at each of `times`: the same title, text and status as the events gave. */
async function compareAt(c: Ctx, times: Date[], label: string) {
  // versions no save event names (a baseline, a task's or board's first save or rename): the old reader had nothing for them
  const orphanNotes = new Map<string, Array<{ key: string }>>();
  for (const r of (await q<{ id: string; key: string }>(
    `SELECT v.note_id::text AS id, v.version_key AS key FROM note_versions v WHERE v.unit = 'body' AND v.kind <> 'set_aside'
        AND NOT EXISTS (SELECT 1 FROM note_version_events ve WHERE ve.note_id = v.note_id AND ve.unit = v.unit AND ve.version_key = v.version_key)`)).rows) orphanNotes.set(r.id, [...(orphanNotes.get(r.id) ?? []), { key: r.key }]);
  for (const at of times) {
    for (const options of [{}, { includeTrashedNewborn: true, includeTrashedThen: true }]) {
      const before = await legacyNoteStatesAt(c.actor, c.ws, at, {}, undefined, options);
      const now = await noteStatesAt(c.actor, c.ws, at, {}, undefined, options);
      const key = (rows: typeof now) => new Map(rows.map((r) => [r.id, r]));
      const [b, n] = [key(before), key(now)];
      for (const id of new Set([...b.keys(), ...n.keys()])) {
        const [was, is] = [b.get(id), n.get(id)];
        // a note with such a version: when the newest version at or before T is one of them, the state is that version's; otherwise it is the old answer
        if (orphanNotes.has(id)) {
          const newest = (await q<{ key: string; title: string | null; hash: string }>(
            `SELECT v.version_key AS key, v.title, v.content_hash AS hash FROM note_versions v JOIN blobs bl ON bl.hash = v.content_hash
              WHERE v.note_id = $1 AND v.unit = 'body' AND v.kind <> 'set_aside' AND v.at::timestamptz <= $2::timestamptz ORDER BY ${VERSION_ORDER_DESC_SQL} LIMIT 1`, [id, at.toISOString()])).rows[0];
          if (newest && orphanNotes.get(id)!.some((o) => o.key === newest.key)) {
            intended("noSaveEvent");
            expect({ title: is?.title_then, hash: is?.body_hash_then }, `${label}: note ${id} at ${at.toISOString()}: the newest version then is one no event names`).toEqual({ title: newest.title ?? is?.title_now, hash: newest.hash });
            continue;
          }
        }
        // the old reader named a save whose text is gone (it could neither show nor restore it): now the last version whose text is kept
        if (was?.body_hash_then && !(await q(`SELECT 1 FROM blobs WHERE hash = $1`, [was.body_hash_then])).rows.length) {
          intended("textGone");
          if (is?.body_hash_then) expect((await q(`SELECT 1 FROM blobs WHERE hash = $1`, [is.body_hash_then])).rows.length, `${label}: ${id} at ${at.toISOString()}`).toBe(1);
          continue;
        }
        expect(is, `${label}: note ${id} at ${at.toISOString()} (${JSON.stringify(options)})`).toEqual(was);
      }
    }
  }
}

async function compareInk(c: Ctx, noteId: string, label: string) {
  for (const kind of INK_KINDS) {
    const unit = INK_KIND_ATTR[kind];
    const hasRepeat = Number((await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_events e WHERE e.target_id = $1 AND e.event_type = 'ATTRIBUTE_SET' AND e.payload->>'key' = $2
          AND NOT EXISTS (SELECT 1 FROM note_version_events ve WHERE ve.event_id = e.id AND ve.version_key = (SELECT min(x.version_key) FROM note_version_events x WHERE x.event_id = e.id)
                           AND (SELECT min(y.event_id) FROM note_version_events y WHERE y.note_id = ve.note_id AND y.unit = ve.unit AND y.version_key = ve.version_key) = e.id)`,
      [noteId, unit])).rows[0]!.n) > 0;
    const before = await legacyListInkEdits(c.ws, noteId, kind);
    const listedNow = await listInkEdits(c.ws, c.actor, noteId, kind);
    if (listedNow === null) { unreadable.add(noteId); continue; }
    const now = listedNow;
    const f = (rows: Array<{ added: number; erased: number; changed_at: string; actor_name: string | null; actor_kind: string; saves: number }>, withSaves: boolean) =>
      rows.map((r) => ({ added: r.added, erased: r.erased, actor_name: r.actor_name, actor_kind: r.actor_kind, ...(withSaves ? { saves: r.saves, changed_at: r.changed_at } : {}) }));
    const same = JSON.stringify(f(before, true)) === JSON.stringify(f(now, true));
    if (!same) {
      if (!hasRepeat) throw new Error(`${label}: ${kind} edits differ\n${JSON.stringify(f(before, true))}\n${JSON.stringify(f(now, true))}`);
      intended("repeatInk");
      expect(f(now, false), `${label}: ${kind} edits (without saves and time)`).toEqual(f(before, false));
    }
    // the raw drawing versions: the same drawings in the same order (a repeat of the drawing before has no version)
    const rawBefore = ((await legacyInkVersionRows(c.ws, noteId, kind)) as Row[]).filter((r) => typeof r.ink_data === "string" && r.ink_data.length > 0);
    const rawNow = (((await listInkVersionRows(c.actor, c.ws, noteId, kind)) ?? []) as Row[]).filter((r) => typeof r.ink_data === "string" && r.ink_data.length > 0);
    const dedup = rawBefore.filter((r, i) => !(i + 1 < rawBefore.length && rawBefore[i + 1]!.ink_data === r.ink_data));
    if (dedup.length !== rawBefore.length) intended("repeatInk");
    expect(rawNow.map((r) => r.ink_data), `${label}: ${kind} drawings`).toEqual(dedup.map((r) => r.ink_data));
    expect(rawNow.map((r) => [r.actor_kind, r.actor_type]), `${label}: ${kind} authors`).toEqual(dedup.map((r) => [r.actor_kind, r.actor_type]));
  }
}

/** Everything compared, for the notes `noteIds` of workspace `c.ws`. */
export async function proof(c: Ctx, noteIds: string[], label: string) {
  for (const id of noteIds) await compareNote(c, id, `${label} note ${id.slice(0, 8)}`);
  for (const id of noteIds) await compareInk(c, id, `${label} note ${id.slice(0, 8)}`);
  const stamps = (await q<{ t: Date }>(`SELECT created_at AS t FROM domain_events WHERE workspace_id = $1 AND payload ? 'body_hash' UNION SELECT at::timestamptz FROM note_versions WHERE workspace_id = $1`, [c.ws])).rows.map((r) => r.t.getTime());
  const times = new Set<number>();
  for (const t of stamps) for (const d of [-1, 0, 1]) times.add(t + d);
  const first = Math.min(...stamps), last = Math.max(...stamps);
  for (let t = Math.floor(first / 86_400_000) * 86_400_000; t <= last + 86_400_000; t += 86_400_000) times.add(t);
  await compareAt(c, [...times].sort((a, b) => a - b).map((t) => new Date(t)), label);
}


/** The table of differences the proof met, for the log and the PR. */
export function intendedDifferences(): string {
  const table = [...seen.entries()].map(([reason, count]) => `  ${reason} (${count}): ${INTENDED[reason]}`).join("\n");
  return `[history readers] notes the actor cannot read (in the trash): ${unreadable.size}\n[history readers] intended differences seen:\n${table || "  none"}`;
}
