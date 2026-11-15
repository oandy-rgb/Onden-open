// Day-node detection — the SAME convention the Today button uses to open-or-
// start today's note (lib/data/dayNotes.ts openToday matches a non-hidden node
// whose title or slug IS the ISO date). Generalized here to ANY date so an old
// day note also gets its day's lens. Pure, so it's unit-testable.

import { DAY_NOTE_NAMESPACE, TASKS_NOTE_TITLE, dayNoteDate, dayNoteIdName } from "@onden/markdown";
import { nameBasedUUID } from "./uuid";
import { personalSpaceId } from "./spaces";
import { getAppState } from "./appStore";
import { todayId } from "./localDate";
import { isShownNote } from "./nodeTags";
import { shellFeatureOnIn } from "./shellFeatures";
import { isTag } from "@onden/markdown/contract";

/** Whether daily notes (日記, modules/daily) are on for a workspace's stored
 *  module list. Day notes are optional: while the workspace has not imported
 *  the module, nothing starts a day note (lib/data/dayNotes.ts openToday
 *  refuses) and its entry points are hidden. Existing day notes stay ordinary
 *  notes. */
export function dailyNotesEnabledIn(modules: readonly string[] | null | undefined): boolean {
  return shellFeatureOnIn(modules, "day-notes");
}

/** Whether daily notes are on in the live workspace. The one check for code
 *  outside React; components use hooks/useModuleFilter useDailyNotesEnabled. */
export function dailyNotesEnabled(): boolean {
  return dailyNotesEnabledIn(getAppState().data.workspace?.modules);
}

/** The day note for `date` (today by default): a non-hidden node whose title
 *  or slug is that date. The one lookup behind dayNotes.openToday (the Today
 *  button, quick capture, the agenda quick-add, the daily template). */
export function findDayNode<T extends { title?: string; slug?: string; hidden?: boolean; space_id?: string | null }>(
  nodes: readonly T[],
  date: string = todayId(),
  ownSpaceId: string | null = personalSpaceId(),
): T | undefined {
  // A daily note is someone's own: (owner, date), found in their personal
  // space — a same-dated note someone shared elsewhere is not "today" for you.
  // Before the spaces load, any day note matches (one person's workspace).
  return nodes.find((n) => dayNoteDate(n) === date
    && (!ownSpaceId || !n.space_id || n.space_id === ownSpaceId));
}

/** Whether the workspace holds anything the user made beyond day notes (which
 *  open automatically). The first-run welcome is for an empty workspace; its
 *  "dismissed" flag lives in localStorage, which a new browser, device or URL
 *  starts without, so the workspace itself must also be able to say "not new". */
export function hasOwnNotes(
  nodes: readonly { node_type?: string; title?: string; slug?: string; hidden?: boolean; deleted_at?: string | null }[],
): boolean {
  return nodes.some((n) => isShownNote(n) && !isTag(n) && dayNoteDate(n) === null);
}

/** The id of `date`'s day note in a personal space — the same on every device. */
export function dayNoteId(spaceId: string, date: string): string {
  return nameBasedUUID(DAY_NOTE_NAMESPACE, dayNoteIdName(spaceId, date));
}

/** The id of a space's 任務 note (the home of that space's tasks with no day;
 *  every space has its own, the same id migration 147 derives). The one rule
 *  for "is this that note": the sidebar (lib/sidebarTidy) and
 *  dayNotes.openTasksNote both go through it. */
export function tasksNoteId(spaceId: string): string {
  return dayNoteId(spaceId, TASKS_NOTE_TITLE);
}
