// Today's note — the one way to find or start the day's note (D68).
//
// The Today button, quick capture's fallback parent, the agenda quick-add, the
// home mood picker and the "Daily note" template all mean "today's note". Each
// used to find-or-create it itself, and the template did not look at all: a
// second 2026-10-17 appeared next to the first, and findDayNode then returned
// whichever came first. They all call openToday now.
//
// One note per person and date, also across devices: the note's id is derived
// from (personal space, date) — dayNoteId — and doubles as the create's
// Idempotency-Key, so two devices that start today's note offline send the same
// create and the server keeps one (the second is answered {deduped:true}).
// The personal space comes from lib/spaces.ts, which keeps the list in the
// local copy, so an offline start knows it too. A device that has never heard
// the server (new, or its data cleared) does not: then nothing is started —
// PersonalSpaceUnknownError says, in plain words, to connect first — rather
// than a random id at the top level (2026-11-21 on a phone: a day note outside
// the chosen parent; two devices offline would each have started one).
//
// Every day note starts the same way: titled with its date and otherwise
// empty. The "Daily note" template is an explicit choice to stamp a scaffold
// onto today's note (useNodeCreation.createFromTemplate), not a second kind of
// day note.
//
// Day notes are optional (the 日記 module, lib/shellFeatures day-notes): while the
// workspace has not imported it, openToday starts nothing — it throws
// DailyNotesDisabledError (and a look-only call resolves null), so no caller
// can start a day note around the switch. Callers ask dailyNotesEnabled()
// first and take their own non-day path.
//
// Where a new day note goes: the module's one setting, the parent note
// (dayNoteParentSetting), else the personal space's top level. The setting is
// the account's, kept on the server (lib/data/dayNoteParentStore, pref key
// "dayNoteParent"), so every device names the same parent; a device offline
// uses its local copy. A device that has not heard the server's value yet
// (new device, cleared data) waits a moment for it before starting a note, as
// it does for the spaces: "not loaded yet" is never taken for "top level". The
// 任務 note (openTasksNote) goes under the same parent while the module is on —
// the personal space's only: every other space has its own 任務 note, created
// at its top level when the first task goes in.
// Dedup holds either way — the id never depends on the
// parent. It applies only when this call CREATES the note — finding one never looks at
// the parent: findDayNode matches (personal space, date) by title, and the id
// is derived from (personal space, date) alone, so a day note under any parent,
// made before the setting or after it changed, is still the one found and the
// cross-device dedup still holds. A parent that is gone, hidden or outside the
// personal space is ignored (a day note in another space would not be found).

import { TASKS_NOTE_TITLE, dayNoteDate, isCalendarDay } from "@onden/markdown";
import { ApiError, type ContentNode } from "../api";
import { dailyNotesEnabledIn, dayNoteId, findDayNode, tasksNoteId } from "../dayNode";
import { settledWithin } from "../syncedPrefStore";
import { dayNoteParentStore } from "./dayNoteParentStore";
import { personalSpaceId, refreshSpaces, spacesHeardFromServer } from "../spaces";
import { t } from "../i18n";
import { WriteActionError } from "./writeErrors";
import { randomUUID } from "../uuid";
import { domainContext } from "./domainWriters";
import { makeNoteWriter, type CreateNote } from "./noteWriter";
import type { DataCtx } from "./types";
import { todayId } from "../localDate";
import { isNote } from "@onden/markdown/contract";
import { isShownNote } from "../nodeTags";

/** What a day note that does not exist yet starts with (the template's
 *  scaffold). Applied only when this call creates the note. */
export type DayNoteSeed = Pick<CreateNote, "markdown" | "tagIds" | "attributes" | "parent_id" | "space_id">;

export type OpenToday = {
  /** Start today's note when there is none: `true` (empty), a seed, or
   *  `false` to only look. Default `true`. */
  create?: boolean | DayNoteSeed;
};

/** Today's note. `created`: this call started it — "synced" when the server
 *  accepted it, "queued" when it is durably queued (offline). */
export type OpenedDayNote = { node: ContentNode; created: false } | { node: ContentNode; created: true; status: "synced" | "queued" };

/** openDay with something that is not a calendar date (YYYY-MM-DD). */
export class InvalidDayNoteDateError extends Error {
  readonly code = "invalid_day_note_date";
  constructor(date: string) { super(`invalid_day_note_date: ${JSON.stringify(date)} is not a YYYY-MM-DD date`); }
}

/** A day note's date: exactly YYYY-MM-DD and a real day (no time, no zone). */
export function isDayNoteDate(date: unknown): date is string {
  return typeof date === "string" && isCalendarDay(date);
}

/** Starting a day note or a 任務 note on a device that does not know the
 *  person's own space (it has never heard the server: lib/spaces.ts). Nothing
 *  was written; the caller keeps what was typed. A WriteActionError, so
 *  writeErrors.report shows its sentence. */
export class PersonalSpaceUnknownError extends WriteActionError {
  readonly code = "personal_space_unknown";
  constructor(what: "day" | "tasks") {
    super(what === "day"
      ? t("Today's diary is started once this device has connected to the internet.")
      : t("Tasks without a note can be saved once this device has connected to the internet."));
  }
}

/** openToday while the daily-notes module is not imported. */
export class DailyNotesDisabledError extends Error {
  readonly code = "daily_notes_disabled";
  constructor() { super("daily_notes_disabled: the daily notes module is not imported"); }
}

/** The parent note new day notes go under, kept for the signed-in account on
 *  the server and in this device's copy (lib/data/dayNoteParentStore); null = the
 *  personal space's top level. `get` is the current value at once (the local
 *  copy draws before the server answers); `set` saves it and sends it. */
export const dayNoteParentSetting = {
  get: (): string | null => dayNoteParentStore.get().value,
  set: (id: string | null): void => dayNoteParentStore.save(id),
};

type NoteRow = Pick<ContentNode, "id" | "hidden" | "node_type" | "parent_id"> & { deleted_at?: string | null; space_id?: string | null };

/** `parentId` when a day note may be created under it: a live, visible note
 *  in the personal space. Else null (top level); null too while the personal
 *  space is not known — no day note is started then (openDay refuses), and a
 *  parent in another space would put it where findDayNode never looks. */
export function usableDayNoteParent(nodes: readonly NoteRow[], parentId: string | null, spaceId: string | null): string | null {
  if (!parentId || !spaceId) return null;
  const parent = nodes.find((n) => n.id === parentId);
  if (!parent || !isShownNote(parent) || !isNote(parent)) return null;
  if (parent.space_id && parent.space_id !== spaceId) return null;
  return parent.id;
}

/** The person's day notes — and their 任務 note — not directly under `parentId`
 *  (the setting's "move them here"): their own (personal space), never the
 *  parent itself or a note the parent sits under (that move would make a loop).
 *  Any date counts, the future too (tasks moved into notes made the days they
 *  are for). Oldest date first, 任務 last. */
export function dayNotesOutside<T extends NoteRow & { title?: string; slug?: string }>(
  nodes: readonly T[], parentId: string, spaceId: string | null,
): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const above = new Set<string>();
  for (let at = byId.get(parentId); at && !above.has(at.id); at = at.parent_id ? byId.get(at.parent_id) : undefined) above.add(at.id);
  return nodes
    .filter((n) => !n.deleted_at && isNote(n) && (dayNoteDate(n) !== null || isTasksNote(n))
      && (!spaceId || !n.space_id || n.space_id === spaceId)
      && (n.parent_id ?? null) !== parentId && !above.has(n.id))
    .sort((a, b) => (dayNoteDate(a) ?? "\uffff").localeCompare(dayNoteDate(b) ?? "\uffff"));
}

const isTasksNote = (n: { title?: string; hidden?: boolean }) => !n.hidden && n.title === TASKS_NOTE_TITLE;

export { dayNoteId };

/** How long starting a day note waits for the spaces list on a cold start. */
const SPACES_WAIT_MS = 3_000;

export function makeDayNotes(ctx: DataCtx, {
  parentSetting = dayNoteParentSetting.get,
  parentHeard = () => settledWithin(dayNoteParentStore, SPACES_WAIT_MS),
}: {
  parentSetting?: () => string | null;
  /** Resolves once the server's value of the setting has been heard (or gave up). */
  parentHeard?: () => Promise<void>;
} = {}) {
  const writer = makeNoteWriter(ctx);

  /** Whether daily notes are on in this workspace (the module is imported). */
  function enabled(): boolean {
    return dailyNotesEnabledIn(ctx.data.workspace?.modules);
  }

  /** `date`'s day note (YYYY-MM-DD), started when there is none and `create`
   *  allows it — the one way to start a day note; openToday is it for today.
   *  Resolves null only for `create: false` with no note (or the module off).
   *  Throws DailyNotesDisabledError when asked to start one with the module
   *  off, and InvalidDayNoteDateError for a `date` that is not YYYY-MM-DD (a
   *  look-only call resolves null) — nothing is looked up or created for it. A refused or failed start rejects, already reported by the note
   *  writer (callers keep their input). */
  async function openDay(date: string, options: OpenToday = {}): Promise<OpenedDayNote | null> {
    const { create = true } = options;
    if (!isDayNoteDate(date)) {
      if (create === false) return null;
      throw new InvalidDayNoteDateError(String(date));
    }
    if (!enabled()) {
      if (create === false) return null;
      throw new DailyNotesDisabledError();
    }
    const found = findDayNode(ctx.data.nodes, date);
    if (found) return { node: found, created: false };
    if (create === false) return null;
    const spaceId = await personalSpaceWhenKnown();
    if (!spaceId) throw new PersonalSpaceUnknownError("day");
    // The setting's parent, applied here only (callers never set it): a seed
    // may carry its own parent_id, which wins.
    const parent = await settingParent(spaceId);
    const seed: DayNoteSeed = { ...(parent ? { parent_id: parent } : {}), ...(create === true ? {} : create) };
    return startNote({ id: dayNoteId(spaceId, date), title: date, seed, find: () => findDayNode(ctx.data.nodes, date, spaceId) });
  }

  /** The setting's parent when a note may go under it, else null. Online, a
   *  setting the server has not been asked for yet is waited for first. */
  async function settingParent(spaceId: string): Promise<string | null> {
    if (ctx.online) await parentHeard();
    return usableDayNoteParent(ctx.data.nodes, parentSetting(), spaceId);
  }

  /** The personal space. Online, before the server has answered the spaces
   *  request on this page, wait a moment for it: its answer is newer than the
   *  copy this device kept (lib/spaces.ts restoreSpaces), which is used
   *  otherwise — offline, or a slow answer. Null only on a device that has
   *  never heard the server; callers refuse then (PersonalSpaceUnknownError). */
  async function personalSpaceWhenKnown(): Promise<string | null> {
    let spaceId = personalSpaceId();
    if (ctx.online && !spacesHeardFromServer()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([refreshSpaces(), new Promise((done) => { timer = setTimeout(done, SPACES_WAIT_MS); })]);
      clearTimeout(timer);
      spaceId = personalSpaceId();
    }
    return spaceId;
  }

  /** Create the note `id`/`title`, or open the one another device (or an
   *  earlier attempt) already made. The server already having the id means the
   *  note was started elsewhere, or since deleted or renamed: re-read and open
   *  it; when it is not live any more, start a new one under a random id. */
  async function startNote({ id, title, seed, find }: { id: string; title: string; seed: DayNoteSeed; find: () => ContentNode | undefined }): Promise<OpenedDayNote> {
    try {
      // A seed with text is the person's own scaffold: if that create is
      // refused it stays in recovery, so only an empty start is "fine".
      const result = await writer.create({ ...seed, id, title, ...(seed.markdown ? {} : { existingNoteIsFine: true as const }) });
      if (!result.deduped) return { node: result.node, created: true, status: result.status };
    } catch (error) {
      // note_exists: the id is a note already (its Idempotency-Key long gone).
      if (!(error instanceof ApiError && error.status === 409 && error.code === "note_exists")) throw error;
    }
    await ctx.refresh();
    const existing = find();
    if (existing) return { node: existing, created: false };
    const fresh = await writer.create({ ...seed, id: randomUUID(), title });
    return { node: fresh.node, created: true, status: fresh.status };
  }

  /** The note the tasks that have no day are written into — 任務, one per
   *  space (`spaceId`, default the personal space), the same note on every
   *  device (its id is derived like a day note's: tasksNoteId). Started only
   *  here, when the first task goes in: no space gets an empty one beforehand.
   *  The personal one goes under the diary parent setting while the module is
   *  on; a shared space's goes at that space's top level (the setting names a
   *  note in the personal space). Quick-add writes there for a task with no
   *  day note of its own. */
  async function openTasksNote(spaceId?: string): Promise<OpenedDayNote> {
    const personal = await personalSpaceWhenKnown();
    if (!personal) throw new PersonalSpaceUnknownError("tasks");
    const target = spaceId ?? personal;
    const isPersonal = target === personal;
    const id = tasksNoteId(target);
    // Wherever it sits: under the setting's parent it is still the one note.
    // A row without a space (an offline boot) can only be the personal one.
    const find = () => ctx.data.nodes.find((n) => isShownNote(n) && isNote(n)
      && (n.id === id || (n.title === TASKS_NOTE_TITLE && (n.space_id ? n.space_id === target : isPersonal))));
    const found = find();
    if (found) return { node: found, created: false };
    const parent = isPersonal && enabled() ? await settingParent(target) : null;
    const seed: DayNoteSeed = parent ? { parent_id: parent } : {};
    return startNote({ id, title: TASKS_NOTE_TITLE, seed: isPersonal ? seed : { ...seed, space_id: target }, find });
  }

  /** The note a task with no note of its own is written into (quick-add,
   *  capture). In the personal space (`spaceId` absent or it): today's diary
   *  while the module is on, else the personal 任務 note — diaries stay
   *  personal. Another space: its 任務 note. Refuses with
   *  PersonalSpaceUnknownError when the personal space is not known, so a
   *  task never goes to a guessed note. */
  async function openTaskHome(spaceId?: string | null): Promise<OpenedDayNote> {
    const personal = await personalSpaceWhenKnown();
    if (!personal) throw new PersonalSpaceUnknownError(enabled() ? "day" : "tasks");
    if (spaceId && spaceId !== personal) return openTasksNote(spaceId);
    return enabled() ? (await openDay(todayId()))! : openTasksNote(personal);
  }

  /** Today's note (in the workspace's zone), started when there is none and
   *  `create` allows it. Example:
   *    if (dailyNotesEnabled()) {
   *      const { node } = await dayNotes.openToday();  // open or start it
   *    }
   *    const today = await dayNotes.openToday({ create: false });  // look only */
  function openToday(options: OpenToday = {}): Promise<OpenedDayNote | null> {
    return openDay(todayId(), options);
  }

  return { openToday, openDay, openTasksNote, openTaskHome, enabled };
}

/** Today's note over the live store — the instance every surface uses. */
export const dayNotes = makeDayNotes(domainContext);
