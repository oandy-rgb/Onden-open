// Undoing a restore from a backup (services/backupRestore.ts): the restore is
// one BACKUP_RESTORED event and every note, tag, attribute, link and deletion
// it wrote is caused by it. History's restore with "its caused changes"
// (cascade) undoes those first, newest first, through their own inverses —
// a created note is deleted (nodeTrash), an attribute put back — and then
// this inverse records BACKUP_RESTORE_UNDONE. Undoing the event alone would
// leave every note in place, so it is refused while a note the restore
// created is still live. Tags it created stay (a tag create has no inverse).
// A leaf the restore registry (services/restoreHandlers.ts) loads.

import { sql } from "kysely";
import { q } from "../db.js";
import { db } from "../dbKysely.js";
import { log } from "../logger.js";
import type { ActorCtx } from "../types.js";
import { assertAuthority } from "../spine/authority.js";
import { eventChain } from "./eventChain.js";
import { purgeDeleted, purgePreview, trashNode } from "./nodeTrash.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { assertTagDefinitionChange, ReservedTagError } from "./reservedTags.js";
import { registerRestoreHandler, type EventRow, type RestoreContext } from "./restoreContract.js";
import { liveNodeSql, tagNodeSql } from "../spine/nodeSql.js";

export const BACKUP_RESTORED = "BACKUP_RESTORED";

/** BACKUP_RESTORED events whose batches are still being written in this
 *  process (services/backupRestore.ts applyRestore). Undoing one now would
 *  undo the batches so far and report success while the job kept adding
 *  notes, so it is refused until the restore ends. In memory, as the
 *  restore jobs are. */
const running = new Set<string>();
export function restoreStarted(eventId: string): void { running.add(eventId); }
export function restoreFinished(eventId: string): void { running.delete(eventId); }
const stillRunning = (row: EventRow) => running.has(String(row.id));
const RUNNING_CONFLICT = {
  code: "state_conflict" as const, status: 409 as const, force_available: false as const,
  detail: "the restore is still running: undo it once it has finished",
};

/** Notes the restore `row` created that are still live. */
async function liveRestoredNotes(row: EventRow): Promise<number> {
  const chain = await eventChain(row.workspace_id, row.id);
  if (!chain.length) return 0;
  const r = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM domain_events e JOIN content_nodes c ON c.id::text = e.target_id
      WHERE e.id = ANY($1::bigint[]) AND e.event_type = 'NODE_CREATED' AND ${liveNodeSql("c")}`,
    [chain.map((e) => e.id)],
  );
  return r.rows[0]?.n ?? 0;
}

registerRestoreHandler({
  eventTypes: [BACKUP_RESTORED],
  async restore(row: EventRow, context: RestoreContext) {
    // The restore was the space manager's to do; so is undoing it.
    await assertAuthority(context.actorContext, { kind: "space", spaceId: row.target_id, need: "manage" });
    if (stillRunning(row)) return RUNNING_CONFLICT;
    const live = await liveRestoredNotes(row);
    if (live > 0) {
      return { code: "state_conflict", status: 409, force_available: false,
        detail: `${live} restored notes are still here: undo the restore together with the changes it caused` };
    }
    return context.record({ eventType: "BACKUP_RESTORE_UNDONE", payload: { space_id: row.target_id }, inverseOp: "backup.restore.redo", previous: null });
  },
  async preview(row: EventRow) {
    if (stillRunning(row)) return RUNNING_CONFLICT;
    return { kind: "backup_restore", can_apply_cleanly: true, restored_notes_live: await liveRestoredNotes(row) };
  },
});

/** After a restore failed and its changes were undone (backupRestore.ts
 *  undoInSteps): remove what the undo leaves behind, so that running the
 *  restore again starts from the state before the first attempt.
 *
 *  Undoing makes each note the restore created a deleted note in History, and
 *  a tag it created has no inverse, so it stays. Left alone, the next attempt
 *  meets them: a merge would take a deleted note of the same id for one the
 *  person deleted ("in_history") and not bring it back, and a move into a new
 *  workspace would be refused because the workspace is no longer new.
 *
 *  Only what this event's chain created, and only what nobody has touched since: a note is deleted for good when
 *  everything that would go with it (the note and what is under it, deleted by the undo) was made by this restore and no
 *  event other than the restore's own, or its undo, names any of them after the restore began. A note someone edited,
 *  or that has a note written under it since (the undo put that one in History too, with its parent), stays in
 *  History for the person to decide, and the clean-up logs that it did. The check and the purge run under one event
 *  lock, so nothing can be written between them. Its tags go to the trash unless a note outside the restore carries
 *  them by now. A system tag (a reserved or a module's, like the tasks tag) is never removed.
 *  Best effort: a step that is refused leaves its row, nothing else changes. */
export async function discardAbandonedRestore(actor: ActorCtx, workspaceId: string, eventId: string): Promise<{ purged: number; kept: number }> {
  const chain = (await eventChain(workspaceId, eventId, { includeRoot: true })).map((e) => e.id);
  const made = (await sql<{ id: string; kind: "note" | "tag" }>`
    SELECT DISTINCT c.id::text AS id, CASE WHEN ${sql.raw(tagNodeSql("c"))} THEN 'tag' ELSE 'note' END AS kind
      FROM domain_events e JOIN content_nodes c ON c.id::text = e.target_id
     WHERE e.id = ANY(${chain}::bigint[]) AND e.event_type IN ('NODE_CREATED', 'TAG_CREATED') AND c.workspace_id = ${workspaceId}`.execute(db)).rows;
  const madeNotes = new Set(made.filter((m) => m.kind === "note").map((m) => m.id));
  const outcome = { purged: 0, kept: 0 };
  for (const note of madeNotes) {
    // A refusal (already gone with its parent, a note still live under it) leaves the row: History can delete it.
    try {
      const done = await withEventTransaction(workspaceId, async () => {
        const plan = await purgePreview(actor, workspaceId, note);
        if (plan.ids.some((id) => !madeNotes.has(id)) || await touchedSince(workspaceId, plan.ids, eventId, chain)) return false;
        await purgeDeleted(actor, workspaceId, note, { expected: plan.ids });
        return true;
      });
      if (done) outcome.purged++; else outcome.kept++;
    } catch (error) { log.warn("backup", "a note of a failed restore was left in History", { err: error }); outcome.kept++; }
  }
  if (outcome.kept > 0) log.warn("backup", "a failed restore left notes in History: they were edited or written under after it began", { kept: outcome.kept, purged: outcome.purged });
  for (const tag of made.filter((m) => m.kind === "tag")) {
    try { await assertTagDefinitionChange(tag.id, "delete"); }
    catch (error) { if (error instanceof ReservedTagError) continue; throw error; }
    const carried = await db.selectFrom("node_tags as nt").innerJoin("content_nodes as n", "n.id", "nt.node_id")
      .select("nt.node_id").where("nt.tag_id", "=", tag.id).where("n.deleted_at", "is", null).limit(1).executeTakeFirst();
    if (!carried) await trashNode(actor, workspaceId, tag.id, { uiContext: "backup.restore" }).catch((error) => log.warn("backup", "a tag of a failed restore was left in place", { err: error }));
  }
  return outcome;
}

/** Whether any event after the restore began names one of `ids` other than the restore's own writes (`chain`) and the
 *  undo of them (an event whose `restored_from` is one of the chain's). Any later event counts: when in doubt, keep. */
async function touchedSince(workspaceId: string, ids: readonly string[], eventId: string, chain: readonly string[]): Promise<boolean> {
  const found = await sql<{ id: string }>`
    SELECT e.id::text FROM domain_events e
     WHERE e.workspace_id = ${workspaceId} AND e.target_id = ANY(${ids}::text[]) AND e.id > ${eventId}::bigint
       AND NOT (e.id = ANY(${chain}::bigint[])) AND coalesce(e.tx_meta->>'restored_from', '') <> ALL(${chain}::text[])
     LIMIT 1`.execute(db);
  return found.rows.length > 0;
}

/** A change to a tag's colour or fields cannot be undone from History
 *  ("history_incomplete": the event does not say which fields it changed). The
 *  restore's own undo goes on past it: the tag was made by the restore, and
 *  discardAbandonedRestore removes it, or it is a system tag whose definition
 *  stays as it is now. Any other refusal still stops the undo. */
export async function tagDefinitionStays(eventId: string, code: string): Promise<boolean> {
  if (code !== "history_incomplete") return false;
  const row = await db.selectFrom("domain_events").select("target_type").where("id", "=", eventId).executeTakeFirst();
  return row?.target_type === "tag";
}
