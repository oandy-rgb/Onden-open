// Editing a canvas node (PATCH /api/canvases/:id, depth audit D2): its title,
// or just its updated_at so the canvas list re-sorts. Moved verbatim from
// routes/canvases.ts; the route checks the canvas exists first.

import { q } from "../db.js";
import { db } from "../dbKysely.js";
import { putBlob } from "./blobs.js";
import { recordVersion } from "../spine/noteVersions.js";
import { mutate } from "../spine/mutate.js";
import { relinkTarget } from "./wikilinkEdges.js";
import type { ActorCtx } from "../types.js";

/** Rename (when `title` is given) or touch canvas `id`. `fields` is what the
 *  request carried, recorded on CANVAS_UPDATED. */
export async function updateCanvas(
  actor: ActorCtx, workspaceId: string, id: string, { title, fields }: { title?: string; fields: string[] },
): Promise<{ id: string; title: string; updated_at: string }> {
  return mutate<{ id: string; title: string; updated_at: string }>({
    actor,
    workspaceId,
    // A canvas is a node (mig 057): editing it (title / layout / sections) is a
    // write on the canvas NODE, gated by its tag policy + bearer-token tag
    // scope — not a global editor-role check.
    authority: { kind: "node", nodeId: id, op: "write_node" },
    event: { type: "CANVAS_UPDATED", targetType: "canvas", targetId: id, payload: { fields } },
    apply: async () => {
      if (title !== undefined) {
        const before = await db.selectFrom("content_nodes").select(["title", "markdown"]).where("id", "=", id).where("workspace_id", "=", workspaceId).executeTakeFirst();
        await q(
          `UPDATE content_nodes SET title = $3, updated_at = now()
            WHERE id = $1 AND workspace_id = $2`,
          [id, workspaceId, title],
        );
        // A rename is a version of the board (spine/noteVersions.ts), with the text the board has: read here, under the event lock, so a body
        // saved meanwhile is the one named.
        if (before && before.title !== title) {
          await recordVersion({ workspaceId, noteId: id, unit: "body", contentHash: await putBlob(before.markdown), kind: "updated", title });
        }
        // Notes that [[name]] the canvas by its old or new title.
        await relinkTarget(workspaceId, [id]);
      } else {
        await q(
          `UPDATE content_nodes SET updated_at = now() WHERE id = $1 AND workspace_id = $2`,
          [id, workspaceId],
        );
      }
      const result = await q<{ id: string; title: string; updated_at: string }>(
        `SELECT id, title, updated_at FROM content_nodes WHERE id = $1 AND workspace_id = $2`,
        [id, workspaceId],
      );
      return result.rows[0];
    },
  });
}
