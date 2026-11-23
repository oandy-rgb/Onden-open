// The one place quick-add turns a reading into a saved task: a line of a note.
// A task lives in a note — the note the person named with @, else (in the
// personal space) today's diary (the 日記 module on) or the 任務 note, else (in
// a shared space) that space's own 任務 note — and the server writes the line
// `- [ ] 15:00 title {task}` into it as it makes the task, in one request. A
// clock time given with the day is the time at the start of that line.

import { dayNotes, taskWriter } from "../../lib/data";

export type QuickTaskFields = {
  title: string;
  /** YYYY-MM-DD, or null. */
  when_date: string | null;
  /** HH:MM it starts, or null. */
  time: string | null;
  /** HH:MM it ends, later than `time`; absent or null: no end. */
  until?: string | null;
  evening: boolean;
  someday: boolean;
  deadline: string | null;
  /** `<n><d|w|m>` */
  recur: string | null;
  recur_mode: "fixed" | "after";
  /** An instant (ISO 8601), or null: an explicit 「提醒我」. */
  remind_at: string | null;
  /** The note to write the line into (named with @); null = today's diary. */
  note: { id: string; title: string } | null;
  /** The space the task goes to when no note is named (the sheet's 放在). Absent
   *  or the personal space: today's diary / the personal 任務 note. A shared
   *  space: that space's 任務 note (started with its first task). */
  spaceId?: string | null;
};

/** "saved" = the server accepted it; "queued" = durably stored here, sent when online. */
export type QuickTaskSaved = "saved" | "queued";

/** Where the line went: the note's title (empty for an untitled one). */
export type QuickTaskResult = { saved: QuickTaskSaved; noteTitle: string };

/** The note a task with no named note is written into (dayNotes.openTaskHome:
 *  personal space → today's diary or its 任務 note; a shared space → its 任務
 *  note). Starting it can be refused (the note writer has already said so
 *  once), and on a device that does not know the personal space yet it
 *  refuses with a plain sentence (PersonalSpaceUnknownError): the caller keeps
 *  the typed words. */
async function defaultNote(spaceId: string | null | undefined): Promise<{ id: string; title: string }> {
  const opened = await dayNotes.openTaskHome(spaceId);
  return { id: opened.node.id, title: opened.node.title };
}

// The task writer reports a refusal itself, once (a quiet writer would mark the
// failure reported and leave the person without a word), so callers that keep
// their input for a retry need only keep it.
export async function createQuickTask(fields: QuickTaskFields): Promise<QuickTaskResult> {
  const note = fields.note ?? await defaultNote(fields.spaceId);
  const result = await taskWriter.createStandaloneTask(fields.title, {
    when: fields.when_date,
    time: fields.time,
    until: fields.until,
    evening: fields.evening,
    someday: fields.someday,
    deadline: fields.deadline,
    recur: fields.recur,
    recurMode: fields.recur ? fields.recur_mode : undefined,
    remindAt: fields.remind_at,
    into: note.id,
  });
  return { saved: result.status === "synced" ? "saved" : "queued", noteTitle: note.title };
}
