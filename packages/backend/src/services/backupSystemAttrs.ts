// Which system attributes (`_` keys) a restore writes back, and how.
//
// A restore used to drop every `_` key. They are not alike:
//
//   belongs to the note   `_import_*` (where an Obsidian import found it: without
//                         it a second import adds the note again), `_pinned`,
//                         `_color`, `_captured`, `_tpl_origin`, and an article's
//                         own `_rss_guid` / `_rss_url` / `_rss_published_at`.
//                         Every restore writes them back.
//   published             `_published`. 「不發布」 ('false') is what keeps a note off the
//                         site in a space that publishes, so it always comes back, or the
//                         note would go public with the next publish. A 'true' comes back
//                         only for a note that returns as itself and is not in the trash
//                         (the note's own 「發布」, which also brings a blank note on; the site serves it only while its
//                         space's publish switch is on and the note is publicly readable,
//                         publishedSet.ts). A 「備份」 copy is never put on the site by the
//                         restore: it is written 'false' whatever the original had, since
//                         it lands in a space that may publish and nobody asked for it to
//                         go public. The write is the note menu's own (setNodeAttribute).
//   belongs to the person `_review_state` (spaced-repetition progress),
//                         `_rss_source` / `_rss_kind` (which of the person's
//                         subscriptions a note came from). Only a workspace
//                         move (backupWorkspaceMove.ts) brings them: they name
//                         the person's own progress and subscriptions, which
//                         travel with it.
//   a task's fields       `_task_*`: see restoredTaskField.
//   a board's sections    `_canvas_sections`: user-drawn frames, not derived. They are
//                         not written as an attribute; backupRestore writes them back
//                         through applyBoardChanges with the board's cards.
//   never                 every other `_` key (block markers, …): derived or owned
//                         by a module that writes them again.

import { isCalendarDay, isClockTime, isSystemAttr, parseRecur, TASK_STATUSES } from "@onden/markdown";
import { db } from "../dbKysely.js";
import type { ActorCtx } from "../types.js";
import { recordAttributeChange } from "./attributeChange.js";
import { PUBLISHED_KEY, isKeptOffSite, keptOffFromSource, isValidSystemAttributeValue, isWritableAttributeKey } from "./systemAttributes.js";
import { setNodeAttribute } from "./attributeWrites.js";

const NOTE_OWN_KEYS = new Set(["_pinned", "_color", "_captured", "_tpl_origin", "_rss_guid", "_rss_url", "_rss_published_at"]);
const PERSON_KEYS = new Set(["_review_state", "_rss_source", "_rss_kind"]);

export type SystemAttrClass = "note" | "published" | "person" | "task" | "never";

export function classifySystemAttr(key: string): SystemAttrClass {
  if (!isSystemAttr(key)) return "never";
  if (key.startsWith("_task_")) return "task";
  if (key === PUBLISHED_KEY) return "published";
  if (key.startsWith("_import_") || NOTE_OWN_KEYS.has(key)) return "note";
  if (PERSON_KEYS.has(key)) return "person";
  return "never";
}

const isInstant = (value: string) => Number.isFinite(Date.parse(value));
const isWallClock = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value) && isCalendarDay(value.split("T")[0]!);

/** The `_task_*` fields a task keeps, each with the values Tasks writes. A
 *  crafted backup cannot plant another `_task_` key or a value Tasks would refuse. */
const TASK_FIELD_RULES: Record<string, (value: string) => boolean> = {
  _task_status: (value) => (TASK_STATUSES as readonly string[]).includes(value),
  _task_when: isCalendarDay,
  _task_deadline: isCalendarDay,
  _task_evening: (value) => value === "true",
  _task_someday: (value) => value === "true",
  _task_recur: (value) => parseRecur(value) !== null,
  _task_recur_mode: (value) => value === "after",
  _task_remind_at: (value) => isInstant(value) || isWallClock(value),
  _task_time: isClockTime,
  _task_until: isClockTime,
  _task_done_at: isInstant,
};

export function restoredTaskField(key: string, value: string): boolean {
  return TASK_FIELD_RULES[key]?.(value) ?? false;
}

/** Make task `taskId` hold the `_task_*` fields the backup has: a field it
 *  lacks or holds differently is written, one the backup does not have is
 *  removed. Each change is an attribute event, as a hand edit in Tasks is.
 *  Returns how many writes were refused (the caller counts them). */
export async function reconcileTaskFields(
  actor: ActorCtx, workspaceId: string, taskId: string, backed: ReadonlyArray<{ key: string; value: string }>,
  write: (change: () => Promise<unknown>) => Promise<boolean>,
): Promise<number> {
  const want = new Map(backed.filter((a) => restoredTaskField(a.key, a.value)).map((a) => [a.key, a.value]));
  const have = new Map((await db.selectFrom("node_attributes").select(["key", "value"]).where("node_id", "=", taskId).where("key", "like", "\\_task\\_%").execute())
    .map((r) => [r.key, r.value]));
  let refused = 0;
  for (const key of new Set([...want.keys(), ...have.keys()])) {
    const next = want.get(key) ?? null;
    if ((have.get(key) ?? null) === next) continue;
    const ok = await write(() => recordAttributeChange({
      workspaceId, nodeId: taskId, key, actor, next: next === null ? null : { value: next }, rule: "always",
      authority: { kind: "node", nodeId: taskId, op: next === null ? "delete_attribute" : "set_attribute" }, uiContext: "backup.restore",
    }));
    if (!ok) refused++;
  }
  return refused;
}

/** How a restore treats `_published`: `as_backed` writes the backup's value ('true' or 'false'), `off_only` writes
 *  only a 'false' (a note in the trash), `always_off` writes 'false' whatever the backup had (a 「備份」 copy). */
export type PublishRestore = "as_backed" | "off_only" | "always_off";

/** The `_published` value a restore writes for a note whose backup holds `backed` (null: it holds none), or null for none. */
export function restoredPublishedValue(how: PublishRestore, backed: string | null): "true" | "false" | null {
  if (how === "always_off" || keptOffFromSource(backed === null ? [] : [{ key: PUBLISHED_KEY, value: backed }])) return "false";
  return backed === "true" && how === "as_backed" ? "true" : null;
}

/** Write the system attributes of one restored note that every restore brings
 *  (class "note"), plus "person" ones when `withPerson`, plus `_published` as `published` says. Returns how many writes were refused. */
export async function restoreSystemAttrs(
  actor: ActorCtx, workspaceId: string, nodeId: string, attributes: ReadonlyArray<{ key: string; value: string }>,
  opts: { withPerson: boolean; published: PublishRestore },
  write: (change: () => Promise<unknown>) => Promise<boolean>,
): Promise<number> {
  let refused = 0;
  const published = restoredPublishedValue(opts.published, attributes.find((a) => a.key === PUBLISHED_KEY)?.value ?? null);
  const rows = published === null ? attributes.filter((a) => a.key !== PUBLISHED_KEY) : [...attributes.filter((a) => a.key !== PUBLISHED_KEY), { key: PUBLISHED_KEY, value: published }];
  for (const a of rows) {
    const kind = classifySystemAttr(a.key);
    const wanted = kind === "note" || (kind === "person" && opts.withPerson) || kind === "published";
    if (!wanted || a.value === "" || !isValidSystemAttributeValue(a.key, a.value)) continue;
    // The keys the note's own menu writes go the menu's way (its value rules, the space's publish switch);
    // the provenance stamps are module-owned, written as an attribute change.
    // 「不發布」 is never skipped quietly: a copy without it would be public at the next publish, so a refused write
    // there fails the restore (the caller's transaction rolls back) instead of being counted.
    const writeIt = isKeptOffSite(a) ? async (change: () => Promise<unknown>) => { await change(); return true; } : write;
    const ok = await writeIt(() => isWritableAttributeKey(a.key)
      ? setNodeAttribute({ workspaceId, actor, nodeId, attribute: { key: a.key, value: a.value, value_type: "text", is_inheritable: false }, existingKey: true })
      : recordAttributeChange({
        workspaceId, nodeId, key: a.key, actor, next: { value: a.value }, rule: "always",
        authority: { kind: "node", nodeId, op: "set_attribute" }, uiContext: "backup.restore",
      }));
    if (!ok) refused++;
  }
  return refused;
}
