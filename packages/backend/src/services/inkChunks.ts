// A big drawing value stored as chunks (migration 203; docs/agents/decisions-canvas.md, 手寫存檔量).
//
// A drawing is saved again for every stroke, and each save keeps the value it left (history, undo, "restore this version"
// read those). Kept whole, a PDF with a few hundred strokes costs several MB per save for good. Over INK_CHUNK_THRESHOLD a
// value is cut into chunks at object boundaries chosen from the text itself (content-defined), so a stroke added at the
// end of a page changes the chunks around it and no others: the chunks the save did not touch already exist and are not
// written again. What a save adds is the changed chunks plus the manifest (the ordered list of chunk digests, 32 bytes
// each). Chunks belong to one note (no sharing between notes), which keeps purge and cleanup note-local.
//
// The value keeps its own hash (sha256 of the whole text): events still say `value_ref: <that hash>`, and the same hash
// names it whether it was stored whole (`blobs`, every value before migration 203 and every small one) or as chunks.
// readInkValues reads both. Writes run on the caller's transaction (db is Kysely over q()), so a rolled-back save leaves no chunks behind.

import { sql } from "kysely";
import { db } from "../dbKysely.js";
import { sha256Hex } from "../utils.js";
import { chunkInk } from "./inkChunker.js";

/** Values shorter than this (UTF-16 units) stay one `blobs` row: a handwriting page is small and splitting it saves nothing. */
export const INK_CHUNK_THRESHOLD = 192 * 1024;
/** Chunk rows written per statement (five parameters each). */
const INSERT_BATCH = 500;

const digests = (hashes: readonly string[]): Buffer => Buffer.concat(hashes.map((hash) => Buffer.from(hash, "hex")));
/** The chunk hashes a manifest lists, in order. */
export const hashesOf = (chunks: Uint8Array): string[] => {
  const bytes = Buffer.from(chunks);
  const out: string[] = [];
  for (let at = 0; at < bytes.length; at += 32) out.push(bytes.subarray(at, at + 32).toString("hex"));
  return out;
};

/** Store `value` for note `nodeId` as chunks and return its hash (sha256 of the whole text, what an event names).
 *  The chunks the note already holds are not written again. Call in the write transaction. */
export async function putInkChunks(workspaceId: string, nodeId: string, value: string): Promise<string> {
  const hash = sha256Hex(value);
  const known = await db.selectFrom("ink_manifests").select("hash").where("node_id", "=", nodeId).where("hash", "=", hash).executeTakeFirst();
  if (known) return hash;
  const parts = chunkInk(value);
  const partHashes = parts.map((part) => sha256Hex(part));
  const have = new Set((await sql<{ hash: string }>`SELECT hash FROM ink_chunks WHERE node_id = ${nodeId} AND hash = ANY(${partHashes}::text[])`.execute(db)).rows.map((r) => r.hash));
  const fresh = new Map<string, string>();
  parts.forEach((part, i) => { if (!have.has(partHashes[i]!) && !fresh.has(partHashes[i]!)) fresh.set(partHashes[i]!, part); });
  const rows = [...fresh].map(([chunkHash, content]) => ({ workspace_id: workspaceId, node_id: nodeId, hash: chunkHash, content, size_bytes: Buffer.byteLength(content, "utf8") }));
  for (let at = 0; at < rows.length; at += INSERT_BATCH) {
    await db.insertInto("ink_chunks").values(rows.slice(at, at + INSERT_BATCH)).onConflict((c) => c.columns(["node_id", "hash"]).doNothing()).execute();
  }
  await db.insertInto("ink_manifests")
    .values({ workspace_id: workspaceId, node_id: nodeId, hash, chunks: digests(partHashes), size_bytes: String(Buffer.byteLength(value, "utf8")) })
    .onConflict((c) => c.columns(["node_id", "hash"]).doNothing()).execute();
  return hash;
}

/** The values of `hashes` that note `nodeId` holds as chunks (a hash it stores whole is not here: see readInkValues). */
export async function readChunkedValues(workspaceId: string, nodeId: string, hashes: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (hashes.length === 0) return out;
  const manifests = await db.selectFrom("ink_manifests").select(["hash", "chunks"])
    .where("workspace_id", "=", workspaceId).where("node_id", "=", nodeId).where("hash", "in", [...new Set(hashes)]).execute();
  const lists = manifests.map((row) => ({ hash: row.hash, parts: hashesOf(row.chunks) }));
  const needed = [...new Set(lists.flatMap((l) => l.parts))];
  if (needed.length === 0) return out;
  const stored = new Map((await sql<{ hash: string; content: string }>`
    SELECT hash, content FROM ink_chunks WHERE workspace_id = ${workspaceId} AND node_id = ${nodeId} AND hash = ANY(${needed}::text[])`.execute(db))
    .rows.map((r) => [r.hash, r.content]));
  for (const { hash, parts } of lists) {
    const pieces = parts.map((part) => stored.get(part));
    if (pieces.every((piece): piece is string => piece !== undefined)) out.set(hash, pieces.join(""));
  }
  return out;
}

/** The value of each hash in `hashes` as note `nodeId` kept it: a `blobs` row (stored whole) or its chunks. A hash whose
 *  text is no longer stored is missing from the map. */
export async function readInkValues(workspaceId: string, nodeId: string, hashes: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(hashes)];
  if (wanted.length === 0) return new Map();
  const out = new Map<string, string>();
  const whole = await db.selectFrom("blobs").select(["hash", "content"]).where("hash", "in", wanted).execute();
  for (const row of whole) out.set(row.hash, row.content);
  for (const [hash, text] of await readChunkedValues(workspaceId, nodeId, wanted.filter((hash) => !out.has(hash)))) out.set(hash, text);
  return out;
}

/** One value (see readInkValues): null when it is no longer stored. */
export async function readInkValue(workspaceId: string, nodeId: string, hash: string): Promise<string | null> {
  const whole = await db.selectFrom("blobs").select("content").where("hash", "=", hash).executeTakeFirst();
  if (whole) return whole.content;
  return (await readChunkedValues(workspaceId, nodeId, [hash])).get(hash) ?? null;
}
