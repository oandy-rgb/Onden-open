import { sql } from "kysely";
import { db } from "../../dbKysely.js";
import type { ActorCtx } from "../../types.js";
import { readableAmong } from "../readPolicy.js";

/** A live note the caller may read, found by id or slug: the one lookup getNode and the slides tools share.
 *  Not found, deleted and unreadable look the same (null): a tool that takes an id or slug must not say which
 *  notes exist in spaces the caller cannot see. */
export type ReadableNote = {
  id: string; slug: string; title: string; markdown: string; node_type: string;
  created_at: string; updated_at: string;
};

export async function readableNote(
  actor: ActorCtx, workspaceId: string, by: { id?: string; slug?: string },
): Promise<ReadableNote | null> {
  if (by.id === undefined && by.slug === undefined) return null;
  // A slug is unique per space, so several rows can match (at most one per space): read access decides among them
  // before one is picked, so another space's note never hides the caller's own. An id match wins over a slug match.
  const rows = await db.selectFrom("content_nodes")
    .select(["id", "slug", "title", "markdown", "node_type", "created_at", "updated_at"])
    .where("workspace_id", "=", workspaceId).where("deleted_at", "is", null)
    .where((eb) => eb.or([
      ...(by.id !== undefined ? [eb("id", "=", by.id)] : []),
      ...(by.slug !== undefined ? [eb("slug", "=", by.slug)] : []),
    ]))
    .orderBy(sql`(id::text = ${by.id ?? null}) desc`).orderBy("created_at").orderBy("id").execute();
  if (rows.length === 0) return null;
  const readable = await readableAmong(actor, workspaceId, rows.map((r) => r.id));
  const row = rows.find((r) => readable.has(r.id));
  return row ? {
    id: row.id, slug: row.slug, title: row.title, markdown: row.markdown ?? "", node_type: row.node_type,
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  } : null;
}
