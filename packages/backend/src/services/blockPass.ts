// The note walk the block-identity passes share (blockIdMigration.ts, blockLinkRewrite.ts): the live notes a pass
// looks at, in a stable order, each handled on its own so one failure leaves the rest to go on.

import { randomUUID } from "node:crypto";
import type { RawBuilder } from "kysely";
import { db } from "../dbKysely.js";

/** Which notes a pass looks at: every workspace (the system job), or one (tests, so a pass does not walk every note
 *  other test files left in the shared database). */
export type JobScope = { workspaceId?: string };

/** Every live note `which` picks, handed to `each` with the pass's batch id; a throw goes to `failed` and the walk goes on. */
export async function walkNotes(
  scope: JobScope, which: RawBuilder<boolean>,
  each: (workspaceId: string, noteId: string, batch: string) => Promise<void>,
  failed: (workspaceId: string, noteId: string, error: unknown) => void,
): Promise<void> {
  const todo = await db.selectFrom("content_nodes").select(["workspace_id", "id"])
    .where("node_type", "=", "content").where("deleted_at", "is", null).where(which)
    .$if(scope.workspaceId !== undefined, (qb) => qb.where("workspace_id", "=", scope.workspaceId!))
    .orderBy("workspace_id").orderBy("id").execute();
  const batch = randomUUID();
  for (const { workspace_id: workspaceId, id: noteId } of todo) {
    try {
      await each(workspaceId, noteId, batch);
    } catch (error) {
      failed(workspaceId, noteId, error);
    }
  }
}
