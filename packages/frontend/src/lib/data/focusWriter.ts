// Focus records' writes (docs/architecture/day-timeline.md, 專注紀錄): begin one,
// end it with the sentence. The record is the server's (tasks module, focus.ts);
// the client mints its id so a resend after a lost answer finds the record it
// made, and an offline begin or end waits in the write queue like any write.
//
// A time is sent only while offline: online the server stamps "now" itself, so a
// device clock a minute ahead cannot be refused as "in the future"; offline the
// queue replays much later, so the moment it happened must travel with it.

import { makeWriteLifecycle } from "./writeLifecycle";
import type { WriteResult } from "./writeQueue";
import type { DataCtx } from "./types";
import type { FocusSession } from "@onden/contract";

/** Which of the places the sentence was asked for it was written to. */
export type FocusWritten = { diary: boolean; task: boolean };

export type EndFocusInput = {
  /** The moment the person pressed 結束 (not when they finished typing). */
  endedAt: string;
  note: string;
  toDiary: boolean;
  toTask: boolean;
  /** One per attempt at ending (kept across resends of it), so a refused attempt never poisons the next. */
  attemptKey?: string;
  /** Send `endedAt` online too: for a record whose end is a past instant (where a cycle's round ran out), not "now". */
  fixedEnd?: boolean;
};

/** How long after the end a request can be sent online and still say when it ended: a later
 *  one is the person typing the sentence (or away), so the end they reached is sent, not "now". Below
 *  it the server stamps "now": a device clock a minute or two ahead is never refused. */
const END_SENT_AFTER_MS = 2 * 60_000;

export function makeFocusWriter(ctx: DataCtx) {
  const commit = makeWriteLifecycle(ctx);

  function start(input: { id: string; taskId: string | null; startedAt: string }): Promise<WriteResult<FocusSession>> {
    return commit<FocusSession>(`focus:${input.id}`, {
      method: "POST", path: "/api/tasks/focus", idemKey: input.id,
      body: JSON.stringify({
        id: input.id,
        ...(input.taskId ? { task_id: input.taskId } : {}),
        ...(ctx.online ? {} : { started_at: input.startedAt }),
      }),
    });
  }

  function end(id: string, input: EndFocusInput): Promise<WriteResult<FocusSession & { written: FocusWritten }>> {
    const note = input.note.trim();
    return commit<FocusSession & { written: FocusWritten }>(`focus:${id}`, {
      method: "POST", path: `/api/tasks/focus/${id}/end`, idemKey: input.attemptKey ?? null,
      body: JSON.stringify({
        ...(ctx.online && !input.fixedEnd && Date.now() - Date.parse(input.endedAt) <= END_SENT_AFTER_MS ? {} : { ended_at: input.endedAt }),
        ...(note ? { note, ...(input.toDiary ? { to_diary: true } : {}), ...(input.toTask ? { to_task: true } : {}) } : {}),
      }),
    });
  }

  return { start, end };
}
