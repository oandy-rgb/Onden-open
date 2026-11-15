// A day's focus records as the 日子 page's timeline items: a block from when it
// began to when it ended; the one still running reaches 「現在」 and is marked
// live. The sentence written at the end is its second line.

import type { DayItem } from "@onden/markdown";
import { dateIdAt } from "../localDate";
import type { FocusSession } from "@onden/contract";

export function focusDayItems(
  date: string,
  sessions: readonly FocusSession[],
  running: FocusSession | null,
  taskTitle: (taskId: string) => string | undefined,
  nowMs: number,
): DayItem[] {
  // The running record is listed with the day it began on, once.
  const all = running && !sessions.some((s) => s.id === running.id) && dateIdAt(new Date(running.started_at)) === date
    ? [...sessions, running] : sessions;
  return all.map((session) => {
    const live = session.ended_at === null;
    const title = (session.task_id && taskTitle(session.task_id)) || "";
    return {
      at: session.started_at,
      until: live ? new Date(Math.max(nowMs, Date.parse(session.started_at))).toISOString() : session.ended_at!,
      kind: "focus" as const,
      title,
      ...(session.note ? { detail: session.note } : {}),
      ref: session.task_id ? { type: "task" as const, id: session.task_id } : null,
      past: !live,
      ...(live ? { live: true } : {}),
    };
  });
}
