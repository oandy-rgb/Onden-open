// Which media files a publish snapshot carries, per note (table snapshot_media,
// migration 131). Written in the transaction that writes the snapshot, read by
// servedSite.servedSiteShowsMedia as an index lookup instead of a scan of the
// payload per image.

import { mediaRefs } from "@onden/markdown";
import { q } from "../db.js";

type Row = { kind: "node" | "presentation"; owner_id: string; filename: string };

/** Every media id the payload's notes and presentation name,
 *  as the rows of snapshot_media (ids lower-cased, as the check compares them). */
export function snapshotMediaRows(payload: Record<string, unknown>): Row[] {
  const rows: Row[] = [];
  const add = (kind: Row["kind"], owner: unknown, value: unknown) => {
    const owner_id = kind === "presentation" ? "" : typeof (owner as { id?: unknown })?.id === "string" ? (owner as { id: string }).id : null;
    if (owner_id === null) return;
    for (const id of mediaRefs(JSON.stringify(value ?? null))) rows.push({ kind, owner_id, filename: id.toLowerCase() });
  };
  for (const node of Array.isArray(payload.nodes) ? payload.nodes : []) add("node", node, node);
  add("presentation", null, payload.presentation);
  return rows;
}

/** Replace the snapshot's media rows with those of `payload` (a new snapshot,
 *  or one rewritten after a purge). Joins the caller's transaction. */
export async function recordSnapshotMedia(snapshotId: string, payload: Record<string, unknown>): Promise<void> {
  await q(`DELETE FROM snapshot_media WHERE snapshot_id = $1`, [snapshotId]);
  const rows = snapshotMediaRows(payload);
  if (rows.length === 0) return;
  await q(
    `INSERT INTO snapshot_media (snapshot_id, kind, owner_id, filename)
     SELECT $1, kind, owner_id, filename FROM unnest($2::text[], $3::text[], $4::text[]) AS r(kind, owner_id, filename)
     ON CONFLICT DO NOTHING`,
    [snapshotId, rows.map((r) => r.kind), rows.map((r) => r.owner_id), rows.map((r) => r.filename)],
  );
}
