// The HISTORY PART of a stamped snapshot (docs/architecture/proposals/history-replication-2026-11-22.md §3.1, §3.4, §4.3; batch 3): a note's versions
// (note_versions with their positions, migration 220) and the content they name, after the rows. One file for the three halves, so the form of an item, its
// check and its write are named once: the export reads here (services/stampedSnapshot.ts readHistoryPages, inside its read snapshot), the import entry checks
// and writes here (spine/stampedImport.ts applyStampedPage, the one entry), and both sides compute the same digest here. Batch 4 (versions in a change bundle)
// takes the same items and the same checks.
//
//   source:   planHistory (one pass) → readHistoryItems: blobs layer (content by hash: a body or a small drawing as a blob, a big drawing's chunks then its
//             manifest) → history layer (the versions) → sentHistoryDigests
//   receiver: each page in order, checked whole before anything is written; then markHistoryDone compares the digests.
//
// WHICH VERSIONS (the "history as of the cut"): those of a note the rows carry (the notes rule of the reader's scope, services/readPolicy.ts snapshotScope), whose
// content this node holds, with at least one position (origin, seq) that is not this node's own past the cut. A version is minted in the transaction of its
// write, with that transaction's sequence number (spine/noteVersions.ts recordVersion), and numbers commit in order (spine/stampedBundle.ts, THE CUT): so this
// set is the same in any later read snapshot, except a note deleted for good in between (its versions went with it). That is why the history part can be read
// in a read snapshot of its own after the rows, and read again to resume. A position of another origin (a version this node received) is never past a cut of
// this node's; batch 4, which makes other origins' versions arrive in bundles, bounds them by the history label's numbers.
//
// COST (review of PR #1988, round 1, point 2c): the set is worked out ONCE (planHistory: one statement over the workspace's versions); every later read fetches
// by key, a chunk at a time, so the reads grow with the number of versions and the size of their content, not faster (snapshotHistoryCost.integration.test.ts
// counts the rows read). The plan holds one small record per version in memory (a few hundred bytes).
//
// CONTENT FIRST: every content item of the history part comes before the first version, so a version arrives when its content is already stored, and the commit
// check of migration 220 (note_versions_content_stored) holds without standing aside. A version whose content the source does not hold is not sent: it is
// COUNTED (`leftOut` of the digest, kept in sync_join.history_left_out) so both sides can see it (review point 6); "the history part is complete" means
// "everything the source could send arrived". On a source of this batch every version holds its content (migration 220's check made sure when it was minted).
//
// NEVER DUPLICATED: a blob is sent once per hash (blobs is keyed by hash), a chunk once per (note, hash), a manifest once per (note, hash); the receiver writes each
// only when it is not there. A page is checked whole before anything is written, and written in the caller's one transaction: a refusal leaves nothing.
//
// THE DIGEST is order-free: the sorted list of each version's own digest (SQL note_version_digest, migration 229: every identity field, §2.5, and its positions;
// a baseline's time and recorded_by are this node's record and left out) and the sorted list of the content held for them, with how many versions the source left
// out and how many name a `restored_from` that is not in the set. A receiver that deleted a note for good while the history part was arriving keeps the digests of
// the versions it skipped (sync_join.history_skipped) and adds them, so its own delete does not keep the history part from completing (review point 4b).

import { NODE_MARKDOWN_MAX, UUID_SOURCE, isUuid } from "@onden/markdown";
import { CodedStatusError } from "../statusError.js";
import { sha256Hex } from "../utils.js";
import { baselineVersionKey, isImportedAt, legacyVersionKey } from "./versionIdentity.js";
import { snapshotRows, type ScopeFactory } from "./snapshotSql.js";
import { assertForeignClockWithinBound } from "./stamps.js";

class HistoryRefused extends CodedStatusError {}
const refuse = (code: string, message: string, status: 409 | 422 = 422) => new HistoryRefused(status, code, message);

/** A version as it travels: every field of note_versions a copy keeps (§2.3), with its positions. `recordedBy` is the minting node (this node's record, §2.5:
 *  kept as the first copy said it, never compared); the others are its identity and are compared with a copy already held (`join_history_clash`). */
type WireVersion = {
  noteId: string; unit: string; key: string; kind: string; title: string | null; contentHash: string | null; at: string;
  wall: number | null; counter: number | null; ordinal: number; recordedBy: string; authorKind: string; authorId: string | null;
  restoredFrom: string | null; sourceName: string | null;
  /** Where it travels from (note_version_positions): a set of [origin, seq]. */
  positions: [string, number][];
};

export type HistoryItem =
  /** `inkOnly`: no text version of the history part names this content (only drawings do): a receiver that keeps the text history only leaves it out. */
  | { kind: "blob"; hash: string; content: string; inkOnly?: true }
  | { kind: "ink_chunk"; noteId: string; hash: string; content: string }
  /** `chunks`: the chunk hashes in order, as one hex text (64 characters each). */
  | { kind: "ink_manifest"; noteId: string; hash: string; chunks: string }
  | { kind: "version"; version: WireVersion };

/** A page of the history part. The header is a rows page's (spine/snapshotSql.ts StampedPage), with the same source, cut, former and brought; the page numbers
 *  count the history part on its own, from 1: its `blobs` pages, then its `history` pages. `inkBytes`: what the drawings' earlier versions take (their chunks,
 *  manifests and the blobs only they name: the measure of the proposal's §10 question 4), the same on every page: the receiver decides from it what it keeps.
 *  `textOnly`: the source itself holds the text history only (a browser copy over the drawings' threshold, or a device that took its notes from one): its
 *  drawings' earlier versions are not in the file, so the receiver keeps the text history only too and says so, never "all of them" (review of PR #1988 round 2). */
export type HistoryPage = {
  layer: "blobs" | "history"; dataShape: number; page: number; cut: number; source: string;
  former: Record<string, number>; brought: Record<string, Record<string, number>>; workspaceId: string; inkBytes: number; textOnly: boolean; items: HistoryItem[];
};

/** What the versions and their content add up to, counts and hashes only (no title, text or id). `leftOut`: versions the source holds without their content
 *  (not sent); `dangling`: versions whose `restored_from` names a version not in the set. */
type HistoryDigest = { versions: number; versionsHash: string; contents: number; contentsHash: string; leftOut: number; dangling: number };
/** The digest of the whole history part, and of its text history only (what a receiver that leaves the drawings' history out must hold). */
export type HistoryDigests = { all: HistoryDigest; body: HistoryDigest };
/** What a receiver keeps of the history part: all of it, or the text history only (the browser version over the drawings' threshold: §10 question 4). */
export type HistoryScope = "all" | "body";

/** One version as the digest sees it: `k` its address (note/unit/key), `nu` its note and unit, `h` its own digest, `c` its content's key when held. */
type DigestRow = { k: string; nu: string; h: string; c: string | null; unit: string; restoredFrom: string | null };
/** A version a receiver did not store because it deleted the note for good while the history part was arriving: what the digest needs of it. */
export type SkippedVersion = DigestRow;

const UNITS = ["body", "ink_data", "board_ink", "note_ink"];
const KINDS = ["created", "updated", "restored", "baseline", "set_aside", "removed"]; // `merged` comes with batch 6 (`m:` keys); refused until then
const AUTHOR_KINDS = ["person", "ai", "automatic", "session", "merge"];
const HASH = /^[0-9a-f]{64}$/;
const S_KEY = new RegExp(`^s:(${UUID_SOURCE}):(\\d{1,15}):(\\d{1,9})$`);
const DIGEST_KEY = /^[gb]:[0-9a-f]{64}$/;
/** The longest chunk a drawing is cut into: services/inkChunker.ts cuts by it, and a received chunk is refused beyond it (one number; spine does not import services). */
export const MAX_INK_CHUNK_CHARS = 64 * 1024;
/** The largest value a history item may carry or a manifest may make: a drawing's value travels whole in one line of the rows (services/stampedSnapshotStream.ts
 *  MAX_SNAPSHOT_LINE_BYTES), so none of its earlier values is larger. A text's earlier value is at most a note's (NODE_MARKDOWN_MAX, checked per version). */
const MAX_HISTORY_VALUE_CHARS = 64 * 1024 * 1024;

const ITEM_FIELDS: Record<string, readonly string[]> = {
  blob: ["kind", "hash", "content", "inkOnly"], ink_chunk: ["kind", "noteId", "hash", "content"], ink_manifest: ["kind", "noteId", "hash", "chunks"], version: ["kind", "version"],
};
const VERSION_FIELDS = ["noteId", "unit", "key", "kind", "title", "contentHash", "at", "wall", "counter", "ordinal", "recordedBy", "authorKind", "authorId", "restoredFrom", "sourceName", "positions"];

// ── Which versions ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A position that is in the history as of `cut` of `source`: one of another origin, or the source's own up to the cut. Over alias `p`. */
const positionAsOf = (src: string, cut: string) => `(p.origin <> ${src} OR p.seq <= ${cut})`;

/** The content of version `v` is held here: its blob, or (a drawing) this note's manifest with every chunk it lists. */
/** One row of `table` per key of the caller's list, looked up by its index: a join the planner may not turn into a scan of the whole table per chunk of keys
 *  (it does when the table is small next to the chunk, which makes reading the history part grow faster than the versions; snapshotHistoryCost.integration.test.ts). */
const byKey = (table: string, alias: string, on: string) => `CROSS JOIN LATERAL (SELECT * FROM ${table} ${alias} WHERE ${on} LIMIT 1) ${alias}`;
const receivedByKey = byKey("note_versions", "v", 'v.note_id = w."noteId" AND v.unit = w.unit AND v.version_key = w.key AND v.workspace_id = $1');
const versionByKey = byKey("note_versions", "v", "v.note_id = w.note AND v.unit = w.unit AND v.version_key = w.key");

const contentHeldSql = `(EXISTS (SELECT 1 FROM blobs b WHERE b.hash = v.content_hash)
  OR (v.unit <> 'body' AND EXISTS (SELECT 1 FROM ink_manifests m WHERE m.node_id = v.note_id AND m.hash = v.content_hash
        AND NOT EXISTS (SELECT 1 FROM generate_series(0, length(m.chunks) / 32 - 1) i
                         WHERE NOT EXISTS (SELECT 1 FROM ink_chunks c WHERE c.node_id = m.node_id AND c.hash = encode(substring(m.chunks FROM i * 32 + 1 FOR 32), 'hex'))))))`;

/** One sent version, as the plan keeps it. */
type Planned = { noteId: string; unit: string; key: string; contentHash: string | null };
/** The history part of a snapshot, worked out once (planHistory): what is sent, what was left out, what the drawings take. */
type HistoryPlan = { workspaceId: string; source: string; cut: number; sent: Planned[]; leftOut: { all: number; body: number }; inkBytes: number };

const CHUNK = 200;
const chunksOf = <T>(list: readonly T[], size = CHUNK): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/** The history part of `workspaceId` as `source` holds it at `cut`, worked out in one statement over the workspace's versions (in the caller's read snapshot),
 *  and what the drawings' part of it takes. */
export async function planHistory(workspaceId: string, scopeOf: ScopeFactory, at: { source: string; cut: number }): Promise<HistoryPlan> {
  const params: unknown[] = [workspaceId];
  const scope = scopeOf(params);
  const src = `$${params.push(at.source)}`, upTo = `$${params.push(at.cut)}::bigint`;
  const rows = (await snapshotRows<{ note: string; unit: string; key: string; hash: string | null; held: boolean }>(
    `SELECT v.note_id::text AS note, v.unit, v.version_key AS key, v.content_hash AS hash, (v.content_hash IS NULL OR ${contentHeldSql}) AS held
       FROM note_versions v
      WHERE v.workspace_id = $1 AND ${scope.node("v.note_id")}
        AND EXISTS (SELECT 1 FROM note_version_positions p WHERE p.note_id = v.note_id AND p.unit = v.unit AND p.version_key = v.version_key AND ${positionAsOf(src, upTo)})
      ORDER BY v.note_id, v.unit COLLATE "C", v.version_key COLLATE "C"`, params)).rows;
  const sent = rows.filter((r) => r.held).map((r) => ({ noteId: r.note, unit: r.unit, key: r.key, contentHash: r.hash }));
  const missing = rows.filter((r) => !r.held);
  const bodyHashes = [...new Set(sent.filter((v) => v.unit === "body").map((v) => v.contentHash!))];
  const inkPairs = [...new Map(sent.filter((v) => v.unit !== "body" && v.contentHash).map((v) => [`${v.noteId}/${v.contentHash}`, v] as const)).values()];
  let inkBytes = 0;
  const seenNotes = new Set<string>();
  for (const part of chunksOf(inkPairs, 1000)) {
    const r = (await snapshotRows<{ manifests: string; blobs: string; notes: string[] | null }>(
      `WITH w AS (SELECT * FROM unnest($1::uuid[], $2::text[]) AS w(note, hash)),
            m AS (SELECT m.node_id, m.chunks FROM w ${byKey("ink_manifests", "m", "m.node_id = w.note AND m.hash = w.hash")})
       SELECT COALESCE((SELECT sum(length(m.chunks)) FROM m), 0)::text AS manifests,
              COALESCE((SELECT sum(b.size_bytes) FROM (SELECT DISTINCT hash FROM w) d ${byKey("blobs", "b", "b.hash = d.hash")} WHERE NOT (b.hash = ANY($3::text[]))), 0)::text AS blobs,
              (SELECT array_agg(DISTINCT node_id::text) FROM m) AS notes`,
      [part.map((v) => v.noteId), part.map((v) => v.contentHash), bodyHashes])).rows[0]!;
    inkBytes += Number(r.manifests) + Number(r.blobs);
    for (const n of r.notes ?? []) seenNotes.add(n);
  }
  // the chunks of the drawings that have a manifest in the part: what a receiver stores of them (each once per note)
  for (const part of chunksOf([...seenNotes], 1000)) {
    inkBytes += Number((await snapshotRows<{ n: string }>(`SELECT COALESCE(sum(size_bytes), 0)::text AS n FROM ink_chunks WHERE node_id = ANY($1::uuid[])`, [part])).rows[0]!.n);
  }
  return { workspaceId, source: at.source, cut: at.cut, sent, leftOut: { all: missing.length, body: missing.filter((r) => r.unit === "body").length }, inkBytes };
}

// ── Export ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The items of the history part, in the order a receiver takes them (content, then versions), each with its layer. Fetched by key from the plan, a chunk at a time,
 *  in the caller's read snapshot. */
export async function readHistoryItems(plan: HistoryPlan, add: (layer: "blobs" | "history", item: HistoryItem) => Promise<void>): Promise<void> {
  const bodyHashes = new Set(plan.sent.filter((v) => v.unit === "body").map((v) => v.contentHash!));
  // blobs: every content hash of a sent version that is stored whole, once, in hash order
  const hashes = [...new Set(plan.sent.flatMap((v) => (v.contentHash ? [v.contentHash] : [])))].sort();
  for (const part of chunksOf(hashes)) {
    const rows = (await snapshotRows<{ hash: string; content: string }>(`SELECT b.hash, b.content FROM unnest($1::text[]) AS w(hash) ${byKey("blobs", "b", "b.hash = w.hash")} ORDER BY b.hash COLLATE "C"`, [part])).rows;
    for (const r of rows) await add("blobs", bodyHashes.has(r.hash) ? { kind: "blob", hash: r.hash, content: r.content } : { kind: "blob", hash: r.hash, content: r.content, inkOnly: true });
  }
  // a big drawing's versions: per note, the chunks its manifests list (each once), then the manifests
  const pairs = [...new Set(plan.sent.flatMap((v) => (v.unit !== "body" && v.contentHash ? [`${v.noteId}/${v.contentHash}`] : [])))].sort();
  let note: string | null = null;
  let chunksSent = new Set<string>();
  for (const part of chunksOf(pairs, 50)) {
    const manifests = (await snapshotRows<{ note: string; hash: string; chunks: string }>(
      `SELECT m.node_id::text AS note, m.hash, encode(m.chunks, 'hex') AS chunks
         FROM unnest($1::uuid[], $2::text[]) AS w(note, hash) ${byKey("ink_manifests", "m", "m.node_id = w.note AND m.hash = w.hash AND m.workspace_id = $3")}
        ORDER BY m.node_id, m.hash COLLATE "C"`,
      [part.map((p) => p.split("/")[0]!), part.map((p) => p.split("/")[1]!), plan.workspaceId])).rows;
    for (const m of manifests) {
      if (m.note !== note) { note = m.note; chunksSent = new Set(); }
      const wanted = [...new Set(chunkHashesOf(m.chunks))].filter((h) => !chunksSent.has(h));
      for (const chunk of chunksOf(wanted)) {
        const stored = (await snapshotRows<{ hash: string; content: string }>(
          `SELECT c.hash, c.content FROM unnest($2::text[]) WITH ORDINALITY AS w(hash, n) ${byKey("ink_chunks", "c", "c.node_id = $1::uuid AND c.hash = w.hash")} ORDER BY w.n`,
          [m.note, chunk])).rows;
        for (const c of stored) { chunksSent.add(c.hash); await add("blobs", { kind: "ink_chunk", noteId: m.note, hash: c.hash, content: c.content }); }
      }
      await add("blobs", { kind: "ink_manifest", noteId: m.note, hash: m.hash, chunks: m.chunks });
    }
  }
  // the versions, with their positions as of the cut
  for (const part of chunksOf(plan.sent)) {
    const rows = (await snapshotRows<WireVersion>(
      `SELECT v.note_id::text AS "noteId", v.unit, v.version_key AS key, v.kind, v.title, v.content_hash AS "contentHash", v.at, v.clock_wall::float8 AS wall,
              v.clock_counter AS counter, v.ordinal, v.recorded_by AS "recordedBy", v.author_kind AS "authorKind", v.author_id::text AS "authorId",
              v.restored_from AS "restoredFrom", v.source_name AS "sourceName",
              (SELECT jsonb_agg(jsonb_build_array(p.origin, p.seq) ORDER BY p.origin COLLATE "C", p.seq) FROM note_version_positions p
                WHERE p.note_id = v.note_id AND p.unit = v.unit AND p.version_key = v.version_key AND ${positionAsOf("$4", "$5::bigint")}) AS positions
         FROM unnest($1::uuid[], $2::text[], $3::text[]) AS w(note, unit, key) ${versionByKey}
        ORDER BY v.note_id, v.unit COLLATE "C", v.version_key COLLATE "C"`,
      [part.map((v) => v.noteId), part.map((v) => v.unit), part.map((v) => v.key), plan.source, plan.cut])).rows;
    for (const version of rows) await add("history", { kind: "version", version });
  }
}

const chunkHashesOf = (hex: string): string[] => {
  const out: string[] = [];
  for (let at = 0; at < hex.length; at += 64) out.push(hex.slice(at, at + 64));
  return out;
};

// ── Digest ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const contentKey = (unit: string, noteId: string, hash: string) => (unit === "body" ? `body:${hash}` : `ink:${noteId}:${hash}`);
/** The digest columns of each version of `v`, with its positions under `positions` (a condition over `p`), in the caller's statement. */
const digestRowSql = (positions: string) => `v.note_id::text || '/' || v.unit || '/' || v.version_key AS k, v.note_id::text || '/' || v.unit AS nu,
  note_version_digest(v.note_id, v.unit, v.version_key, v.kind, v.title, v.content_hash, v.at, v.clock_wall, v.clock_counter, v.ordinal, v.author_kind, v.author_id, v.restored_from, v.source_name,
    (SELECT jsonb_agg(jsonb_build_array(p.origin, p.seq) ORDER BY p.origin COLLATE "C", p.seq) FROM note_version_positions p
      WHERE p.note_id = v.note_id AND p.unit = v.unit AND p.version_key = v.version_key AND ${positions})) AS h,
  v.unit, v.restored_from AS "restoredFrom"`;

/** The two digests (all, text only) of a set of digest rows, `leftOut` as the source counted it. */
function digestsOf(rows: readonly DigestRow[], leftOut: { all: number; body: number }): HistoryDigests {
  const of = (set: readonly DigestRow[], left: number): HistoryDigest => {
    const keys = new Set(set.map((r) => r.k));
    const dangling = set.filter((r) => r.restoredFrom !== null && !keys.has(`${r.nu}/${r.restoredFrom}`)).length;
    const contents = [...new Set(set.flatMap((r) => (r.c ? [r.c] : [])))].sort();
    const hashes = set.map((r) => r.h).sort();
    return { versions: set.length, versionsHash: sha256Hex(hashes.join(",")), contents: contents.length, contentsHash: sha256Hex(contents.join(",")), leftOut: left, dangling };
  };
  return { all: of(rows, leftOut.all), body: of(rows.filter((r) => r.unit === "body"), leftOut.body) };
}

/** What a source sends (the plan's versions), in the same read snapshot. */
export async function sentHistoryDigests(plan: HistoryPlan): Promise<HistoryDigests> {
  const rows: DigestRow[] = [];
  for (const part of chunksOf(plan.sent, 1000)) {
    const got = (await snapshotRows<Omit<DigestRow, "c">>(
      `SELECT ${digestRowSql(positionAsOf("$4", "$5::bigint"))}
         FROM unnest($1::uuid[], $2::text[], $3::text[]) AS w(note, unit, key) ${versionByKey}`,
      [part.map((v) => v.noteId), part.map((v) => v.unit), part.map((v) => v.key), plan.source, plan.cut])).rows;
    const planned = new Map<string, Planned>(part.map((v) => [`${v.noteId}/${v.unit}/${v.key}`, v]));
    for (const r of got) { const v = planned.get(r.k)!; rows.push({ ...r, c: v.contentHash ? contentKey(v.unit, v.noteId, v.contentHash) : null }); }
  }
  return digestsOf(rows, plan.leftOut);
}

/** What this node received: every version with a position that is not this node's own, with those positions, and the versions it skipped (`skipped`, kept by
 *  the import). Its own versions (written here since the notes arrived: the workspace is in use while the history part comes) are not in it. `leftOut`: what the
 *  source said it left out (a receiver cannot count it). */
export async function receivedHistoryDigests(workspaceId: string, local: string, skipped: readonly SkippedVersion[], leftOut: { all: number; body: number }): Promise<HistoryDigests> {
  const rows: DigestRow[] = [...skipped];
  for (let after: string[] | null = null; ;) {
    const params: unknown[] = [workspaceId, local];
    const cursor: string = after ? ` AND (v.note_id, v.unit COLLATE "C", v.version_key COLLATE "C") > ($${params.push(after[0])}::uuid, $${params.push(after[1])}::text, $${params.push(after[2])}::text)` : "";
    const got: (Omit<DigestRow, "c"> & { note: string; key: string; hash: string | null; held: boolean })[] = (await snapshotRows<Omit<DigestRow, "c"> & { note: string; key: string; hash: string | null; held: boolean }>(
      `SELECT ${digestRowSql("p.origin <> $2")}, v.note_id::text AS note, v.version_key AS key, v.content_hash AS hash, (v.content_hash IS NOT NULL AND ${contentHeldSql}) AS held
         FROM note_versions v
        WHERE v.workspace_id = $1 AND EXISTS (SELECT 1 FROM note_version_positions p WHERE p.note_id = v.note_id AND p.unit = v.unit AND p.version_key = v.version_key AND p.origin <> $2)${cursor}
        ORDER BY v.note_id, v.unit COLLATE "C", v.version_key COLLATE "C" LIMIT 1000`, params)).rows;
    for (const r of got) rows.push({ k: r.k, nu: r.nu, h: r.h, unit: r.unit, restoredFrom: r.restoredFrom, c: r.held ? contentKey(r.unit, r.note, r.hash!) : null });
    if (got.length < 1000) break;
    const last: { note: string; unit: string; key: string } = got[got.length - 1]!;
    after = [last.note, last.unit, last.key];
  }
  return digestsOf(rows, leftOut);
}

// ── Import ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const isObject = (o: unknown): o is Record<string, unknown> => typeof o === "object" && o !== null && !Array.isArray(o);
const isText = (v: unknown, max = 1_000_000): v is string | null => v === null || (typeof v === "string" && v.length <= max);
const isWhole = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const isLowerUuid = (v: unknown): v is string => typeof v === "string" && isUuid(v) && v === v.toLowerCase();
const onlyFields = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).every((k) => allowed.includes(k));

/** What a page of the history part may name: the origins the snapshot vouches for (its source, the source's former ids, the other origins it holds) and how far
 *  each goes (the source: its cut; a former id: what the source holds of it; another origin: the most the source holds of it under any label). */
type HistoryVouch = { source: string; cut: number; former: Record<string, number>; brought: Record<string, Record<string, number>>; local: string };

/** How far `vouch` lets an origin's versions go, or null when it does not vouch for the origin. */
function boundOf(vouch: HistoryVouch, origin: string): number | null {
  if (origin === vouch.local) return null;
  if (origin === vouch.source) return vouch.cut;
  if (Object.hasOwn(vouch.former, origin)) return vouch.former[origin]!;
  const held = Object.values(vouch.brought).flatMap((of) => (Object.hasOwn(of, origin) ? [of[origin]!] : []));
  return held.length ? Math.max(...held) : null;
}

/** Whether version `v` (already of the right form) is what its key says it is (§2.2): an `s:` key names a position the version travels from and its ordinal;
 *  a `g:` or `b:` key is worked out from what the version is, so a copy can be checked; `b:` is a baseline; `m:` comes with batch 6. */
function keyFits(v: WireVersion): boolean {
  if (v.key.startsWith("s:")) {
    const m = S_KEY.exec(v.key);
    return m !== null && v.kind !== "baseline" && Number(m[3]) === v.ordinal && v.positions.some(([o, n]) => o === m[1] && n === Number(m[2]));
  }
  if (!DIGEST_KEY.test(v.key)) return false;
  if (v.key.startsWith("b:")) return v.kind === "baseline" && v.key === baselineVersionKey(v.noteId, v.unit, v.contentHash);
  // a backup's carried baseline is stored as a baseline under the key of the save it was sent as (`created`: spine/importedHistory.ts)
  return v.key === legacyVersionKey(v.noteId, v.unit, v.kind === "baseline" ? "created" : v.kind, v.contentHash, v.title, v.at);
}

/** The form of every item of a page and what each can be checked against without the database (docs/decisions/sync-trust-line.md, the first layer): no field
 *  but the format's; a content item's text hashes to the hash it names and is not larger than a value can be; a version's fields are of their kinds, its key is
 *  the key of what it is, its positions are of origins the snapshot vouches for and no further than it holds them. Refused whole otherwise. */
export function checkHistoryItems(page: Pick<HistoryPage, "layer" | "items">, vouch: HistoryVouch): void {
  if (!Array.isArray(page.items)) throw refuse("join_history_shape", "a page's items are a list");
  let highestWall = 0;
  for (const item of page.items as unknown[]) {
    if (!isObject(item) || typeof item.kind !== "string" || !Object.hasOwn(ITEM_FIELDS, item.kind) || !onlyFields(item, ITEM_FIELDS[item.kind]!)) {
      throw refuse("join_history_shape", "an item of the history part is one of its kinds, with its fields and no other");
    }
    const content = item.kind !== "version";
    if (content !== (page.layer === "blobs")) throw refuse("join_history_shape", "an item of a kind its layer does not hold");
    if (content) {
      if (typeof item.hash !== "string" || !HASH.test(item.hash)) throw refuse("join_history_shape", "content is named by its sha256");
      if (item.kind !== "blob" && !isLowerUuid(item.noteId)) throw refuse("join_history_shape", "a drawing's content names its note");
      if (item.kind === "blob" && item.inkOnly !== undefined && item.inkOnly !== true) throw refuse("join_history_shape", "a blob says it is a drawing's only, or nothing");
      if (item.kind === "ink_manifest") {
        if (typeof item.chunks !== "string" || item.chunks.length === 0 || item.chunks.length % 64 !== 0 || !/^[0-9a-f]+$/.test(item.chunks)) throw refuse("join_history_shape", "a manifest lists chunk hashes of 32 bytes each");
        continue; // its hash is the whole value's: checked once its chunks are in (writeHistoryItems)
      }
      if (typeof item.content !== "string") throw refuse("join_history_shape", "content is a text");
      if (item.content.length > (item.kind === "ink_chunk" ? MAX_INK_CHUNK_CHARS : MAX_HISTORY_VALUE_CHARS)) throw refuse("join_history_shape", "content longer than it can be");
      if (sha256Hex(item.content) !== item.hash) throw refuse("join_history_hash", "content does not match the hash it is sent under");
      continue;
    }
    const v = item.version as Record<string, unknown>;
    if (!isObject(v) || !onlyFields(v, VERSION_FIELDS)) throw refuse("join_history_shape", "a version is an object with the fields of the format and no other");
    const fine = isLowerUuid(v.noteId) && typeof v.unit === "string" && UNITS.includes(v.unit) && typeof v.key === "string"
      && typeof v.kind === "string" && KINDS.includes(v.kind) && !(v.unit === "body" && v.kind === "removed")
      && (v.contentHash === null ? v.kind === "removed" : typeof v.contentHash === "string" && HASH.test(v.contentHash))
      && typeof v.at === "string" && isImportedAt(v.at) && (v.wall === null || isWhole(v.wall)) && (v.counter === null || isWhole(v.counter))
      && isWhole(v.ordinal) && isText(v.title) && (v.unit === "body" || v.title === null)
      && typeof v.recordedBy === "string" && v.recordedBy.length > 0 && v.recordedBy.length <= 100
      && typeof v.authorKind === "string" && AUTHOR_KINDS.includes(v.authorKind)
      && (v.authorId === null || (v.authorKind === "person" && isLowerUuid(v.authorId)))
      && (v.restoredFrom === null || (typeof v.restoredFrom === "string" && (S_KEY.test(v.restoredFrom) || DIGEST_KEY.test(v.restoredFrom)) && v.restoredFrom !== v.key))
      && isText(v.sourceName, 10_000)
      && Array.isArray(v.positions) && v.positions.length > 0 && v.positions.length <= 64
      && v.positions.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && isWhole(p[1]));
    if (!fine) throw refuse("join_history_shape", "a version that does not say what it is in the format");
    for (const [origin, seq] of v.positions as [string, number][]) {
      const bound = boundOf(vouch, origin);
      if (bound === null) throw refuse("join_history_shape", "a version that travels from an origin the snapshot does not vouch for");
      if (seq > bound) throw refuse("join_history_shape", "a version of an origin beyond what the snapshot holds of it");
    }
    if (!keyFits(v as unknown as WireVersion)) throw refuse("join_history_shape", "a version whose key is not the key of what it is");
    if (typeof v.wall === "number") highestWall = Math.max(highestWall, v.wall);
  }
  assertForeignClockWithinBound(highestWall);
}

/** The notes a page's items name (a version's, a drawing's content's). */
export const notesNamedBy = (items: readonly HistoryItem[]): string[] =>
  [...new Set(items.flatMap((i) => (i.kind === "version" ? [i.version.noteId] : i.kind === "blob" ? [] : [i.noteId])))];

/** Of the notes a page names, as the import reads them (spine/stampedImport.ts): those this database holds that have a version list (a note, a board or a
 *  tag, not a system note: note_version_in_scope), those it holds that have none, and those it deleted for good. */
type HistoryNotes = { held: ReadonlySet<string>; withoutVersions: ReadonlySet<string>; goneForGood: ReadonlySet<string> };

/** Write a checked page's items: content first (only what is not there), then the versions (only those not there; one held with another identity refuses the
 *  page) with every position they came with. In scope `body` the drawings' history is left out (their versions, chunks, manifests and the blobs only they name).
 *  A version of a note deleted for good here is not stored: it comes back in `skipped`, with what the digest needs of it. A note this node never had, or one
 *  that has no version list, refuses the page. Runs in the caller's transaction; a refusal rolls the page back whole. */
export async function writeHistoryItems(workspaceId: string, items: readonly HistoryItem[], notes: HistoryNotes, scope: HistoryScope): Promise<{ stored: number; skipped: SkippedVersion[] }> {
  for (const n of notesNamedBy(items)) {
    if (notes.withoutVersions.has(n)) throw refuse("join_history_shape", "a version of a note that has no version list (a tag or the system's own)");
    if (!notes.held.has(n) && !notes.goneForGood.has(n)) throw refuse("join_history_unknown_note", "a version or a drawing's content names a note this device never had");
  }
  const keep = (noteId: string) => notes.held.has(noteId);
  const kept = (i: HistoryItem): boolean => scope === "all" || (i.kind === "blob" ? !i.inkOnly : i.kind === "version" && i.version.unit === "body");

  const blobs = items.filter((i): i is Extract<HistoryItem, { kind: "blob" }> => i.kind === "blob" && kept(i));
  if (blobs.length) {
    await snapshotRows(`INSERT INTO blobs (hash, content, size_bytes) SELECT b.hash, b.content, octet_length(b.content) FROM jsonb_to_recordset($1::jsonb) AS b(hash text, content text) ON CONFLICT (hash) DO NOTHING`,
      [JSON.stringify(blobs.map((b) => ({ hash: b.hash, content: b.content })))]);
  }
  const chunks = items.filter((i): i is Extract<HistoryItem, { kind: "ink_chunk" }> => i.kind === "ink_chunk" && keep(i.noteId) && kept(i));
  if (chunks.length) {
    await snapshotRows(`INSERT INTO ink_chunks (workspace_id, node_id, hash, content, size_bytes) SELECT $1::uuid, c."noteId", c.hash, c.content, octet_length(c.content)
                          FROM jsonb_to_recordset($2::jsonb) AS c("noteId" uuid, hash text, content text) ON CONFLICT (node_id, hash) DO NOTHING`,
      [workspaceId, JSON.stringify(chunks.map((c) => ({ noteId: c.noteId, hash: c.hash, content: c.content })))]);
  }
  for (const m of items) {
    if (m.kind !== "ink_manifest" || !keep(m.noteId) || !kept(m)) continue;
    // the whole value its chunks make, as the source had it: sha256 of the joined chunks is the manifest's hash (§3.4). Its size is added up first, from what is
    // stored, so a manifest that lists one chunk a million times is refused before anything is joined.
    const parts = chunkHashesOf(m.chunks);
    const sizes = new Map((await snapshotRows<{ hash: string; n: number }>(`SELECT hash, char_length(content) AS n FROM ink_chunks WHERE node_id = $1::uuid AND hash = ANY($2::text[])`,
      [m.noteId, [...new Set(parts)]])).rows.map((r) => [r.hash, r.n] as const));
    if (!parts.every((p) => sizes.has(p))) throw refuse("join_history_shape", "a manifest lists a chunk that did not come before it");
    if (parts.reduce((sum, p) => sum + sizes.get(p)!, 0) > MAX_HISTORY_VALUE_CHARS) throw refuse("join_history_shape", "a manifest makes a value larger than a value can be");
    const stored = new Map((await snapshotRows<{ hash: string; content: string }>(`SELECT hash, content FROM ink_chunks WHERE node_id = $1::uuid AND hash = ANY($2::text[])`,
      [m.noteId, [...sizes.keys()]])).rows.map((r) => [r.hash, r.content] as const));
    const value = parts.map((p) => stored.get(p)!).join("");
    if (sha256Hex(value) !== m.hash) throw refuse("join_history_hash", "a drawing's chunks do not make the value its manifest names");
    await snapshotRows(`INSERT INTO ink_manifests (workspace_id, node_id, hash, chunks, size_bytes) VALUES ($1, $2, $3, decode($4, 'hex'), $5) ON CONFLICT (node_id, hash) DO NOTHING`,
      [workspaceId, m.noteId, m.hash, m.chunks, Buffer.byteLength(value, "utf8")]);
  }

  const versions = items.flatMap((i) => (i.kind === "version" && kept(i) ? [i.version] : []));
  const toStore = versions.filter((v) => keep(v.noteId));
  const skipped = await skippedDigests(versions.filter((v) => !keep(v.noteId)));
  if (toStore.length) {
    // a writer named by id is a person of this workspace, or someone this database no longer holds at all (a member removed since: their versions stay theirs);
    // an id that is another kind of actor here (a session, an agent, a person of another workspace) is not one
    const people = [...new Set(toStore.flatMap((v) => (v.authorId ? [v.authorId] : [])))];
    if (people.length) {
      const other = (await snapshotRows<{ n: number }>(`SELECT count(*)::int AS n FROM actors WHERE id = ANY($2::uuid[]) AND NOT (workspace_id = $1 AND type = 'human')`, [workspaceId, people])).rows[0]!.n;
      if (other > 0) throw refuse("join_history_shape", "a version names as its writer someone who is not a person of this workspace");
    }
    const json = JSON.stringify(toStore);
    // a text's earlier value is no longer than a note may be (§3.4)
    const long = (await snapshotRows(
      `SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS w(unit text, "contentHash" text) ${byKey("blobs", "b", 'b.hash = w."contentHash"')} WHERE w.unit = 'body' AND char_length(b.content) > $2 LIMIT 1`,
      [json, NODE_MARKDOWN_MAX])).rows.length > 0;
    if (long) throw refuse("join_history_shape", "an earlier text longer than a note may be");
    await snapshotRows(
      `INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, title, content_hash, at, clock_wall, clock_counter, ordinal, recorded_by, author_kind, author_id, restored_from, source_name)
       SELECT $1::uuid, v."noteId", v.unit, v.key, v.kind, v.title, v."contentHash", v.at, v.wall, v.counter, v.ordinal, v."recordedBy", v."authorKind", v."authorId", v."restoredFrom", v."sourceName"
         FROM jsonb_to_recordset($2::jsonb) AS v("noteId" uuid, unit text, key text, kind text, title text, "contentHash" text, at text, wall bigint, counter int, ordinal int,
                                                 "recordedBy" text, "authorKind" text, "authorId" uuid, "restoredFrom" text, "sourceName" text)
       ON CONFLICT (note_id, unit, version_key) DO NOTHING`, [workspaceId, json]);
    // a version this node already held must be the same version: one key, one identity (§2.2, history_version_clash)
    const clash = (await snapshotRows(
      `SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS w("noteId" uuid, unit text, key text, kind text, title text, "contentHash" text, at text, wall bigint, counter int, ordinal int,
                                                      "authorKind" text, "authorId" uuid, "restoredFrom" text, "sourceName" text)
         ${receivedByKey}
        WHERE (v.kind, v.title, v.content_hash, CASE WHEN v.version_key LIKE 'b:%' THEN NULL ELSE v.at END, v.clock_wall, v.clock_counter, v.ordinal, v.author_kind, v.author_id, v.restored_from, v.source_name)
              IS DISTINCT FROM (w.kind, w.title, w."contentHash", CASE WHEN w.key LIKE 'b:%' THEN NULL ELSE w.at END, w.wall, w.counter, w.ordinal, w."authorKind", w."authorId", w."restoredFrom", w."sourceName")
        LIMIT 1`, [workspaceId, json])).rows.length > 0;
    if (clash) throw refuse("join_history_clash", "a version this device holds came again with other content: one of the two devices was restored or copied", 409);
    // its content came first (the blobs layer): a version whose content is not here any more (the cleanup took it in between; the same file sent again writes
    // the content pages again and puts it back) would make the commit check of migration 220 fail the page without a code
    const early = (await snapshotRows(
      `SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS w("noteId" uuid, unit text, key text)
         ${receivedByKey}
        WHERE v.content_hash IS NOT NULL AND NOT ${contentHeldSql} LIMIT 1`, [workspaceId, json])).rows.length > 0;
    if (early) throw refuse("join_history_content_gone", "a version whose content is not on this device (any more)", 409);
    await snapshotRows(
      `INSERT INTO note_version_positions (workspace_id, note_id, unit, version_key, origin, seq)
       SELECT $1::uuid, w."noteId", w.unit, w.key, p.value->>0, (p.value->>1)::bigint
         FROM jsonb_to_recordset($2::jsonb) AS w("noteId" uuid, unit text, key text, positions jsonb) CROSS JOIN LATERAL jsonb_array_elements(w.positions) AS p
       ON CONFLICT DO NOTHING`, [workspaceId, json]);
  }
  return { stored: toStore.length, skipped };
}

/** The digest rows of versions a receiver does not store (their note is gone for good here), from the items themselves, by the same SQL function as a stored one's. */
async function skippedDigests(versions: readonly WireVersion[]): Promise<SkippedVersion[]> {
  if (versions.length === 0) return [];
  return (await snapshotRows<SkippedVersion>(
    `SELECT w."noteId"::text || '/' || w.unit || '/' || w.key AS k, w."noteId"::text || '/' || w.unit AS nu,
            note_version_digest(w."noteId", w.unit, w.key, w.kind, w.title, w."contentHash", w.at, w.wall, w.counter, w.ordinal, w."authorKind", w."authorId", w."restoredFrom", w."sourceName",
              (SELECT jsonb_agg(e ORDER BY (e->>0) COLLATE "C", (e->>1)::bigint) FROM jsonb_array_elements(w.positions) e)) AS h,
            CASE WHEN w."contentHash" IS NULL THEN NULL WHEN w.unit = 'body' THEN 'body:' || w."contentHash" ELSE 'ink:' || w."noteId" || ':' || w."contentHash" END AS c,
            w.unit, w."restoredFrom"
       FROM jsonb_to_recordset($1::jsonb) AS w("noteId" uuid, unit text, key text, kind text, title text, "contentHash" text, at text, wall bigint, counter int, ordinal int,
                                               "authorKind" text, "authorId" uuid, "restoredFrom" text, "sourceName" text, positions jsonb)`,
    [JSON.stringify(versions)])).rows;
}
