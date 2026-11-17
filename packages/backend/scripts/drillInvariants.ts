// Restore-drill invariants (scripts/restore-drill.sh; 說明在 docs/agents/deploy.md「還原演練」).
//
//   tsx drillInvariants.ts snapshot --database-url <url> --out <file.json>
//   tsx drillInvariants.ts compare  --before <a.json> --after <b.json>
//        [--migrations-dir <dir>] [--media-dir <dir>] [--report <file.json>] [--node-renewed]
//
// --node-renewed: the drill gave the restored database a new node id between the two snapshots (scripts/lib/renewNodeId.sh);
// `node_id_renewed` then checks it (nodeRenewalFailures). No migration can declare it away.
//
// `snapshot` reads a database (read-only) and writes counts, per-note hashes,
// structural violations and media references. `compare` judges BEFORE vs AFTER
// the migrations, prints a short Traditional Chinese summary and exits 1 on any
// violation. Nothing here prints note content: only counts, ids and sha256.
//
// To add a check: a COUNTS row (count that must stay equal or only grow), or a
// STRUCTURE row (a query returning offending ids; must be empty after).
// A migration that legitimately changes something declares it in its own SQL:
//   -- drill: allows <name>[, <name>…]   (a COUNTS/STRUCTURE name, or
//                                          note-bodies / note-titles)
// Declared changes are listed, not failed; undeclared ones fail.

import { assertDisposableDatabase } from "../../../scripts/lib/disposableDb.mjs";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import pg from "pg";
// Source, not the package: the drill must not need a built dist.
import { mediaRefs } from "../../markdown/src/mediaRefs.js";

type Rule = "equal" | "non-decreasing";

interface CountSpec {
  name: string;
  label: string;
  rule: Rule;
  /** `table` or `table.column` that must exist for the count to be taken. */
  requires: string[];
  /** The query, or one built from what the database holds (a table a migration folds into another). */
  sql: string | ((c: pg.Client) => Promise<string>);
}

const LIVE = "deleted_at IS NULL";
// Saved views moved from content_nodes.collection_views into function_refs (migration 188). Before the upgrade the
// views are in the column, after it in the references (the column is frozen): the count reads the one the database has,
// so a board lost or a tab dropped by the move shows as a difference.
const whiteboard = async (c: pg.Client): Promise<string> => (await exists(c, "function_refs"))
  ? `(node_type = 'canvas' OR (node_type = 'content' AND EXISTS (
  SELECT 1 FROM function_refs r WHERE r.holder_node_id = content_nodes.id AND r.instance <> '' AND r.function_id = 'canvas')))`
  : `(node_type = 'canvas' OR (node_type = 'content' AND EXISTS (
  SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(collection_views) = 'array' THEN collection_views ELSE '[]'::jsonb END) v
   WHERE v->>'layout' = 'canvas')))`;
const COUNTS: CountSpec[] = [
  { name: "notes_live", label: "筆記", rule: "equal", requires: ["content_nodes.deleted_at"], sql: `SELECT count(*) FROM content_nodes WHERE node_type='content' AND ${LIVE}` },
  { name: "notes_deleted", label: "垃圾桶筆記", rule: "equal", requires: ["content_nodes.deleted_at"], sql: `SELECT count(*) FROM content_nodes WHERE node_type='content' AND deleted_at IS NOT NULL` },
  { name: "tags_live", label: "標籤", rule: "equal", requires: ["content_nodes.deleted_at"], sql: `SELECT count(*) FROM content_nodes WHERE node_type='class_tag' AND ${LIVE}` },
  { name: "tags_deleted", label: "垃圾桶標籤", rule: "equal", requires: ["content_nodes.deleted_at"], sql: `SELECT count(*) FROM content_nodes WHERE node_type='class_tag' AND deleted_at IS NOT NULL` },
  { name: "canvases_live", label: "白板", rule: "equal", requires: ["content_nodes.deleted_at"], sql: `SELECT count(*) FROM content_nodes WHERE node_type='canvas' AND ${LIVE}` },
  { name: "canvases_deleted", label: "垃圾桶白板", rule: "equal", requires: ["content_nodes.deleted_at"], sql: `SELECT count(*) FROM content_nodes WHERE node_type='canvas' AND deleted_at IS NOT NULL` },
  // The whiteboard is a view of a note since migration 138: a board is a node of
  // the retired kind 'canvas' or a note with a whiteboard tab, and its cards are
  // placements on its own id. Converting moves a board between the two kinds
  // above; these two counts show that none was lost.
  { name: "whiteboards_live", label: "白板（含白板分頁的筆記）", rule: "equal", requires: ["content_nodes.deleted_at"], sql: async (c) => `SELECT count(*) FROM content_nodes WHERE ${await whiteboard(c)} AND ${LIVE}` },
  { name: "whiteboards_deleted", label: "垃圾桶白板（含白板分頁的筆記）", rule: "equal", requires: ["content_nodes.deleted_at"], sql: async (c) => `SELECT count(*) FROM content_nodes WHERE ${await whiteboard(c)} AND deleted_at IS NOT NULL` },
  { name: "board_cards", label: "白板上的卡片", rule: "equal", requires: ["node_positions"], sql: `SELECT count(*) FROM node_positions WHERE surface <> 'graph'` },
  // A note's own card on its own board is the one card migration 139 drops (a board
  // does not hold its note); every other card must survive a fold, so this count
  // stays equal while board_cards goes down by the cards dropped.
  { name: "board_cards_not_self", label: "白板上的卡片（不含筆記自己那張）", rule: "equal", requires: ["node_positions"], sql: `SELECT count(*) FROM node_positions WHERE surface <> 'graph' AND surface <> node_id::text` },
  // Migration 172 gave the whiteboard's pen layer its own attribute (board_ink) next to
  // the handwriting page's (ink_data). A move keeps both counts below; a copy of an
  // ambiguous page adds a board_ink row, so the row counts are declared by 172 and the
  // two checks that show no drawing was lost are these: the notes holding a drawing
  // page and the bytes of drawing data.
  { name: "ink_pages_notes", label: "有筆跡的筆記（手寫頁或白板）", rule: "equal", requires: ["node_attributes"], sql: `SELECT count(DISTINCT node_id) FROM node_attributes WHERE key IN ('ink_data', 'board_ink', 'note_ink')` },
  { name: "ink_bytes", label: "筆跡資料的大小", rule: "non-decreasing", requires: ["node_attributes"], sql: `SELECT COALESCE(sum(octet_length(value)), 0) FROM node_attributes WHERE key IN ('ink_data', 'board_ink', 'note_ink')` },
  { name: "ink_data_rows", label: "手寫頁／PDF 的筆跡屬性", rule: "equal", requires: ["node_attributes"], sql: `SELECT count(*) FROM node_attributes WHERE key = 'ink_data'` },
  { name: "note_ink_rows", label: "筆記手寫分頁的筆跡屬性", rule: "equal", requires: ["node_attributes"], sql: `SELECT count(*) FROM node_attributes WHERE key = 'note_ink'` },
  { name: "board_ink_rows", label: "白板筆跡屬性", rule: "equal", requires: ["node_attributes"], sql: `SELECT count(*) FROM node_attributes WHERE key = 'board_ink'` },
  // A big drawing's earlier versions are chunks of its note (migration 203): none may be lost by a restore or an upgrade.
  { name: "ink_manifests", label: "分塊存放的筆跡版本", rule: "equal", requires: ["ink_manifests"], sql: `SELECT count(*) FROM ink_manifests` },
  { name: "ink_chunks", label: "筆跡的區塊", rule: "equal", requires: ["ink_chunks"], sql: `SELECT count(*) FROM ink_chunks` },
  { name: "edges", label: "連結", rule: "equal", requires: ["node_edges"], sql: `SELECT count(*) FROM node_edges` },
  { name: "node_tags", label: "標籤套用", rule: "equal", requires: ["node_tags"], sql: `SELECT count(*) FROM node_tags` },
  { name: "attributes", label: "屬性", rule: "equal", requires: ["node_attributes"], sql: `SELECT count(*) FROM node_attributes` },
  // Tasks are notes carrying the task tag (reserved key 'task' before migration 135, the tasks module tag
  // (tag_schema.module) after it), or, since migration 191, notes referencing the tasks function.
  { name: "tasks", label: "任務", rule: "equal", requires: ["node_tags", "content_nodes.reserved_key", "content_nodes.deleted_at"],
    sql: async (c) => `SELECT count(DISTINCT id) FROM (
            SELECT nt.node_id AS id FROM node_tags nt
              JOIN content_nodes t ON t.id = nt.tag_id AND (t.reserved_key = 'task' OR t.tag_schema->>'module' = 'tasks')
              JOIN content_nodes n ON n.id = nt.node_id AND n.${LIVE}
            ${(await exists(c, "function_refs")) ? `UNION
            SELECT r.holder_node_id FROM function_refs r
              JOIN content_nodes n ON n.id = r.holder_node_id AND n.${LIVE}
             WHERE r.function_id = 'tasks' AND r.instance = ''` : ""}
          ) x` },
  { name: "spaces", label: "空間", rule: "equal", requires: ["spaces"], sql: `SELECT count(*) FROM spaces` },
  { name: "actors", label: "成員／代理", rule: "equal", requires: ["actors"], sql: `SELECT count(*) FROM actors` },
  { name: "events", label: "事件紀錄", rule: "non-decreasing", requires: ["domain_events"], sql: `SELECT count(*) FROM domain_events` },
  // The two side tables a stamp migration (202) writes: they may only grow, so a migration that took stamps away fails the drill.
  { name: "write_stamps", label: "寫入來源標記", rule: "non-decreasing", requires: ["sync_stamps"], sql: `SELECT count(*) FROM sync_stamps` },
  { name: "structure_log_lines", label: "結構變更紀錄", rule: "non-decreasing", requires: ["structure_log"], sql: `SELECT count(*) FROM structure_log` },
  // Each person's schedule per card. Before migration 183 a block's lived in block_review_states.
  { name: "review_progress", label: "複習進度", rule: "equal", requires: ["review_states"],
    sql: async (c) => (await exists(c, "block_review_states"))
      ? `SELECT (SELECT count(*) FROM review_states) + (SELECT count(*) FROM block_review_states) AS count`
      : `SELECT count(*) FROM review_states` },
];

interface StructureSpec {
  name: string;
  label: string;
  requires: string[];
  /** Returns offending ids as `id`, one row each. */
  sql: string;
}

const STRUCTURE: StructureSpec[] = [
  { name: "orphan_parent", label: "父層不存在的節點", requires: ["content_nodes.parent_id"],
    sql: `SELECT c.id::text AS id FROM content_nodes c WHERE c.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM content_nodes p WHERE p.id = c.parent_id)` },
  { name: "note_under_tag", label: "掛在標籤底下的筆記", requires: ["content_nodes.parent_id"],
    sql: `SELECT c.id::text AS id FROM content_nodes c JOIN content_nodes p ON p.id = c.parent_id
           WHERE c.node_type = 'content' AND p.node_type = 'class_tag'` },
  { name: "node_tags_missing_node", label: "套用標籤但筆記不存在", requires: ["node_tags"],
    sql: `SELECT nt.node_id::text || ':' || nt.tag_id::text AS id FROM node_tags nt WHERE NOT EXISTS (SELECT 1 FROM content_nodes n WHERE n.id = nt.node_id)` },
  { name: "node_tags_missing_tag", label: "套用的標籤不存在", requires: ["node_tags"],
    sql: `SELECT nt.node_id::text || ':' || nt.tag_id::text AS id FROM node_tags nt WHERE NOT EXISTS (SELECT 1 FROM content_nodes t WHERE t.id = nt.tag_id AND t.node_type = 'class_tag')` },
  { name: "edges_missing_end", label: "連結的一端不存在", requires: ["node_edges"],
    sql: `SELECT e.id::text AS id FROM node_edges e WHERE NOT EXISTS (SELECT 1 FROM content_nodes n WHERE n.id = e.source_node_id)
             OR NOT EXISTS (SELECT 1 FROM content_nodes n WHERE n.id = e.target_node_id)` },
  // Every drawing version an event names must still be readable: a whole `blobs` row or a manifest of its note with all its chunks.
  { name: "ink_version_unreadable", label: "事件指到、但已經讀不到的筆跡版本", requires: ["blobs", "ink_manifests", "domain_events"],
    sql: `SELECT DISTINCT e.id::text AS id FROM domain_events e, unnest(ARRAY[e.payload->>'value_ref', e.tx_meta->'prev_field_values'->>'value_ref']) AS r(ref)
           WHERE e.event_type IN ('ATTRIBUTE_SET', 'ATTRIBUTE_DELETED') AND e.payload->>'key' IN ('ink_data', 'board_ink', 'note_ink') AND r.ref IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.hash = r.ref)
             AND NOT EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id::text = e.target_id AND m.hash = r.ref
                               AND NOT EXISTS (SELECT 1 FROM generate_series(0, length(m.chunks) / 32 - 1) g
                                                WHERE NOT EXISTS (SELECT 1 FROM ink_chunks c WHERE c.node_id = m.node_id
                                                                    AND c.hash = encode(substring(m.chunks FROM g * 32 + 1 FOR 32), 'hex'))))` },
  { name: "attributes_missing_node", label: "屬性所屬筆記不存在", requires: ["node_attributes"],
    sql: `SELECT a.id::text AS id FROM node_attributes a WHERE NOT EXISTS (SELECT 1 FROM content_nodes n WHERE n.id = a.node_id)` },
];

// Declarations a migration can make beyond the COUNTS/STRUCTURE names.
const BODY_DECLARATIONS = ["note-bodies", "note-titles"] as const;

interface NoteHash { t: string; m: string }
export interface Snapshot {
  takenAt: string;
  counts: Record<string, number | null>;
  structure: Record<string, string[] | null>;
  /** live content_nodes id → sha256 of title / markdown (every node type). */
  notes: Record<string, NoteHash>;
  /** live-note id → media ids its markdown or attribute values reference. */
  mediaRefs: Record<string, string[]>;
  eventMaxId: number | null;
  migrations: string[];
  /** Who this database is as a node (migration 190 onward; null before). Ids and hashes only. */
  node?: NodeState | null;
}

/** The node's identity and what it numbered, for `node_id_renewed`. */
export interface NodeState {
  id: string | null;
  /** workspace → its clock: the next sequence number of the node's own origin and the clock reading. */
  clocks: Record<string, { next: number; wall: number; counter: number }>;
  /** workspace → the largest clock reading of any stamp or other head it holds. */
  top: Record<string, { wall: number; counter: number }>;
  /** every stamp and other head of an origin other than genesis: `kind|workspace|table|row|field[|seq:content hash] origin` → sha256 of the whole row. */
  stamps: Record<string, string>;
  /** `${workspace} ${origin}` → the sync_origins row (migration 206 onward). */
  origins: Record<string, { vouched: string; have: number }>;
}

async function exists(c: pg.Client, requirement: string): Promise<boolean> {
  const [table, column] = requirement.split(".");
  if (!column) return (await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`])).rows[0].ok;
  return (await c.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2) AS ok`,
    [table, column])).rows[0].ok;
}
async function available(c: pg.Client, requires: string[]): Promise<boolean> {
  for (const r of requires) if (!(await exists(c, r))) return false;
  return true;
}

/** The drill only ever touches a throwaway local database named `*_drill`. */
export function assertDrillDatabase(url: string | undefined): asserts url is string {
  try {
    assertDisposableDatabase(url, "drill", { localOnly: true });
  } catch {
    console.error("拒絕執行：資料庫必須在本機，且名稱以 _drill 結尾");
    process.exit(2);
  }
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export async function takeSnapshot(url: string): Promise<Snapshot> {
  assertDrillDatabase(url);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
    const counts: Snapshot["counts"] = {};
    for (const s of COUNTS) {
      counts[s.name] = (await available(c, s.requires))
        ? Number((await c.query(typeof s.sql === "string" ? s.sql : await s.sql(c))).rows[0].count) : null;
    }
    const structure: Snapshot["structure"] = {};
    for (const s of STRUCTURE) structure[s.name] = (await available(c, s.requires)) ? (await c.query(s.sql)).rows.map((r) => r.id as string) : null;

    const notes: Snapshot["notes"] = {};
    const refs: Snapshot["mediaRefs"] = {};
    const liveFilter = (await exists(c, "content_nodes.deleted_at")) ? `WHERE ${LIVE}` : "";
    for (const r of (await c.query(`SELECT id::text, title, markdown FROM content_nodes ${liveFilter} ORDER BY id`)).rows) {
      notes[r.id] = { t: sha(r.title), m: sha(r.markdown) };
      const ids = mediaRefs(r.markdown as string);
      if (ids.length) refs[r.id] = ids;
    }
    if (await exists(c, "node_attributes")) {
      const attrs = await c.query(
        `SELECT a.node_id::text AS id, a.value FROM node_attributes a JOIN content_nodes n ON n.id = a.node_id
          ${liveFilter ? `WHERE n.${LIVE} AND` : "WHERE"} a.value LIKE '%/api/media/%'`);
      for (const r of attrs.rows) {
        const ids = mediaRefs(r.value as string);
        if (ids.length) refs[r.id] = [...new Set([...(refs[r.id] ?? []), ...ids])];
      }
    }
    const eventMaxId = (await exists(c, "domain_events"))
      ? Number((await c.query(`SELECT coalesce(max(id),0) AS m FROM domain_events`)).rows[0].m) : null;
    const migrations = (await exists(c, "schema_migrations"))
      ? (await c.query(`SELECT version FROM schema_migrations ORDER BY version`)).rows.map((r) => r.version as string) : [];
    const node = await nodeState(c);
    await c.query("ROLLBACK");
    return { takenAt: new Date().toISOString(), counts, structure, notes, mediaRefs: refs, eventMaxId, migrations, node };
  } finally {
    await c.end();
  }
}

async function nodeState(c: pg.Client): Promise<NodeState | null> {
  if (!(await exists(c, "sync_node")) || !(await exists(c, "sync_clock")) || !(await exists(c, "sync_stamps"))) return null;
  const id = ((await c.query(`SELECT node_id FROM sync_node WHERE singleton`)).rows[0]?.node_id as string | undefined) ?? null;
  const clocks: NodeState["clocks"] = {};
  for (const r of (await c.query(`SELECT workspace_id::text AS ws, next_seq::text AS n, hlc_wall::text AS w, hlc_counter AS k FROM sync_clock`)).rows) {
    clocks[r.ws] = { next: Number(r.n), wall: Number(r.w), counter: Number(r.k) };
  }
  const heads = await exists(c, "sync_stamp_heads");
  const top: NodeState["top"] = {};
  for (const r of (await c.query(`SELECT DISTINCT ON (ws) ws, w, k FROM (
      SELECT workspace_id::text AS ws, hlc_wall AS w, hlc_counter AS k FROM sync_stamps
      ${heads ? "UNION ALL SELECT workspace_id::text, hlc_wall, hlc_counter FROM sync_stamp_heads" : ""}) x ORDER BY ws, w DESC, k DESC`)).rows) {
    top[r.ws] = { wall: Number(r.w), counter: Number(r.k) };
  }
  const stamps: NodeState["stamps"] = {};
  for (const r of (await c.query(`SELECT 's|' || workspace_id || '|' || table_name || '|' || row_key || '|' || field || ' ' || origin AS key, to_jsonb(s)::text AS v FROM sync_stamps s WHERE origin <> 'genesis'`)).rows) stamps[r.key] = sha(r.v);
  if (heads) for (const r of (await c.query(`SELECT 'h|' || workspace_id || '|' || table_name || '|' || row_key || '|' || field || '|' || seq || ':' || content_hash || ' ' || origin AS key, to_jsonb(h)::text AS v FROM sync_stamp_heads h WHERE origin <> 'genesis'`)).rows) stamps[r.key] = sha(r.v);
  const origins: NodeState["origins"] = {};
  if (await exists(c, "sync_origins")) {
    for (const r of (await c.query(`SELECT workspace_id::text AS ws, origin, vouched_by, COALESCE((have->>'content_nodes')::bigint, 0)::text AS have FROM sync_origins`)).rows) {
      origins[`${r.ws} ${r.origin}`] = { vouched: r.vouched_by, have: Number(r.have) };
    }
  }
  return { id, clocks, top, stamps, origins };
}

/** `node_id_renewed` (the drill ran scripts/lib/renewNodeId.sh between the two snapshots): the database is a new node; the old id's stamps are
 *  kept as they were (none written or rewritten under it); the old id's numbering became an origin this node holds, up to at least its last
 *  number; every clock reads at least the largest reading the backup held. Returns the failures (empty when it holds). Ids and counts only. */
export function nodeRenewalFailures(before: NodeState | null | undefined, after: NodeState | null | undefined): string[] {
  if (!after) return ["沒有節點資料表（sync_node）"];
  const out: string[] = [];
  if (!after.id) out.push("還原後的資料庫沒有節點編號");
  // a backup older than migration 190 had no node id: the one the database has now was made after the restore
  if (!before?.id) return out;
  const old = before.id;
  if (after.id === old) out.push(`節點編號沒有換（仍是 ${old}）`);
  const underOld = Object.entries(after.stamps).filter(([key]) => key.endsWith(` ${old}`));
  const rewritten = underOld.filter(([key, h]) => before.stamps[key] !== h).map(([key]) => key);
  if (rewritten.length) out.push(`${rewritten.length} 筆舊編號的寫入標記是還原後寫的或被改寫：${first(rewritten)}`);
  for (const [ws, clock] of Object.entries(before.clocks)) {
    const row = after.origins[`${ws} ${old}`];
    if (clock.next > 1 && (!row || row.vouched !== "self-restore" || row.have < clock.next - 1)) {
      out.push(`工作區 ${ws}：舊編號沒有變成「握有到第 ${clock.next - 1} 號」的來源`);
    }
    const top = before.top[ws], now = after.clocks[ws];
    if (top && now && (now.wall < top.wall || (now.wall === top.wall && now.counter < top.counter))) out.push(`工作區 ${ws}：時鐘比備份握有的寫入標記還早`);
  }
  return out;
}

/** Names declared by the migrations that ran between the two snapshots. */
export function declarations(dir: string | undefined, applied: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!dir) return out;
  for (const version of applied) {
    let sql: string;
    try { sql = readFileSync(join(dir, `${version}.sql`), "utf8"); } catch { continue; }
    for (const m of sql.matchAll(/^--\s*drill:\s*allows\s+(.+)$/gim)) {
      for (const name of m[1]!.split(",").map((s) => s.trim()).filter(Boolean)) {
        out.set(name, [...(out.get(name) ?? []), version]);
      }
    }
  }
  return out;
}

export function listFiles(dir: string): Set<string> {
  const files = new Set<string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p); else files.add(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return files;
}

export interface Verdict { lines: string[]; failures: number; report: Record<string, unknown> }

const first = (ids: string[], n = 10) => ids.slice(0, n).join(", ") + (ids.length > n ? ` …（共 ${ids.length}）` : "");

export function compare(before: Snapshot, after: Snapshot, opts: { migrationsDir?: string; mediaFiles?: Set<string>; /** the drill gave the restored database a new node id between the snapshots */ nodeRenewed?: boolean }): Verdict {
  const applied = after.migrations.filter((v) => !before.migrations.includes(v));
  const declared = declarations(opts.migrationsDir, applied);
  const lines: string[] = [];
  const notes: string[] = [];
  let failures = 0;
  const fail = (msg: string) => { failures++; lines.push(`✗ ${msg}`); };
  const declaredNote = (name: string, msg: string) => notes.push(`△ ${msg}（migration ${declared.get(name)!.join("、")} 已聲明 ${name}）`);

  lines.push(`套用的 migration：${applied.length ? applied.join("、") : "無（備份已是最新版）"}`);

  for (const s of COUNTS) {
    const b = before.counts[s.name], a = after.counts[s.name];
    if (b === null && a === null) continue;
    if (b !== null && a === null) { fail(`${s.label}：資料表在 migration 後消失（${b} → 無）`); continue; }
    if (b === null || a === null) continue; // table added by a migration
    const ok = s.rule === "equal" ? a === b : a >= b;
    if (ok) continue;
    const msg = `${s.label}數量 ${b} → ${a}`;
    if (declared.has(s.name)) declaredNote(s.name, msg); else fail(`${msg}（${s.rule === "equal" ? "應相同" : "不可減少"}）`);
  }
  if (before.eventMaxId !== null && after.eventMaxId !== null && after.eventMaxId < before.eventMaxId) {
    fail(`事件紀錄最大編號 ${before.eventMaxId} → ${after.eventMaxId}（不可倒退）`);
  }

  const bodyChanged: string[] = [], titleChanged: string[] = [], gone: string[] = [];
  for (const [id, h] of Object.entries(before.notes)) {
    const n = after.notes[id];
    if (!n) { gone.push(id); continue; }
    if (n.m !== h.m) bodyChanged.push(id);
    if (n.t !== h.t) titleChanged.push(id);
  }
  if (gone.length) {
    if (declared.has("notes_gone")) declaredNote("notes_gone", `${gone.length} 個節點不再是現行狀態：${first(gone)}`);
    else fail(`${gone.length} 個現行節點消失或被丟進垃圾桶：${first(gone)}`);
  }
  for (const [name, ids, label] of [["note-bodies", bodyChanged, "內文"], ["note-titles", titleChanged, "標題"]] as const) {
    if (!ids.length) continue;
    const msg = `${ids.length} 個節點的${label}雜湊改變：${first(ids)}`;
    if (declared.has(name)) declaredNote(name, msg); else fail(`${msg}（沒有 migration 聲明改寫）`);
  }

  for (const s of STRUCTURE) {
    const a = after.structure[s.name];
    if (!a || a.length === 0) continue;
    const b = new Set(before.structure[s.name] ?? []);
    const fresh = a.filter((id) => !b.has(id));
    const old = a.length - fresh.length;
    const origin = fresh.length ? `其中 ${fresh.length} 筆是 migration 造成：${first(fresh)}` : "全部在 migration 前就存在";
    const msg = `${s.label}：${a.length} 筆（${origin}${old && fresh.length ? `；${old} 筆原本就有` : ""}）`;
    if (declared.has(s.name)) declaredNote(s.name, msg); else fail(msg);
  }

  let missingTotal = 0;
  if (opts.mediaFiles) {
    const missing = new Set<string>();
    const noteIds: string[] = [];
    for (const [noteId, ids] of Object.entries(after.mediaRefs)) {
      // content.tar is the content volume: uploads sit under media/.
      const lost = ids.filter((id) => !opts.mediaFiles!.has(`media/${id}`) && !opts.mediaFiles!.has(id));
      lost.forEach((id) => missing.add(id));
      if (lost.length) noteIds.push(noteId);
    }
    missingTotal = missing.size;
    if (missing.size) fail(`${missing.size} 個被現行筆記引用的媒體檔不在 content.tar：${first([...missing])}（涉及筆記 ${first(noteIds, 5)}）`);
    else lines.push(`媒體檔：${new Set(Object.values(after.mediaRefs).flat()).size} 個被引用的檔案都在 content.tar`);
  }

  let nodeRenewal: string[] | null = null;
  if (opts.nodeRenewed) {
    nodeRenewal = nodeRenewalFailures(before.node, after.node);
    for (const f of nodeRenewal) fail(`node_id_renewed：${f}`);
    if (!nodeRenewal.length) lines.push(`節點編號：已換新（${before.node?.id ?? "備份沒有"} → ${after.node?.id}），舊編號的寫入標記一筆都沒變`);
  }

  lines.push(...notes);
  const report = { applied, failures, bodyChanged: bodyChanged.length, titleChanged: titleChanged.length, gone: gone.length, missingMedia: missingTotal,
    nodeIdRenewed: nodeRenewal === null ? null : nodeRenewal.length === 0 };
  return { lines, failures, report };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function need(name: string): string {
  const v = arg(name);
  if (!v) { console.error(`缺少 --${name}`); process.exit(2); }
  return v;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === "snapshot") {
    const snap = await takeSnapshot(need("database-url"));
    writeFileSync(need("out"), JSON.stringify(snap));
    const n = Object.keys(snap.notes).length;
    console.log(`快照完成：${n} 個現行節點，${Object.values(snap.counts).filter((v) => v !== null).length} 項計數`);
  } else if (cmd === "compare") {
    const before = JSON.parse(readFileSync(need("before"), "utf8")) as Snapshot;
    const after = JSON.parse(readFileSync(need("after"), "utf8")) as Snapshot;
    const mediaDir = arg("media-dir");
    const v = compare(before, after, { migrationsDir: arg("migrations-dir"), mediaFiles: mediaDir ? listFiles(mediaDir) : undefined, nodeRenewed: process.argv.includes("--node-renewed") });
    for (const l of v.lines) console.log(l);
    const reportPath = arg("report");
    if (reportPath) writeFileSync(reportPath, JSON.stringify(v.report));
    process.exit(v.failures ? 1 : 0);
  } else {
    console.error("用法：drillInvariants.ts snapshot|compare …");
    process.exit(2);
  }
}
