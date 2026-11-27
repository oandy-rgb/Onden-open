// The import half of copying a workspace to an empty database with every row's write stamp kept (docs/architecture/proposals/
// add-device-snapshot-2026-11-15.md §3–4). THE ONE ENTRY that writes rows and the stamps that came with them, exactly as
// received. It is a named, counted exception to "writes go through spine/mutate.ts": there is no actor and no event, the
// authority is the database's own joining state (migration 204's sync_join), and the only caller is services/stampedJoin.ts
// (stampedImport.guard.test.ts lists the allowed callers; a route calls the service, never this file).
//
// WHY A SEPARATE ENTRY: the stamp triggers only stamp a column whose value changed (db/migrations/190), so rebuilding a row by
// "insert it old, update it new" leaves an edited field with the wrong stamp. Here the rows are written final and the stamps as
// they were; for that transaction the triggers stand aside (stamps.ts standAsideForImport) and write neither stamps nor
// structure_log lines. They are as before when the transaction ends.
//
// THE STATE MACHINE (sync_join, one row):  beginJoin → applyStampedPage × N (idempotent, any page again with the same content is
// a no-op) → markJoinDone (every page present, the receiver's digest equals the source's, no (origin, seq) with two contents, nothing
// left to stamp: ONE transaction) | cancelJoin (everything the snapshot wrote is removed and the empty shell is made again at once, with the
// person who was joining back in it; a process that dies half way is taken back the same way at the next boot, db.ts migrate()).
//
// WHO BECOMES WHO (the one rule): the person who joins is the signed-in owner of the empty database (the route needs that). Their sign-in
// is linked to ONE person of the snapshot, `hello.person`, who must be a human and the owner of the snapshot's workspace (a source only
// exports for its owner); so they have exactly that person's role there. Nothing else in a request body picks a person, a role or a
// permission; the workspace id it names is the id the database then has. A snapshot is as trusted as the owner of the empty database, who
// can already do anything to this machine. While joining, no ordinary write is accepted for the workspace (stamps.ts stampTransaction).
//
// WHAT IS REFUSED, before any write of the page: a stamp whose origin is this node (or anything but the snapshot's source, its former ids,
// the other origins it says it holds and genesis); a stamp beyond what the source says it holds of that origin (its cut, a former id's number,
// a brought origin's number for that label); a (origin, seq) that appears with two different contents; a batch whose highest clock reading is further ahead of this
// machine's clock than MAX_FOREIGN_CLOCK_AHEAD_MS; a table the classification does not carry; a column a snapshot does not carry
// (a membership epoch, an invitation, a sealed address); a row of another workspace; a person that signs in through the
// snapshot; a page whose number was applied with other content. The page is written in one savepoint: a refusal leaves nothing.

import { discardUnfinishedJoins, ensureShellWorkspace, planThisTransactionForTablesAsTheyAre, restoreShellPerson, withTransaction, type ShellPerson } from "../db.js";
import { nativeBypassEnabled } from "../nativeBypass.js";
import { isUuid } from "@onden/markdown";
import { CodedStatusError } from "../statusError.js";
import { sha256Hex } from "../utils.js";
import { withEventTransaction } from "./eventTransaction.js";
import { liveNodeSql, notTagNodeSql } from "./nodeSql.js";
import { assertForeignClockWithinBound, advanceClockFor, localNodeId, standAsideForImport, type ClockReading } from "./stamps.js";
import { CARRIED_LABELS, UNIT_SOURCES, storeMergedRows, storeMergedUnits, type IncomingUnit, type RowsReport, type SkewGate, type UnitMergeReport } from "./stampedMerge/index.js";
import { BUNDLE_SCOPE, MAX_BROUGHT_ORIGINS, broughtBound, bundleRefused, haveAt, haveOfAll, normalizeHave, originsOf, type Have } from "./stampedBundle.js";
import { carriedColumns, compareDigests, computeSnapshotDigest, snapshotRows, type ChangeBundle, type DigestDifference, type SnapshotItem, type StampedPage, type TableDigest, type WireStamp } from "./snapshotSql.js";
import { SHELL_EMPTY_CHECKS, SNAPSHOT_SPECS, snapshotSpec, wholeWorkspace, type SnapshotSpec } from "./snapshotTables.js";
import { SYSTEM_EXTERNAL_ID_SQL } from "./systemActor.js";
import { SYNC_DATA_SHAPE_VERSION } from "./syncDataShape.js";
import { deriving, receivedDerivation } from "./receivedDerivation.js";

class JoinRefused extends CodedStatusError {}
const refuse = (code: string, message: string, status: 400 | 409 | 413 | 422 = 422) => new JoinRefused(status, code, message);
/** A refusal of the join with a code the client can branch on (the stream form of the upload uses it for what is wrong with a line). */
export const joinRefused = refuse;

/** `shellPersonId`: the signed-in person of this (empty) database who is joining. Their row is saved with the join and put back if it is given
 *  up (cancelJoin) or cut off by a dead process (db.ts migrate()): a refused join leaves the same person, with the same sign-in, in the
 *  empty database. Null: the shell has no person of its own to keep. */
/** `former`: the ids the source had before it was restored and took a new one (StampedPage.former, the snapshot's first line), each with the highest
 *  number of it the source holds; their stamps are the source's own. Absent or `{}`: a source that was never restored.
 *  `brought`: the other origins the source holds, per label and origin as far as it holds them (StampedPage.brought, a Have of spine/stampedBundle.ts). Absent or `{}`: none. */
export type JoinInput = { workspaceId: string; sourceNode: string; cutSeq: number; personActorId: string; shellPersonId?: string | null; former?: Record<string, number>; brought?: Have };

type JoinRow = { workspace_id: string; source_node: string; cut_seq: string; source_former: Record<string, number>; source_brought: Record<string, Record<string, number>>; state: "joining" | "done"; person_actor_id: string | null; page_hashes: Record<string, string>; applied_through: number };

/** A node id as sync_take_node_id (migration 213) and db.ts make it: gen_random_uuid() as text. The one check for an id a snapshot or a change bundle
 *  names (its source or sender, its former ids, the origins it holds): `sync_origins.vouched_by` also holds the words 'snapshot', 'admitted' and
 *  'self-restore', and a node named like one of them would make a row mean something else (applyChangeBundle: who may send; snapshotSourceNode: an id of
 *  this very node). Genesis is not a node id; it is dropped or allowed by name where it may appear. LOWER CASE only, as the database writes them (review round 1, B4:
 *  every comparison of ids is of text, so `A…` and `a…` would be two nodes, and a capitalised form of this node's id would pass as another origin). */
const isNodeId = (id: unknown): id is string => typeof id === "string" && isUuid(id) && id === id.toLowerCase();

/** How many former ids a snapshot may name. A server takes one more id each time it is restored from a backup (scripts/restore.sh), so the list is
 *  as long as the number of restores in its life; 32 restores is far past any server this is for, and the bound keeps a file from naming millions.
 *  The same bound as for the other origins it brings (spine/stampedBundle.ts MAX_BROUGHT_ORIGINS). */
const MAX_FORMER_IDS = MAX_BROUGHT_ORIGINS;

/** The snapshot says its source holds writes of THIS node (in `former` or `brought`): this database once sent bundles under the same node id, was emptied without taking a
 *  new one, and joins again. Refused (its own code: the copy is not damaged, this device has to start over with a new id, own-node-transport proposal §3.5), and before
 *  anything is written: the join would take those stamps as another node's, and this node would number its next writes again from 1 (review round 1, B6). */
const thisNodeNamed = () => refuse("join_origin_is_this_node", "the snapshot says its source holds writes made by this node, under this node's id: this device has to start over with a new node id", 409);

/** The `former` of a join, checked: at most MAX_FORMER_IDS node ids (not the source, not this node) with whole numbers. Refused whole otherwise. */
function checkedFormer(former: unknown, sourceNode: string, local: string | null): Record<string, number> {
  if (former === undefined) return {};
  const bad = () => refuse("join_bad_former", "the ids a restored source had before are an object of node ids and whole numbers");
  if (former === null || typeof former !== "object" || Array.isArray(former)) throw bad();
  const entries = Object.entries(former);
  if (entries.length > MAX_FORMER_IDS) throw refuse("join_bad_former", `a snapshot names at most ${MAX_FORMER_IDS} ids its source had before`);
  for (const [origin, n] of entries) {
    if (origin === local) throw thisNodeNamed();
    if (!isNodeId(origin) || origin === sourceNode || !Number.isSafeInteger(n) || (n as number) < 0) throw bad();
  }
  return former as Record<string, number>;
}

/** The `brought` of a join, checked (docs/decisions/sync-trust-line.md, the first layer): an object of carried labels, each an object of node ids with whole numbers;
 *  at most MAX_BROUGHT_ORIGINS origins over all labels; none of them the source, a former id of the source or genesis (this node: join_origin_is_this_node) (each of those is vouched for, or
 *  refused, in its own way). Refused whole otherwise (`join_bad_brought`). The form before data shape 6 (one number per origin) is refused too, never read as labels. */
function checkedBrought(brought: unknown, sourceNode: string, local: string | null, former: Record<string, number>): Record<string, Record<string, number>> {
  if (brought === undefined) return {};
  const bad = (why: string) => refuse("join_bad_brought", `the other origins a source holds are an object of carried labels, each an object of node ids and whole numbers (${why})`);
  if (!isObject(brought)) throw bad("not an object");
  const origins = new Set<string>();
  for (const [label, of] of Object.entries(brought)) {
    if (!CARRIED_LABELS.includes(label)) throw bad("a label a bundle does not carry, or one number per origin");
    if (!isObject(of)) throw bad("a label that is not an object");
    for (const [origin, n] of Object.entries(of)) {
      if (origin === local) throw thisNodeNamed();
      if (!isNodeId(origin)) throw bad("an origin that is not a node id");
      if (origin === sourceNode || Object.hasOwn(former, origin)) throw bad("the source itself or a former id of the source");
      if (!Number.isSafeInteger(n) || (n as number) < 0) throw bad("a number that is not a whole number");
      origins.add(origin);
    }
  }
  if (origins.size > MAX_BROUGHT_ORIGINS) throw refuse("join_bad_brought", `a snapshot names at most ${MAX_BROUGHT_ORIGINS} other origins its source holds`);
  return brought as Record<string, Record<string, number>>;
}


// The tables a fresh install already holds rows in (the class tags and settings the migrations make, the default and system spaces, the
// System account). Every OTHER carried table (spine/snapshotTables.json) must be empty in a shell: a new table added to the list is
// covered without anyone remembering this one. syncClasses.integration.test.ts checks that a freshly made database passes.
const INSTALL_TABLES = ["workspaces", "actors", "spaces", "space_members", "content_nodes", "node_tags", "function_refs"];

/** Whether the workspace this database made for itself is still the one it made: nothing in it was written by a person. Nothing is
 *  taken for empty because it looks empty in one table; the answer is "no" when ANY of these holds, and a database where someone
 *  already wrote is refused (it would be deleted whole):
 *    - a stamp with an author that is not genesis (every write through the write entry has an author; the install's own writes
 *      have none), in any table;
 *    - a domain event of anyone but the system (the sign-in's own ACTOR_CREATED is not one), or a second person, an agent other than the System account, a token, an AI
 *      connection or an uploaded file;
 *    - a row in any carried table that a fresh install leaves empty, or a note that is neither a tag nor made by the system.
 *  What it cannot see: a database whose history was pruned and whose people-made rows all carry genesis stamps (made before
 *  stamps existed, kept by migration 202) and sit only in the install-time tables above, as unedited tags or spaces. */
/** The codes of the checks that name a table by something a person recognises (the rest are `rows_of_<table>`). */
const TABLE_CHECK_CODES: Record<string, string> = { actor_prefs: "prefs" };

/** The signs that someone wrote in a workspace (each query finds any row = not empty), with the table-by-table ones a snapshot carries. */
function shellChecks(): { code: string; sql: string }[] {
  return [
    ...SHELL_EMPTY_CHECKS.map((check) => ({ code: check.code, sql: check.sql.replace("{systemExternalId}", SYSTEM_EXTERNAL_ID_SQL).replace("{notTag}", notTagNodeSql()) })),
    ...SNAPSHOT_SPECS.filter((spec) => !INSTALL_TABLES.includes(spec.table))
      .map((spec) => ({ code: TABLE_CHECK_CODES[spec.table] ?? `rows_of_${spec.table}`, sql: `SELECT 1 FROM "${spec.table}"` })), // the WHOLE table, not the rows a snapshot would select (a suggestion that was decided is not carried, but a shell that holds one was used)
  ];
}

async function shellIsEmpty(workspaceId: string): Promise<{ empty: true } | { empty: false; code: string }> {
  for (const check of shellChecks()) if ((await snapshotRows(`${check.sql} LIMIT 1`, [workspaceId])).rows.length > 0) return { empty: false, code: check.code };
  return { empty: true };
}

/** What a database holds that is a person's own, all of which a join deletes: COUNTS only, by kinds a person recognises (never a title or a text), so a
 *  confirmation can say what is about to go. A database a join accepts holds none of it. Each count is one of the signs shellIsEmpty looks for
 *  (`of` names the check by its code), so "what makes a database not empty" and "what a join deletes" are one definition and the install's own rows are in neither. */
export type JoinRemoval = { own_notes: number; trash: number; own_tags: number; spaces: number; files: number; prefs: number };
const REMOVAL_COUNTS: { key: keyof JoinRemoval; of: string; and?: () => string }[] = [
  { key: "own_notes", of: "own_notes", and: () => liveNodeSql() },
  { key: "trash", of: "own_notes", and: () => `NOT (${liveNodeSql()})` },
  { key: "own_tags", of: "own_tags" },
  { key: "spaces", of: "spaces" },
  { key: "files", of: "files" },
  { key: "prefs", of: "prefs" },
];

/** The one answer to "would this database accept a join": `beginJoin` acts on it and the read-only probe (services/stampedJoin.ts
 *  `joinReadiness`) returns it, so the two cannot disagree. `incoming` is the snapshot the join is for; the probe has none yet, so the one
 *  check that needs it (a snapshot made on this very node) is left to `beginJoin`.
 *  `kind` is the STABLE CODE of what made a database not empty: the `code` of a check in spine/snapshotTables.json `$shellEmptyChecks`
 *  (person_writes, person_events, more_than_one_person, other_agent, access_token, ai_connection, files, own_tags, spaces, own_function_refs,
 *  module_switch, applied_tag, own_notes, …), `prefs` for actor_prefs, `rows_of_<table>` for the other tables, or `more_than_one_workspace`.
 *  A screen words it from the code; the code is never shown. The counts of JoinRemoval use the same codes (`trash` is the notes of `own_notes` in the trash). */
type JoinDecision =
  | { ready: true; shellIds: string[] }
  | { ready: false; code: "join_in_progress" | "join_already_done" | "join_from_self" | "join_not_empty"; kind: string | null; message: string };

export async function decideJoin(incoming: { sourceNode: string } | null): Promise<JoinDecision> {
  const no = (code: Extract<JoinDecision, { ready: false }>["code"], message: string, kind: string | null = null): JoinDecision => ({ ready: false, code, kind, message });
  if ((await snapshotRows(`SELECT 1 FROM sync_join WHERE state = 'joining'`)).rows.length > 0) return no("join_in_progress", "a join is already running");
  // ANY finished join, not only this snapshot's workspace: a database that was joined holds a working workspace, never an empty shell.
  if ((await snapshotRows(`SELECT 1 FROM sync_join`)).rows.length > 0) return no("join_already_done", "this database was already joined");
  if (incoming && incoming.sourceNode === (await localNodeId().catch(() => null))) return no("join_from_self", "a snapshot made on this node is not joined to this node");
  const shells = (await snapshotRows<{ id: string }>(`SELECT id::text FROM workspaces`)).rows;
  // A shell may carry the same id (copies of one packaged database do): it is empty, so it is replaced like any other.
  // The invariant the rest of this file leans on: from here until the join ends the database holds exactly ONE workspace (the one being
  // filled). More than one is refused here, the shell is deleted by beginJoin, no route or service makes a workspace, and writes into the
  // joining one are refused (stamps.ts stampTransaction). So a row without a workspace column (node_tags, node_edges…) can only
  // belong to it, and the page check does not look workspace by workspace for them.
  if (shells.length > 1) return no("join_not_empty", "this database holds more than one workspace (more_than_one_workspace)", "more_than_one_workspace");
  for (const shell of shells) {
    const found = await shellIsEmpty(shell.id);
    if (!found.empty) return no("join_not_empty", `this database already holds content of its own (${found.code})`, found.code);
  }
  return { ready: true, shellIds: shells.map((s) => s.id) };
}

/** What a join would delete (see JoinRemoval) from the workspace(s) the database holds now; reads only. */
export async function readJoinRemoval(): Promise<JoinRemoval> {
  const checks = shellChecks();
  const shells = (await snapshotRows<{ id: string }>(`SELECT id::text FROM workspaces`)).rows;
  const removal: JoinRemoval = { own_notes: 0, trash: 0, own_tags: 0, spaces: 0, files: 0, prefs: 0 };
  for (const { key, of, and } of REMOVAL_COUNTS) {
    const check = checks.find((c) => c.code === of);
    if (!check) throw new Error(`no shell check named "${of}"`);
    const sql = check.sql.replace(/^SELECT 1 FROM/, "SELECT count(*)::text AS n FROM") + (and ? ` AND ${and()}` : "");
    // a check that names no workspace (an uploaded file) counts the whole table once
    for (const shell of sql.includes("$1") ? shells : shells.filter((_, at) => at === 0)) removal[key] += Number((await snapshotRows<{ n: string }>(sql, [shell.id])).rows[0]!.n);
  }
  return removal;
}

/** Start joining: the workspace the database made for itself is empty (else refused, by `decideJoin`) and is removed, a join record says
 *  what is being filled. Until `markJoinDone` the database is not a working one (it has no workspace). */
export async function beginJoin(input: JoinInput): Promise<void> {
  if (!Number.isSafeInteger(input.cutSeq) || input.cutSeq < 0) throw refuse("join_bad_cut", "the cut is a whole number of at least 0");
  if (!isNodeId(input.sourceNode)) throw refuse("join_bad_source", "the source of a snapshot is named by its node id");
  await withTransaction(async () => {
    const decision = await decideJoin({ sourceNode: input.sourceNode });
    if (!decision.ready) throw refuse(decision.code, decision.message, decision.code === "join_from_self" ? 422 : 409);
    let shellPerson: ShellPerson | null = null;
    for (const shellId of decision.shellIds) {
      if (input.shellPersonId) {
        shellPerson = (await snapshotRows<ShellPerson>(
          `SELECT a.id::text, a.name, a.external_id, a.write_mode, COALESCE((SELECT w.owner_actor_id = a.id FROM workspaces w WHERE w.id = a.workspace_id), false) AS owner
             FROM actors a WHERE a.id::text = $1 AND a.workspace_id = $2 AND a.type = 'human'`, [input.shellPersonId, shellId])).rows[0] ?? null;
      }
      // Everything the empty workspace owns goes with it (the foreign keys cascade). The cascade runs the stamp triggers, which leave
      // tombstones and a clock behind: they go last, so the workspace that replaces it (maybe under the same id) starts clean.
      // Its events go too: the only ones an empty shell has are the sign-in's own (ACTOR_CREATED, which the first sign-in of every person writes),
      // and the table lets an event go only inside a transaction that opts in (db.ts pruneEvents, migration 051): this one, for this delete only.
      await snapshotRows(`SELECT set_config('myapp.allow_event_prune', 'on', true)`);
      await snapshotRows(`DELETE FROM workspaces WHERE id = $1`, [shellId]);
      await snapshotRows(`SELECT set_config('myapp.allow_event_prune', '', true)`);
      await snapshotRows(`DELETE FROM sync_stamps WHERE workspace_id = $1`, [shellId]);
      await snapshotRows(`DELETE FROM sync_stamp_heads WHERE workspace_id = $1`, [shellId]);
      await snapshotRows(`DELETE FROM sync_clock WHERE workspace_id = $1`, [shellId]);
      // and what it knew of other nodes: a shell restored and renewed (or one an owner admitted a node to) has rows, and under the same workspace id (copies of one
      // packaged database share it) they would stand beside the snapshot's own, ON CONFLICT DO NOTHING keeping the shell's meaning of an id the source names
      await snapshotRows(`DELETE FROM sync_origins WHERE workspace_id = $1`, [shellId]);
    }
    const local = await localNodeId().catch(() => null);
    const former = checkedFormer(input.former, input.sourceNode, local);
    const brought = checkedBrought(input.brought, input.sourceNode, local, former);
    await snapshotRows(
      `INSERT INTO sync_join (workspace_id, source_node, cut_seq, person_actor_id, shell_person, source_former, source_brought) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
      [input.workspaceId, input.sourceNode, input.cutSeq, input.personActorId, shellPerson ? JSON.stringify(shellPerson) : null, JSON.stringify(former), JSON.stringify(brought)]);
  });
}

const sortedJson = (value: unknown): string => JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

function stampsOf(item: SnapshotItem): WireStamp[] {
  return item.kind === "row" ? item.stamps : item.kind === "tombstone" ? [item.stamp] : [];
}

/** What a write says it had seen: origin → whole number ≥ 0 (a genesis value is named `genesis:<hash>` with 0). Absent: a source that does not send it (every unit is
 *  taken to have been written over nothing). The one test of the form, for a snapshot and a change bundle alike: stored as it is, any other form breaks the next local
 *  write of that unit (migration 205 sync_saw_merge reads it with jsonb_each and a bigint cast). */
const isSaw = (saw: unknown): boolean => saw === undefined
  || (saw !== null && typeof saw === "object" && !Array.isArray(saw) && Object.entries(saw).every(([o, n]) => o.length > 0 && Number.isSafeInteger(n) && (n as number) >= 0));
function checkSaw(saw: unknown): void {
  if (!isSaw(saw)) throw refuse("join_stamp_saw", "what a write had seen is not an object of whole numbers");
}
const isObject = (o: unknown): o is Record<string, unknown> => typeof o === "object" && o !== null && !Array.isArray(o);
const isText = (v: unknown) => v === null || typeof v === "string";
/** What a copy of a write says of its value, the ONE test of its form for a snapshot and a change bundle alike (review of PR #1853, round 9, point 3): a head's value is a
 *  text or null, or it says it has none (`valueless`, then no value); a stamp's `kept` is absent or null, `{ text }` with a text or null, or `{ none: true }`. */
/** What a write knew beyond its `saw` (review of PR #1907, round 2, point 4): an object or nothing; the keys the merge reads have their form (`from`, the note a
 *  `parent` write moved it from, and `space`, the space a note that went for good was shown in (its tombstone, migration 218 section 8): an id as the database
 *  writes it, lower case, or null (the derivation casts it to uuid and matches it as text: round 3, point 4); `seen`, what a delete had seen: an object of
 *  whole numbers, as `saw`; `quiet`: true or false). Any other key is kept as it came. */
const isNoteIdText = (v: unknown): boolean => v === null || (typeof v === "string" && isUuid(v) && v === v.toLowerCase());
const isMeta = (m: unknown): boolean => m === undefined || m === null || (isObject(m)
  && (!Object.hasOwn(m, "from") || isNoteIdText(m.from)) && (!Object.hasOwn(m, "space") || isNoteIdText(m.space))
  && (!Object.hasOwn(m, "seen") || (m.seen !== undefined && isSaw(m.seen)))
  && (!Object.hasOwn(m, "quiet") || typeof m.quiet === "boolean"));
const isWireHead = (h: unknown): boolean => isObject(h) && (h.value === undefined || isText(h.value))
  && (h.valueless === undefined || h.valueless === false || (h.valueless === true && (h.value ?? null) === null)) && isSaw(h.saw) && isMeta(h.meta);
const isKept = (k: unknown): boolean => k === undefined || k === null || (isObject(k) && Object.keys(k).length === 1 && ((Object.hasOwn(k, "text") && isText(k.text)) || k.none === true));
const isWireStamp = (st: unknown): boolean => isObject(st) && typeof st.rowKey === "string" && st.rowKey.length > 0 && typeof st.field === "string" && st.field.length > 0
  && isSaw(st.saw) && isMeta(st.meta) && isKept(st.kept) && Array.isArray(st.heads) && st.heads.every(isWireHead);
/**
 * A value a stamp says it kept, at the door (a snapshot and a change bundle alike; review of PR #1853, rounds 9 and 10): kept only where a value may be kept (a table
 * whose rows go with their note, a unit a foreign key empties: what migration 215's CHECK says, refused here with a code), an emptied id an id of the key it names
 * (every such key is a uuid: stampedBundleSources.integration.test.ts), and a value like any other: the check of its table's unit (dbUnits.ts RowSource.check).
 */
function keptProblem(st: WireStamp): string | null {
  const kept = st.kept;
  if (!kept || !("text" in kept)) return null;
  const src = UNIT_SOURCES.find((x) => x.label === st.label);
  const cleared = src?.clearedOnDelete?.[st.field];
  if (!src || (!src.goesWithNote && !cleared)) return "a value kept where no value is kept";
  if (cleared && kept.text !== null) {
    const id = (v: unknown) => v === null || v === undefined || (typeof v === "string" && isUuid(v));
    let ok = false;
    if ((src.fields[st.field] ?? "").includes("+")) { try { const o = JSON.parse(kept.text) as Record<string, unknown>; ok = typeof o === "object" && o !== null && cleared.every((c) => id(o[c])); } catch { ok = false; } } else ok = id(kept.text);
    if (!ok) return "a kept id that is not an id";
  }
  return src.check?.row({ texts: { [st.field]: kept.text }, values: undefined, bodyLength: () => undefined }) ?? null;
}

/** Everything about the page that can be checked without writing: shape, tables, columns, workspace, stamps. Returns the readings. */
async function checkPage(page: StampedPage, join: JoinRow, local: string, spacesAlreadyIn: boolean): Promise<ClockReading[]> {
  if (page.dataShape !== SYNC_DATA_SHAPE_VERSION) throw refuse("join_data_shape", `the page has data shape ${String(page.dataShape)}, this node has ${SYNC_DATA_SHAPE_VERSION}: upgrade the older node first`, 409);
  if (page.layer !== "rows") throw refuse("join_layer_not_done", `the ${String(page.layer)} layer is not done yet`);
  if (page.workspaceId !== join.workspace_id) throw refuse("join_wrong_workspace", "the page is of another workspace");
  if (page.source !== join.source_node) throw refuse("join_wrong_source", "the page was made on another node");
  if (page.cut !== Number(join.cut_seq)) throw refuse("join_wrong_cut", "the page belongs to another export of the source (a different cut)");
  if (sortedJson(page.former ?? {}) !== sortedJson(join.source_former)) throw refuse("join_wrong_former", "the page names other former ids of the source than the snapshot's first line");
  if (sortedJson(page.brought ?? {}) !== sortedJson(join.source_brought)) throw refuse("join_wrong_brought", "the page names other origins of the source than the snapshot's first line");
  // the origins the snapshot vouches for: the source, the ids it had before it was restored, the other origins it holds, and the genesis stamp
  const brought = join.source_brought;
  const broughtOrigins = originsOf(brought);
  const vouched = new Set([join.source_node, GENESIS_ORIGIN, ...Object.keys(join.source_former), ...broughtOrigins]);
  // a former id, or another origin the source holds, is held only as far as the source says (markJoinDone writes that number), and the source's own writes up to its
  // cut: a stamp past the number is a lie, as bundle_stamp_beyond_cut is in a bundle
  const beyondFormer = () => refuse("join_stamp_beyond_former", "a stamp of a former id of the source is beyond what the source says it holds of it");
  const beyond = (label: string, w: { origin: string; seq: number }): JoinRefused | null => {
    if (w.origin === join.source_node) return w.seq > Number(join.cut_seq) ? refuse("join_stamp_beyond_cut", "a stamp of the source is beyond the cut of the snapshot") : null;
    if (w.seq > (join.source_former[w.origin] ?? Infinity)) return beyondFormer();
    if (broughtOrigins.has(w.origin) && w.seq > broughtBound(brought, label, w.origin)) return refuse("join_stamp_beyond_brought", "a stamp of another origin the source holds is beyond what the source says it holds of it");
    return null;
  };
  if (!Number.isInteger(page.page) || page.page < 1) throw refuse("join_bad_page", "a page number is a whole number from 1");
  const seen = new Map<string, string>();
  const readings: ClockReading[] = [];
  // The order is part of the format: the rows of a table come after the rows of the tables before it in snapshotTables.json. It matters
  // because writing the workspace and the people makes the database's own triggers add a default space, personal spaces and an owner;
  // those are cleared right after, which would also clear the snapshot's own spaces (and, through them, its notes) if they were in.
  let highest = -1;
  for (const item of page.items) {
    const spec = snapshotSpec(item.table);
    if (!spec) throw refuse("join_table_not_carried", "a table the snapshot does not carry");
    if (item.kind === "row") {
      const at = SNAPSHOT_SPECS.indexOf(spec);
      if (at < highest || (spacesAlreadyIn && (spec.table === "workspaces" || spec.table === "actors"))) throw refuse("join_order", "the rows of the snapshot are not in the order of its table list");
      highest = at;
      const allowed = new Set(await carriedColumns(spec));
      for (const column of Object.keys(item.values)) if (!allowed.has(column)) throw refuse("join_column_not_carried", `a column a snapshot does not carry: ${spec.table}.${column}`);
      const ws = item.values.workspace_id ?? (spec.table === "workspaces" ? item.values.id : undefined);
      if (ws !== undefined && ws !== join.workspace_id) throw refuse("join_wrong_workspace", "a row of another workspace");
      if (spec.table === "actors" && item.values.type === "human" && item.values.external_id != null) throw refuse("join_sign_in_not_carried", "a person's sign-in does not travel in a snapshot");
    } else if (item.kind === "refs") {
      if (!spec.deferred) throw refuse("join_table_not_carried", "refs for a table that has none");
      for (const column of Object.keys(item.values)) if (!spec.deferred.includes(column)) throw refuse("join_column_not_carried", `not a deferred column: ${spec.table}.${column}`);
    }
    for (const stamp of stampsOf(item)) {
      if (stamp.origin === local) throw refuse("join_stamp_from_this_node", "a stamp made on this node cannot come from a snapshot");
      if (!vouched.has(stamp.origin)) throw refuse("join_stamp_origin", "a stamp of an origin the snapshot does not vouch for");
      if (!spec.stamps?.some((d) => d.label === stamp.label)) throw refuse("join_stamp_label", "a stamp of a kind this table does not have");
      if (![stamp.seq, stamp.wall, stamp.counter].every((n) => Number.isSafeInteger(n) && n >= 0)) throw refuse("join_stamp_number", "a stamp number that is not a whole number");
      const past = beyond(stamp.label, stamp);
      if (past) throw past;
      const content = `${stamp.wall}/${stamp.counter}/${stamp.author ?? "~"}/${stamp.device ?? "~"}`;
      const id = `${stamp.origin}/${stamp.seq}`;
      if (seen.has(id) && seen.get(id) !== content) throw refuse("join_stamp_conflict", "one stamp number with two different contents");
      seen.set(id, content);
      readings.push({ wall: stamp.wall, counter: stamp.counter });
      checkSaw(stamp.saw);
      if (!isWireStamp(stamp)) throw refuse("join_stamp_shape", "a stamp that does not say its row, its unit, what it kept and its heads in the format");
      const kept = keptProblem(stamp);
      if (kept) throw refuse("join_stamp_shape", `a value a stamp kept is not one its table holds (${kept})`);
      for (const head of stamp.heads ?? []) {
        if (head.origin === local) throw refuse("join_stamp_from_this_node", "a stamp made on this node cannot come from a snapshot");
        if (!vouched.has(head.origin)) throw refuse("join_stamp_origin", "a stamp of an origin the snapshot does not vouch for");
        if (![head.seq, head.wall, head.counter].every((n) => Number.isSafeInteger(n) && n >= 0)) throw refuse("join_stamp_number", "a stamp number that is not a whole number");
        const headPast = beyond(stamp.label, head);
        if (headPast) throw headPast;
        if (typeof head.contentHash !== "string" || (head.origin === "genesis") !== /^[0-9a-f]{64}$/.test(head.contentHash)) throw refuse("join_head_shape", "a head of a unit that does not say what it holds");
        checkSaw(head.saw);
        readings.push({ wall: head.wall, counter: head.counter });
      }
    }
  }
  return readings;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function insertRows(spec: SnapshotSpec, rows: Record<string, unknown>[]): Promise<void> {
  const cols = await carriedColumns(spec);
  const deferred = new Set(spec.deferred ?? []);
  const placeholders = Object.entries(spec.placeholders ?? {});
  const targets = [...cols, ...placeholders.map(([c]) => c)];
  const picks = [...cols.map((c) => (deferred.has(c) ? "NULL" : `r.${quote(c)}`)), ...placeholders.map(([, expr]) => expr)];
  // a table with no primary key still has a unique index that says when a row is the same one: writing a row again is then a no-op
  const conflict = spec.pk.length === 0 ? "ON CONFLICT DO NOTHING" : `ON CONFLICT (${spec.pk.map(quote).join(", ")}) DO ` +
    (targets.every((c) => spec.pk.includes(c) || deferred.has(c)) ? "NOTHING" : `UPDATE SET ${targets.filter((c) => !spec.pk.includes(c) && !deferred.has(c)).map((c) => `${quote(c)} = EXCLUDED.${quote(c)}`).join(", ")}`);
  await snapshotRows(
    `INSERT INTO ${quote(spec.table)} (${targets.map(quote).join(", ")})
     SELECT ${picks.join(", ")} FROM jsonb_populate_recordset(NULL::${quote(spec.table)}, $1::jsonb) r ${conflict}`, [JSON.stringify(rows)]);
}

async function setRefs(spec: SnapshotSpec, refs: { key: Record<string, unknown>; values: Record<string, unknown> }[]): Promise<void> {
  const deferred = spec.deferred!;
  await snapshotRows(
    `UPDATE ${quote(spec.table)} t SET ${deferred.map((c) => `${quote(c)} = COALESCE(v.${quote(c)}, t.${quote(c)})`).join(", ")}
       FROM jsonb_populate_recordset(NULL::${quote(spec.table)}, $1::jsonb) v WHERE ${spec.pk.map((c) => `t.${quote(c)} = v.${quote(c)}`).join(" AND ")}`,
    [JSON.stringify(refs.map((r) => ({ ...r.key, ...r.values })))]);
}

async function insertStamps(workspaceId: string, stamps: WireStamp[]): Promise<void> {
  if (stamps.length === 0) return;
  await snapshotRows(
    `INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta, kept_value)
     SELECT $1::uuid, s."label", s."rowKey", s.field, s.origin, s.seq, s.wall, s.counter, s.author, s.device, s.deleted, COALESCE(s.saw, '{}'::jsonb), s.meta, s.kept
       FROM jsonb_to_recordset($2::jsonb) AS s("label" text, "rowKey" text, field text, origin text, seq bigint, wall bigint, counter int, author text, device uuid, deleted boolean, saw jsonb, meta jsonb, kept jsonb)
     ON CONFLICT (workspace_id, table_name, row_key, field) DO UPDATE SET
       origin = EXCLUDED.origin, seq = EXCLUDED.seq, hlc_wall = EXCLUDED.hlc_wall, hlc_counter = EXCLUDED.hlc_counter,
       author = EXCLUDED.author, device = EXCLUDED.device, deleted = EXCLUDED.deleted, saw = EXCLUDED.saw, meta = EXCLUDED.meta, kept_value = EXCLUDED.kept_value`,
    [workspaceId, JSON.stringify(stamps)]);
  const withHeads = stamps.filter((s) => s.heads.length > 0);
  if (withHeads.length === 0) return;
  await snapshotRows(
    `INSERT INTO sync_stamp_heads (workspace_id, table_name, row_key, field, origin, seq, content_hash, hlc_wall, hlc_counter, author, device, deleted, saw, meta, value, valueless)
     SELECT $1::uuid, w."label", w."rowKey", w.field, h.origin, h.seq, h."contentHash", h.wall, h.counter, h.author, h.device, h.deleted, COALESCE(h.saw, '{}'::jsonb), h.meta, h.value, COALESCE(h.valueless, false)
       FROM jsonb_to_recordset($2::jsonb) AS w("label" text, "rowKey" text, field text, heads jsonb)
      CROSS JOIN LATERAL jsonb_to_recordset(w.heads) AS h(origin text, seq bigint, "contentHash" text, wall bigint, counter int, author text, device uuid, deleted boolean, saw jsonb, meta jsonb, value text, valueless boolean)
     ON CONFLICT DO NOTHING`,
    [workspaceId, JSON.stringify(withHeads.map((s) => ({ label: s.label, rowKey: s.rowKey, field: s.field, heads: s.heads })))]);
}

/** Rows the database's own triggers make when a workspace or a person is inserted (the default space, a personal space and its
 *  member, the owner) are not the snapshot's: the snapshot's own come after them in the page order. */
async function clearWhatInsertTriggersMade(workspaceId: string): Promise<void> {
  await snapshotRows(`DELETE FROM spaces WHERE workspace_id = $1`, [workspaceId]);
  await snapshotRows(`SELECT set_config('onden.owner_transfer', 'none', true)`);
  await snapshotRows(`UPDATE workspaces SET owner_actor_id = NULL WHERE id = $1`, [workspaceId]);
  await snapshotRows(`SELECT set_config('onden.owner_transfer', '', true)`);
}

async function lockJoin(workspaceId: string): Promise<JoinRow> {
  const row = (await snapshotRows<JoinRow>(
    `SELECT workspace_id::text, source_node, cut_seq::text, source_former, source_brought, state, person_actor_id::text, page_hashes, applied_through FROM sync_join WHERE workspace_id = $1 FOR UPDATE`, [workspaceId])).rows[0];
  if (!row) throw refuse("join_not_started", "no join was started for this workspace", 409);
  return row;
}

/** Write one page. Applying a page again with the same content changes nothing; with other content it is refused. Returns whether
 *  anything was written now. */
export async function applyStampedPage(page: StampedPage): Promise<{ applied: boolean }> {
  return withEventTransaction(page.workspaceId, async () => {
    const join = await lockJoin(page.workspaceId);
    if (join.state !== "joining") throw refuse("join_already_done", "this join is finished", 409);
    const hash = sha256Hex(sortedJson(page));
    const before = join.page_hashes[String(page.page)];
    if (before !== undefined) {
      if (before === hash) return { applied: false };
      throw refuse("join_page_changed", "this page number was already applied with other content", 409);
    }
    const spacesAlreadyIn = (await snapshotRows(`SELECT 1 FROM spaces WHERE workspace_id = $1 LIMIT 1`, [page.workspaceId])).rows.length > 0;
    const readings = await checkPage(page, join, await localNodeId(), spacesAlreadyIn);
    assertForeignClockWithinBound(readings.reduce((m, r) => Math.max(m, r.wall), 0));
    await standAsideForImport(page.workspaceId);

    let written = 0;
    for (let i = 0; i < page.items.length;) {
      const first = page.items[i]!;
      let j = i;
      while (j < page.items.length && page.items[j]!.kind === first.kind && page.items[j]!.table === first.table) j++;
      const group = page.items.slice(i, j);
      const spec = snapshotSpec(first.table)!;
      if (first.kind === "row") {
        await insertRows(spec, group.map((g) => (g as Extract<SnapshotItem, { kind: "row" }>).values));
        await insertStamps(page.workspaceId, group.flatMap(stampsOf));
        written += group.length;
        if (spec.table === "workspaces" || spec.table === "actors") await clearWhatInsertTriggersMade(page.workspaceId);
      } else if (first.kind === "tombstone") {
        await insertStamps(page.workspaceId, group.flatMap(stampsOf));
      } else {
        await setRefs(spec, group.map((g) => g as Extract<SnapshotItem, { kind: "refs" }>));
      }
      i = j;
    }
    await advanceClockFor(page.workspaceId, readings);
    const hashes = { ...join.page_hashes, [String(page.page)]: hash };
    let through = 0;
    while (hashes[String(through + 1)] !== undefined) through++;
    await snapshotRows(
      `UPDATE sync_join SET page_hashes = $2::jsonb, applied_through = $3, rows_applied = rows_applied + $4, import_batches = import_batches + 1 WHERE workspace_id = $1`,
      [page.workspaceId, JSON.stringify(hashes), through, written]);
    return { applied: true };
  });
}

/** The join record of a workspace, as the caller may show it (page numbers and counts only). */
export async function readJoinProgress(workspaceId: string): Promise<{ state: "joining" | "done"; sourceNode: string; cutSeq: number; appliedThrough: number; pages: number[]; rowsApplied: number } | null> {
  const row = (await snapshotRows<{ state: "joining" | "done"; source_node: string; cut_seq: string; applied_through: number; page_hashes: Record<string, string>; rows_applied: string }>(
    `SELECT state, source_node, cut_seq::text, applied_through, page_hashes, rows_applied::text FROM sync_join WHERE workspace_id = $1`, [workspaceId])).rows[0];
  return row ? { state: row.state, sourceNode: row.source_node, cutSeq: Number(row.cut_seq), appliedThrough: row.applied_through, pages: Object.keys(row.page_hashes).map(Number).sort((a, b) => a - b), rowsApplied: Number(row.rows_applied) } : null;
}

/** The two databases hold different things: which tables, rows or stamps, and by how many (counts only, never content). */
class JoinDigestMismatch extends CodedStatusError {
  constructor(readonly differences: DigestDifference[]) {
    super(409, "join_digest_mismatch", `the copy differs from the source in: ${differences.map((d) => `${d.table} (${d.what}, ${d.countDifference >= 0 ? "+" : ""}${d.countDifference})`).join(", ")}`);
  }
}

/** All `pages` pages are in, what this database holds equals what the source said it sent (`digest`), no (origin, seq) names two
 *  contents, and nothing a stamp trigger would stamp is left without one (migration 202's pass finds none; it also takes this database's
 *  own baseline of the structure). Then the join is done and the person's sign-in, when one is given, is linked to the person's row.
 *  ONE transaction under the workspace's write lock: the digest is of exactly what becomes the workspace and nothing can be written
 *  between the comparison and "done". The digest is of the whole workspace (a snapshot fills an empty one, so what is there is what was
 *  sent: equal exactly when nothing was lost, added or changed); it needs no operator, so nothing of the request stands in for one.
 *  Refuses (nothing changes) when any of that is not so.
 *
 *  WHO THE SIGN-IN BECOMES: the person the hello named (`join.person_actor_id`) must be a human AND the owner of the snapshot's workspace
 *  (only an owner exports); nothing else of a request picks a person, a role or a permission. */
export async function markJoinDone(workspaceId: string, expected: { pages: number; digest: TableDigest[] }, localLogin: string | null): Promise<void> {
  await withEventTransaction(workspaceId, async () => {
    const join = await lockJoin(workspaceId);
    if (join.state !== "joining") throw refuse("join_already_done", "this join is finished", 409);
    for (let p = 1; p <= expected.pages; p++) if (join.page_hashes[String(p)] === undefined) throw refuse("join_page_missing", `page ${p} did not arrive`, 409);
    if (Object.keys(join.page_hashes).length !== expected.pages) throw refuse("join_page_extra", "more pages arrived than the snapshot has", 409);
    const differences = compareDigests(expected.digest, await computeSnapshotDigest(workspaceId, wholeWorkspace));
    if (differences.length > 0) throw new JoinDigestMismatch(differences);
    const clash = await snapshotRows(
      `SELECT 1 FROM (SELECT origin, seq, hlc_wall, hlc_counter, author, device FROM sync_stamps WHERE workspace_id = $1
                      UNION ALL SELECT origin, seq, hlc_wall, hlc_counter, author, device FROM sync_stamp_heads WHERE workspace_id = $1) x GROUP BY origin, seq
        HAVING count(DISTINCT md5(concat_ws('/', hlc_wall, hlc_counter, COALESCE(author, '~'), COALESCE(device::text, '~')))) > 1 LIMIT 1`, [workspaceId]);
    if (clash.rows.length > 0) throw refuse("join_stamp_conflict", "one stamp number with two different contents", 409);
    if (join.person_actor_id) {
      const person = (await snapshotRows<{ type: string; owner: boolean }>(
        `SELECT a.type, (w.owner_actor_id = a.id) IS TRUE AS owner FROM actors a JOIN workspaces w ON w.id = a.workspace_id WHERE a.id = $1 AND a.workspace_id = $2`,
        [join.person_actor_id, workspaceId])).rows[0];
      if (person?.type !== "human") throw refuse("join_person_missing", "the snapshot names a person it does not hold", 409);
      if (!person.owner) throw refuse("join_person_not_owner", "the snapshot names a person who does not own the workspace", 409);
      if (localLogin !== null) await snapshotRows(`UPDATE actors SET external_id = $1 WHERE id = $2 AND workspace_id = $3`, [localLogin, join.person_actor_id, workspaceId]);
    }
    const pass = (await snapshotRows<{ stamps_added: string }>(`SELECT * FROM sync_genesis_pass()`)).rows[0];
    if (Number(pass?.stamps_added ?? 0) > 0) {
      // the tables of the stamps this very transaction just wrote (their xmin is its id)
      const added = await snapshotRows<{ t: string }>(`SELECT DISTINCT table_name AS t FROM sync_stamps WHERE workspace_id = $1 AND xmin::text = (txid_current() % 4294967296)::text ORDER BY 1`, [workspaceId]);
      const tables = added.rows.map((r) => r.t);
      throw refuse("join_unstamped_rows", `the snapshot left rows without a stamp (${tables.join(", ")})`, 409);
    }
    // the node this workspace was filled from is the first origin it accepts bundles from (migration 206), held up to the cut of the snapshot
    await snapshotRows(
      `INSERT INTO sync_origins (workspace_id, origin, vouched_by, have) VALUES ($1, $2, 'snapshot', $3::jsonb)
       ON CONFLICT (workspace_id, origin) DO NOTHING`, [workspaceId, join.source_node, JSON.stringify(haveOfAll(Number(join.cut_seq)))]);
    // the ids the source had before it was restored: origins the source brought (vouched_by = the source, as applyChangeBundle writes them; not a sender), held up to what the source held
    for (const [origin, held] of Object.entries(join.source_former)) {
      await snapshotRows(
        `INSERT INTO sync_origins (workspace_id, origin, vouched_by, have) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (workspace_id, origin) DO NOTHING`,
        [workspaceId, origin, join.source_node, JSON.stringify(haveOfAll(held))]);
    }
    // the other origins the source holds: origins the source brought (vouched_by = the source, not a sender), each held per label exactly as far as the source held it,
    // so this node knows what its source knew and a bundle from anyone who holds more sends only what is new (checkPage took no stamp of them past these numbers)
    for (const origin of [...originsOf(join.source_brought)].sort()) {
      const have = Object.fromEntries(Object.entries(join.source_brought).flatMap(([label, of]) => (Object.hasOwn(of, origin) ? [[label, of[origin]!]] : [])));
      await snapshotRows(
        `INSERT INTO sync_origins (workspace_id, origin, vouched_by, have) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (workspace_id, origin) DO NOTHING`,
        [workspaceId, origin, join.source_node, JSON.stringify(have)]);
    }
    await snapshotRows(`UPDATE sync_join SET state = 'done', finished_at = now() WHERE workspace_id = $1`, [workspaceId]);
  });
}

/** Give up: everything the snapshot wrote is removed (the workspace and what it owns, its stamps, its clock, the join record), and the
 *  empty shell is made again in the same transaction (db.ts ensureShellWorkspace, the one definition boot uses) with the person who was
 *  joining back in it (restoreShellPerson): the database is empty AND usable the moment this returns. */
export async function cancelJoin(workspaceId: string): Promise<void> {
  await withTransaction(async () => {
    const row = (await snapshotRows<{ state: string }>(`SELECT state FROM sync_join WHERE workspace_id = $1 FOR UPDATE`, [workspaceId])).rows[0];
    if (!row) return;
    if (row.state !== "joining") throw refuse("join_already_done", "a finished join is not cancelled; the workspace is in use", 409);
    const run = { query: (text: string, params?: unknown[]) => snapshotRows<any>(text, params) };
    const person = await discardUnfinishedJoins(run, workspaceId);
    // The empty workspace again, in this process: the person can sign in and join again without a restart.
    await ensureShellWorkspace(run, nativeBypassEnabled());
    if (person) await restoreShellPerson(run, person);
  });
}

/** The one place the stamp triggers stand aside for a merge (the counted exception, sync_clock.merge_batches). A workspace with no clock yet, or one that is being joined, takes nothing. */
async function openMerge(workspaceId: string): Promise<void> {
  await standAsideForImport(workspaceId, "merge");
  // A merge looks every row up by its key, while the rows of the bundle grow the tables inside ONE transaction: every statement of it is planned for the tables
  // as they are now (db.ts; stampedBundleScale.integration.test.ts counts the rows).
  await planThisTransactionForTablesAsTheyAre();
  const active = (await snapshotRows<{ on: boolean }>(`SELECT sync_import_active($1::uuid) AS on`, [workspaceId])).rows[0]!.on;
  if (!active) throw refuse("merge_not_open", "this workspace does not take merged units now (it has no clock yet, or it is being joined)", 409);
}

/**
 * Writes units received from another node into a workspace that is not being joined, with the stamps they came with (the merge core's answer,
 * spine/stampedMerge/dbUnits.ts). The same switch as a snapshot import (migrations 204 / 205 `sync_import_active`, reason "merge"): the stamp triggers stand
 * aside for this transaction, which counts in sync_clock.merge_batches. It decides nothing about who may write: the caller has checked the sender, and domain
 * effects of a changed row are the caller's too. A change bundle is taken by `applyChangeBundle` below, which is the product's entry; this one is for single units.
 */
export async function mergeUnitsIntoWorkspace(workspaceId: string, incoming: readonly IncomingUnit[], gate?: SkewGate): Promise<UnitMergeReport> {
  return withEventTransaction(workspaceId, async () => {
    await openMerge(workspaceId);
    return storeMergedUnits(workspaceId, incoming, gate);
  });
}

/** What taking a bundle did. */
type BundleReport = RowsReport & {
  sender: string;
  /** For each label and origin the receiver now holds further than before (or knew nothing of): the number it holds now (a Have). */
  advanced: Record<string, Record<string, number>>;
};

/**
 * Admit `node` to this workspace: its bundles are taken from now on. THE ONLY WAY a node that did not give this one its snapshot becomes a sender (with star transport the
 * centre admits each device once; a device admits the centre by taking its snapshot). Who may admit is the caller's to decide (the owner, in the pairing step, a later batch).
 * Holding nothing of it yet is `have = 0`. Admitting again changes nothing. This node's own node id is not admitted (it is this node).
 * An origin this node knows only because another node brought it (vouched_by is that node's id: a bundle's sender or a snapshot's source, markJoinDone) BECOMES a sender,
 * keeping what this node holds of it: a node that joined from B holds A's writes as far as B did, and taking A's bundles from there sends only what is new
 * (snapshotBrought.integration.test.ts, A→B, B→C, then C↔A). An id this node had itself (`self-restore`) never becomes one.
 */
export async function admitSyncNode(workspaceId: string, node: string, vouchedBy = "admitted"): Promise<void> {
  if (!node || node === GENESIS_ORIGIN) throw refuse("sync_bad_node", "a node id is needed");
  await withEventTransaction(workspaceId, async () => {
    if (node === (await localNodeId())) throw refuse("sync_node_is_self", "this node is not admitted to itself", 409);
    const known = (await snapshotRows<{ vouched_by: string }>(`SELECT vouched_by FROM sync_origins WHERE workspace_id = $1 AND origin = $2 FOR UPDATE`, [workspaceId, node])).rows[0];
    // a row whose vouched_by is a node id is an origin that node brought: it becomes a sender, what this node holds of it (`have`) stays
    if (known && isNodeId(known.vouched_by) && (vouchedBy === "snapshot" || vouchedBy === "admitted")) {
      await snapshotRows(`UPDATE sync_origins SET vouched_by = $3 WHERE workspace_id = $1 AND origin = $2`, [workspaceId, node, vouchedBy]);
    } else if (!known) {
      await snapshotRows(`INSERT INTO sync_origins (workspace_id, origin, vouched_by) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, origin) DO NOTHING`, [workspaceId, node, vouchedBy]);
    }
  });
}
const GENESIS_ORIGIN = "genesis";

const isOrigin = (o: string): boolean => o === GENESIS_ORIGIN || isNodeId(o);
/** What a header says of a label's origin, -1 when it says nothing: its own keys only (review of PR #1907, round 1, point 12: `holds["constructor"]` is Object's function,
 *  and a comparison with it is false, so a stamp of that origin passed the beyond-cut check). */
const heldOf = (have: Have, label: string, origin: string): number => haveAt(have, label, origin) ?? -1;
/** Every (label, origin, number) of a Have. */
const entriesOf = (have: Have): [string, string, number][] => Object.entries(have).flatMap(([label, of]) => Object.entries(of).map(([o, n]) => [label, o, n] as [string, string, number]));

function checkBundleShape(workspaceId: string, bundle: ChangeBundle): void {
  if (bundle.layer !== "changes" || bundle.scope !== BUNDLE_SCOPE) throw bundleRefused("bundle_scope", "this is not a change bundle of this node's stamped tables", 422);
  if (bundle.dataShape !== SYNC_DATA_SHAPE_VERSION) throw bundleRefused("bundle_data_shape", `the bundle has data shape ${String(bundle.dataShape)}, this node has ${SYNC_DATA_SHAPE_VERSION}: the older node has to be upgraded first`);
  if (bundle.workspaceId !== workspaceId) throw bundleRefused("bundle_wrong_workspace", "the bundle is of another workspace", 422);
  // the header's numbers are per label and origin (data shape 6); the form before it, one number per origin, is refused with its own code, never read as labels
  normalizeHave(bundle.base);
  normalizeHave(bundle.upTo);
  normalizeHave(bundle.holds);
  if (!isNodeId(bundle.sender) || !Number.isSafeInteger(bundle.cut) || bundle.cut < 0) throw bundleRefused("bundle_malformed", "a bundle names its sender by its node id, and its cut", 422);
  // every origin it speaks of is a node id (or genesis), in its header and in its stamps
  if (![...originsOf(bundle.upTo), ...originsOf(bundle.holds), ...originsOf(bundle.base)].every(isOrigin)) throw bundleRefused("bundle_malformed", "a bundle names an origin that is not a node id", 422);
  // the receiver holds after the bundle at most what the sender holds
  if (entriesOf(bundle.upTo).some(([label, o, n]) => n > heldOf(bundle.holds, label, o))) throw bundleRefused("bundle_malformed", "a bundle says its receiver will hold more than its sender holds", 422);
  if (!Array.isArray(bundle.items)) throw bundleRefused("bundle_malformed", "a bundle's items are a list", 422);
  for (const item of bundle.items) {
    // the form of an item, before anything reads it (review of PR #1853, round 7, point 2: a wrong form was a TypeError, never a coded refusal): a row with its list of
    // stamps, or a tombstone with one stamp; each stamp an object with a list of heads; each head's value a text or null; `meta` in its form (isMeta)
    const it = item as unknown as Record<string, unknown>;
    const wire = isObject(it) && it.kind === "row" ? it.stamps : isObject(it) && it.kind === "tombstone" ? [it.stamp] : undefined;
    if (!Array.isArray(wire) || !wire.every(isWireStamp)) {
      throw bundleRefused("bundle_malformed", "an item of the bundle is a row with its stamps or a tombstone with its stamp: each stamp names its row and unit by text, says what it had seen as an object of whole numbers, what it knew beyond (meta: a note it was moved from is a note id), and has its list of heads, each head's value a text or null", 422);
    }
    // only the labels this node carries (stampedMerge/dbUnits.ts CARRIED_LABELS): anything else is not a bundle of this shape
    if (!CARRIED_LABELS.includes(item.table)) throw bundleRefused("bundle_scope", "a bundle item of a table a bundle does not carry", 422);
    // A row item is a row the sender holds: it carries the row's values and each unit's text, both objects. A row the sender does not hold travels as its stamps
    // (`kind: "tombstone"` items, spine/stampedBundle.ts), each with the value it kept when it has one; its values are checked as any other (dbRows.ts checkReceived),
    // and a row item without values or texts is not a bundle of this shape (review of PR #1853, round 6, point 1).
    const objects = item.kind !== "row" || [item.values, item.texts].every((o) => typeof o === "object" && o !== null && !Array.isArray(o));
    if (item.kind === "row" && !(objects && Object.values(item.texts).every((t) => t === null || typeof t === "string"))) {
      throw bundleRefused("bundle_malformed", "a row of the bundle carries its values and the text of its units (a row the sender does not hold travels as its stamps)", 422);
    }
    const stamps = item.kind === "row" ? item.stamps : [item.stamp];
    if (stamps.some((s) => !CARRIED_LABELS.includes(s.label))) throw bundleRefused("bundle_scope", "a stamp of a table a bundle does not carry", 422);
    for (const st of stamps) { const why = keptProblem(st); if (why) throw bundleRefused("bundle_malformed", `a value a stamp kept is not one it may keep (${st.label}.${st.field}: ${why})`, 422); }
    for (const s of stamps) for (const w of [s, ...s.heads]) {
      if (![w.seq, w.wall, w.counter].every((n) => Number.isSafeInteger(n) && n >= 0)) throw bundleRefused("bundle_malformed", "a stamp number that is not a whole number", 422);
      if (!isOrigin(w.origin)) throw bundleRefused("bundle_malformed", "a stamp of the bundle names an origin that is not a node id", 422);
      if (w.origin === GENESIS_ORIGIN) continue;
      // nothing of an origin beyond what the sender says it holds of that label: a stamp past the cut is a read that was not one snapshot, or a lie
      if (w.seq > heldOf(bundle.holds, s.label, w.origin)) throw bundleRefused("bundle_stamp_beyond_cut", "a stamp of the bundle is beyond what its sender says it holds", 422);
    }
  }
}

/** The highest clock reading among the stamps the receiver does not hold yet: a row is sent whole, so a bundle also carries stamps the receiver has (its own, or below `base`), and what it made itself is no foreign clock. */
function foreignWall(bundle: ChangeBundle, local: string): number {
  let max = 0;
  for (const item of bundle.items) for (const s of item.kind === "row" ? item.stamps : [item.stamp]) for (const w of [s, ...s.heads]) {
    if (w.origin === GENESIS_ORIGIN || w.origin === local || w.seq <= (haveAt(bundle.base, s.label, w.origin) ?? 0)) continue;
    max = Math.max(max, w.wall);
  }
  return max;
}

/**
 * THE ONE ENTRY that takes a change bundle (spine/stampedBundle.ts readChangeBundle made it): the stamps another node has and this one does not, for the units of every table of UNIT_SOURCES and their JSON keys,
 * merged by the merge core, ONE transaction for the whole bundle, with the same stand-aside switch as a snapshot (reason "merge", `openMerge`): there is no second bypass.
 * Refused whole, nothing written, with a code the caller branches on:
 *   bundle_data_shape        another SYNC_DATA_SHAPE_VERSION (spine/syncDataShape.ts)
 *   bundle_unknown_sender    the sender is not an origin this workspace accepts (sync_origins: its snapshot's source, or a node `admitSyncNode` admitted)
 *   bundle_gap               per label and origin the bundle starts past what this node holds (`base` > held): take a snapshot instead
 *   bundle_stamp_clash       a stamp (origin, seq) this node already holds is in the bundle with other content (a restored backup or a cloned profile made it twice)
 *   bundle_sender_restored   the sender holds less of ITSELF than this node does (it was restored from an older copy; also refused when it reads, spine/stampedBundle.ts)
 *   bundle_own_origin_ahead  the bundle says its sender holds writes of THIS node's origin beyond what this node ever made: this node was restored from an older backup
 *   bundle_stamp_beyond_cut, bundle_malformed, bundle_scope, bundle_wrong_workspace, bundle_from_self   the bundle is not what it says
 *   bundle_bad_have, bundle_have_per_origin   its base, upTo or holds is not a Have (per label and origin); the second: it is the form before data shape 6
 *   stamp_clock_ahead        a clock further ahead than the bound (spine/stamps.ts): offer it again later
 *   merge_not_open           this workspace is being joined, or has no clock
 * Taken a second time, a bundle changes nothing. The same stamp with the same content is skipped (re-delivery); knowledge only moves forward.
 *   bundle_no_derivation     nothing filled spine/receivedDerivation.ts (services/receivedDerivation.ts was not loaded): a bundle is never taken without what follows from it
 *   bundle_derivation_failed (422) a step of what follows from the rows failed in a way the same bundle would fail again (services/receivedDerivation.ts names the step and notes)
 * What follows from the rows (their links, paragraph rows' display, trash and purge, spaces, slugs, types, the website copy, the membership epoch) is derived in the same
 * transaction once every row is in (spine/receivedDerivation.ts; batch 4a): it writes no unit.
 * Not done here, on purpose: who may send (`admitSyncNode`'s caller), the tables not carried yet (NOT_CARRIED_YET in test/stampedBundleSources.integration.test.ts), domain events of a received change (batch 4b), a transport.
 */
export async function applyChangeBundle(workspaceId: string, bundle: ChangeBundle): Promise<BundleReport> {
  checkBundleShape(workspaceId, bundle);
  return withEventTransaction(workspaceId, async () => {
    await openMerge(workspaceId);
    const local = await localNodeId();
    if (bundle.sender === local) throw bundleRefused("bundle_from_self", "a bundle made by this node is not taken by this node");
    assertForeignClockWithinBound(foreignWall(bundle, local));
    const rows = (await snapshotRows<{ origin: string; vouched_by: string; have: Record<string, number> }>(`SELECT origin, vouched_by, have FROM sync_origins WHERE workspace_id = $1`, [workspaceId])).rows;
    // what this node holds of each origin, per label (a label it never took: 0); an origin without a row is one it knows nothing of
    const known = new Map(rows.map((r) => [r.origin, r.have] as const));
    const heldHere = (label: string, origin: string): number => known.get(origin)?.[label] ?? 0;
    // a SENDER is a node this one was given by its snapshot or admitted; an origin another sender brought is accepted in stamps (it is vouched for) but is not a sender: star transport, a device exchanges with the centre only
    if (!rows.some((r) => r.origin === bundle.sender && (r.vouched_by === "snapshot" || r.vouched_by === "admitted"))) throw bundleRefused("bundle_unknown_sender", "this workspace does not take bundles from that node (it was not admitted)");
    const ownMax = Number((await snapshotRows<{ next_seq: string }>(`SELECT next_seq FROM sync_clock WHERE workspace_id = $1`, [workspaceId])).rows[0]?.next_seq ?? 1) - 1;
    if (entriesOf(bundle.holds).some(([, o, n]) => o === local && n > ownMax)) throw bundleRefused("bundle_own_origin_ahead", "the sender holds writes of this node that this node never made: it was restored from an older copy");
    if (entriesOf(bundle.base).some(([label, o, n]) => o === bundle.sender && n > (haveAt(bundle.upTo, label, o) ?? 0))) throw bundleRefused("bundle_sender_restored", "the bundle claims less of its sender than this node holds of it: the sender was restored from an older copy");
    // (`holds`: what the sender has of the origin; its `upTo` can stop lower, below a write it withheld from this reader, and still bring writes past it). Label by label: a
    // label this node holds less of than the bundle starts from is a gap even when every other label of that origin is not
    for (const [label, origin, holds] of entriesOf(bundle.holds)) {
      if (origin === local) continue;
      const base = haveAt(bundle.base, label, origin) ?? 0, mine = heldHere(label, origin);
      if (base > mine && holds > mine) throw bundleRefused("bundle_gap", `the bundle starts after what this node holds of ${origin} (${label}): take a snapshot instead`);
    }
    // what follows from the rows written here (spine/receivedDerivation.ts): never a bundle without it
    const derivation = receivedDerivation();
    if (!derivation) throw bundleRefused("bundle_no_derivation", "this node cannot work out what follows from received rows (services/receivedDerivation.ts is not loaded): nothing was taken");
    const prepared = await derivation.before(workspaceId, bundle.items);
    const report = await storeMergedRows(workspaceId, bundle.items);
    if (report.rejected.length) {
      const clash = report.rejected.some((r) => r.reason === "same-stamp-different-content");
      const first = report.rejected[0]!;
      throw clash ? bundleRefused("bundle_stamp_clash", `a stamp this node already holds is in the bundle with other content (unit ${first.unit ?? "?"} of row ${first.row} of ${first.table ?? "?"}): one of the two nodes was restored or copied`) : bundleRefused("bundle_malformed", `a write of the bundle is not in the format${first.reason === "malformed" && first.unit ? ` (${first.table ?? "?"}: ${first.unit})` : ""}`, 422);
    }
    // the finishing step: links, paragraph rows, trash and purge, spaces, types, the site, the epoch (batch 4a), once every row of the bundle is in
    await deriving("the finishing step", [], () => derivation.after(prepared, { workspaceId, units: report.events, followedSpaces: report.followedSpaces }));
    // knowledge only moves forward, label by label: an origin this node knew nothing of is written with every label the bundle names (vouched by the sender)
    const advanced: Record<string, Record<string, number>> = {};
    const moved = new Map<string, Record<string, number>>();
    for (const [label, origin, upTo] of entriesOf(bundle.upTo)) {
      if (origin === local) continue;
      const mine = known.get(origin)?.[label], next = Math.max(mine ?? 0, upTo);
      if (!known.has(origin) || mine === undefined || next > mine) {
        (advanced[label] ??= {})[origin] = next;
        moved.set(origin, { ...moved.get(origin), [label]: next });
      }
    }
    for (const [origin, have] of [...moved].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      await snapshotRows(
        `INSERT INTO sync_origins (workspace_id, origin, vouched_by, have) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (workspace_id, origin) DO UPDATE SET have = sync_origins.have || $4::jsonb`, [workspaceId, origin, bundle.sender, JSON.stringify(have)]);
    }
    const readings = bundle.items.flatMap((item) => (item.kind === "row" ? item.stamps : [item.stamp]).flatMap((s) => [s, ...s.heads].filter((w) => w.origin !== local).map((w) => ({ wall: w.wall, counter: w.counter }))));
    await advanceClockFor(workspaceId, readings);
    return { ...report, sender: bundle.sender, advanced };
  });
}
