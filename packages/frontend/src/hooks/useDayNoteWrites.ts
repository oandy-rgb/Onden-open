import { useCallback } from "react";
import { dayNotes, noteWriter, propertyWriter, type taskWriter } from "../lib/data";
import { dailyNotesEnabled } from "../lib/dayNode";
import { MOOD_ATTR_KEY } from "../lib/moodStreak";

type Options = {
  addTaskRaw: typeof taskWriter.create;
  /** Opens (or creates) today's note; resolves to its id. */
  openDailyNote: () => Promise<string | null>;
};

/** Writes that land on today's day note from places with no note open. */
export function useDayNoteWrites({ addTaskRaw, openDailyNote }: Options) {
  // Daily-journal delighter: set today's mood from the home strip. Opens-or-
  // creates today's day note (same flow as the Today button) then writes the
  // `mood` attribute through the spine attribute mutation — no bespoke path.
  const setTodayMood = useCallback(async (mood: string) => {
    const id = await openDailyNote();
    if (!id) return;
    await propertyWriter.set(id, MOOD_ATTR_KEY, mood, { value_type: "text" });
  }, [openDailyNote]);

  // Agenda quick-add — the Tasks lens has no "selected note" to hang a task on,
  // so a typed-in task lands on today's day note (dayNotes.openToday: the note
  // the Today button and quick capture use, started offline too). This mints a
  // REAL task via the task writer (POST /api/nodes/:id/tasks), not inert
  // "- [ ]" markdown, giving the agenda its missing front door. A failed start
  // rejects (already reported by the note writer) and no task is sent.
  // With daily notes off (日記 not imported) there is no day note: a task
  // needs a host note (it is born as the host's hidden child), so the task
  // gets a note of its own, named after it, at the personal space's top level
  // — like a quick capture with no target.
  const createAgendaTask = useCallback(async (title: string, opts?: { when?: string | null }) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const hostId = dailyNotesEnabled()
      ? (await dayNotes.openToday())!.node.id
      : (await noteWriter.create({ title: trimmed, markdown: "" })).node.id;
    await addTaskRaw(hostId, trimmed, opts);
  }, [addTaskRaw]);

  return { setTodayMood, createAgendaTask };
}
