import { sha256Hex } from "../utils.js";
import { queryOnSeparateConnection } from "../db.js";

// The content store for the events -> hash -> blobs history model. Content-address
// a markdown body into the `blobs` store (dedup via the PK) and return its SHA-256
// hex hash. Hashing is sha256 hex of the UTF-8 bytes + octet_length size, so
// identical bodies (across nodes, edits, restores) collapse onto one blob row.
//
// Body-changing events (NODE_CREATED / NODE_UPDATED) carry the returned hash in
// payload.body_hash: the event log references content by hash instead of
// embedding the full body, and version-history / restore / blob-GC all derive
// from (events JOIN blobs). The old CoW content_node_versions table + trigger
// were retired once this became the single history mechanism (migration 053).
//
// putBlob runs before the event that references the hash commits (often
// outside its transaction), so the orphan GC must not take a blob that a write
// is about to reference. blobs.created_at doubles as "last put": putting an
// existing blob again refreshes it (at most hourly, to keep hot hashes like the
// empty body from churning), and the GC only takes orphans older than
// BLOB_GC_GRACE (maintenance/prune.ts). A write that commits within the grace
// window always finds its blob.
//
// The write runs on its own autocommit connection (queryOnSeparateConnection, not the
// caller's transaction): the upsert locks an existing row, and holding that
// lock until a long import commits would block every other write of the same
// content, or deadlock two transactions putting the same blobs in opposite
// order. A blob committed for a write that later rolls back is just an orphan
// the GC takes after the grace window.
export async function putBlob(markdown: string): Promise<string> {
  const hash = sha256Hex(markdown);
  await queryOnSeparateConnection(
    `INSERT INTO blobs (hash, content, size_bytes) VALUES ($1, $2, $3)
     ON CONFLICT (hash) DO UPDATE SET created_at = now()
       WHERE blobs.created_at < now() - interval '1 hour'`,
    [hash, markdown, Buffer.byteLength(markdown, "utf8")],
  );
  return hash;
}

/** How long an unreferenced blob is kept after its last put. */
export const BLOB_GC_GRACE = "1 day";
