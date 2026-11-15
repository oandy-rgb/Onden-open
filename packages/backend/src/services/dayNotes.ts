// Writing a line into a person's day note from the server (the focus record's
// 「寫進日記」). The app starts day notes itself (frontend lib/data/dayNotes.ts);
// the server only appends to the one that is there — or, while the 日記 module
// is on, starts it with the id the app would derive for (personal space, day)
// (@onden/markdown DAY_NOTE_NAMESPACE), so a device that opens the day later
// finds this note instead of making a second.

import { DAY_NOTE_NAMESPACE, appendedBody, dayNoteIdName } from "@onden/markdown";
import { q, withSavepoint } from "../db.js";
import { uuidV5 } from "../utils.js";
import type { ActorCtx } from "../types.js";
import { createNote, isNoteIdTaken } from "./noteCreate.js";
import { readPref } from "./actorPrefs.js";
import { AuthorityError } from "../spine/authorityError.js";
import { ScopeError } from "../spine/toolScope.js";
import { canPlaceUnder } from "./nodePlacement.js";
import { updateNode } from "./nodeUpdate.js";
import { workspaceHasModule } from "./workspaceModules.js";
import { liveNodeSql } from "../spine/nodeSql.js";

/** The note a day note this actor starts goes under: their 日記 setting
 *  (actor_prefs `dayNoteParent`, the same choice the app follows), when it is a
 *  live, visible content note of `spaceId` they may place a note under; else
 *  null (the space's top level). The same rule as the frontend's
 *  usableDayNoteParent — a parent in another space would put the day note where
 *  the app never looks for it. Every day note the server starts asks this. */
export async function newDayNoteParent(actor: ActorCtx, workspaceId: string, spaceId: string): Promise<string | null> {
  const parentId = await readPref(actor, "dayNoteParent");
  if (typeof parentId !== "string" || !parentId) return null;
  const usable = (await q(
    `SELECT 1 FROM content_nodes WHERE id::text = $1 AND workspace_id = $2 AND space_id = $3
        AND node_type = 'content' AND ${liveNodeSql()} AND NOT hidden`, [parentId, workspaceId, spaceId])).rowCount;
  if (!usable) return null;
  try {
    return (await canPlaceUnder(actor, workspaceId, parentId)) ? parentId : null;
  } catch (error) {
    // Readable but not writable for this actor: the day note goes to the top level, not a refusal.
    if (error instanceof AuthorityError || error instanceof ScopeError) return null;
    throw error;
  }
}

/** Add `text` (one block) to the end of `date`'s note in the actor's personal
 *  space. Returns false when there is nowhere to write it: no personal space
 *  (an agent token), no day note and the 日記 module is off. Joins the caller's
 *  transaction; a refused write (the note became unwritable) throws as
 *  updateNode does. */
export async function appendToDayNote(actor: ActorCtx, workspaceId: string, date: string, text: string): Promise<boolean> {
  const space = (await q<{ id: string }>(
    `SELECT id::text FROM spaces WHERE workspace_id = $1 AND owner_actor_id = $2 AND kind = 'personal' AND deleted_at IS NULL`,
    [workspaceId, actor.id])).rows[0]?.id;
  if (!space) return false;
  // The same lookup as the app's findDayNode: a visible note whose title or slug is the date.
  const found = (await q<{ id: string; markdown: string }>(
    `SELECT id::text, markdown FROM content_nodes
      WHERE workspace_id = $1 AND space_id = $2 AND ${liveNodeSql()} AND node_type = 'content' AND NOT hidden
        AND (title = $3 OR slug = $3)
      ORDER BY created_at, id LIMIT 1 FOR UPDATE`, [workspaceId, space, date])).rows[0];
  if (found) {
    await updateNode(workspaceId, found.id, { markdown: appendedBody(found.markdown, text) }, {
      actor, baseMarkdown: found.markdown,
      event: { uiContext: "focus.diary", cascadeLabel: "focus.diary.cascade", backupPrefix: "FOCUS_DIARY" },
    });
    return true;
  }
  if (!(await workspaceHasModule(workspaceId, "daily"))) return false;
  const id = uuidV5(DAY_NOTE_NAMESPACE, dayNoteIdName(space, date));
  const parentId = await newDayNoteParent(actor, workspaceId, space);
  try {
    await withSavepoint(() => createNote({ actor, workspaceId, id, title: date, markdown: `${text}\n`, spaceId: space, parentId, event: { uiContext: "focus.diary" } }));
  } catch (error) {
    // That id is a note already (trashed, renamed): start this day's note under a new one.
    if (!isNoteIdTaken(error)) throw error;
    await createNote({ actor, workspaceId, title: date, markdown: `${text}\n`, spaceId: space, parentId, event: { uiContext: "focus.diary" } });
  }
  return true;
}
