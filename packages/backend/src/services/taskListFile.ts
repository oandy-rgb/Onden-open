// The Markdown file a workspace's standalone tasks (no host note) are exported
// as, and read back from (D-T7). No database here: services/exportZip.ts
// writes what `renderTaskList` returns, modules/importers/obsidian/import.ts reads a
// file with `parseTaskList`; both agree on this one grammar.
//
//   ---
//   onden_export: tasks
//   exported_at: 2026-10-24T08:00:00.000Z
//   ---
//
//   > 這份清單由 Onden 匯出…
//
//   ## 今天
//   - [ ] 買牛奶 [[任務/買牛奶]] 🔁 every week ⏳ 2026-10-24 📅 2026-10-30 ^t-0f3a9c2b1d44
//   ## 已完成
//   - [x] 寄信 ✅ 2026-10-20 ^t-7be20c11aa90
//
// Dates and repeats use the Obsidian Tasks plugin's symbols, so the file works
// in a vault with that plugin: ⏳ scheduled = Onden's "何時做" (`_task_when`,
// older `_task_due`), 📅 due = Onden's "截止" (`_task_deadline`), 🔁 recurrence
// (`_task_recur`, "2w" ⇄ "every 2 weeks"), ✅ done date, `[ ]` `[x]` `[-]`
// `[/]` for todo / done / cancelled / doing. Fields Obsidian Tasks has no
// symbol for travel as Dataview inline fields, `[evening:: true]`
// (`_task_evening`, `_task_someday`, `_task_remind_at`, `_task_recur_mode`,
// and any other `_task_*` key by its name without the prefix), so nothing a
// task holds is left out. A task with body text has its own note file, linked
// right after the title; the trailing `^t-…` is the task's stable reference.
//
// The section headings are for reading only: the importer ignores them, so a
// line moved between sections keeps meaning what its fields say.

import { BLOCK_ID_CHARS, fenceScanner, TASK_ATTR, entryFor, entryValue, isParsableRecur, parseRecur, readFrontmatter, taskHome, writeFrontmatter, scanWikilinks, splitWikilink } from "@onden/markdown";

export type TaskListLang = "zh-TW" | "en";

/** A task as the file holds it. `fields` are its `_task_*` attributes by full
 *  key; the status is `fields._task_status` (absent = "todo"). */
export type TaskListItem = {
  /** Its node id, only to derive the `^t-…` reference. */
  id: string;
  title: string;
  fields: Record<string, string>;
  /** Path of its body note in the archive, sans `.md` (a wikilink target). */
  bodyLink: string | null;
  /** The day it was finished (YYYY-MM-DD, for ✅), when it is. */
  doneOn: string | null;
};

export const STATUS_KEY = TASK_ATTR.status;
/** When it was completed: written as the ✅ day, so it is not also a field. */
export const DONE_AT_KEY = TASK_ATTR.doneAt;
/** "何時做" and the key it replaced; the first one a task has is read. */
export const WHEN_KEYS = [TASK_ATTR.when, "_task_due"] as const;
const DEADLINE_KEY = TASK_ATTR.deadline;
const RECUR_KEY = TASK_ATTR.recur;
const SOMEDAY_KEY = TASK_ATTR.someday;
/** The key a "何時做" is written to. */
export const WRITTEN_WHEN_KEY = TASK_ATTR.when;

/** The frontmatter key marking an Onden task list, and its value. */
export const TASK_LIST_MARKER = "onden_export";
export const TASK_LIST_KIND = "tasks";

/** The archive path of the list and the folder of its tasks' note files. */
export const TASK_FOLDER: Record<TaskListLang, string> = { "zh-TW": "任務", en: "Tasks" };

const HEADINGS: Record<TaskListLang, Record<Section, string>> = {
  "zh-TW": { today: "今天", upcoming: "接下來", anytime: "隨時", someday: "某天", done: "已完成" },
  en: { today: "Today", upcoming: "Upcoming", anytime: "Anytime", someday: "Someday", done: "Done" },
};
const INTRO: Record<TaskListLang, string> = {
  "zh-TW": "這份清單由 Onden 匯出，每一行是一個獨立任務（不屬於任何筆記）。日期與重複用 Obsidian Tasks 外掛的寫法：⏳ 何時做、📅 截止、🔁 重複、✅ 完成。行尾的 ^代碼請保留，匯回 Onden 時用來對回同一個任務；標題下的段落只是分類，可以隨意搬動。",
  en: "This list was exported from Onden; each line is a standalone task (not part of any note). Dates and repeats use the Obsidian Tasks plugin's symbols: ⏳ scheduled, 📅 due, 🔁 repeat, ✅ done. Keep the trailing ^code: importing back into Onden uses it to match the same task. The headings only group the tasks and can be moved freely.",
};

type Section = "today" | "upcoming" | "anytime" | "someday" | "done";

/** A date the Obsidian Tasks symbols can carry: a day, or a day and time. */
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}(?:T[\d:]+)?$/.test(v);
const isTruthy = (v: string | undefined) => !!v && !/^(false|0|no)$/i.test(v.trim());

/** The `^t-…` reference of task `id`: stable for as long as the task lives. */
export const taskRef = (id: string) => `t-${id.replaceAll("-", "").slice(0, 12)}`;

/** Whether node `id` is the task `ref` names (a prefix of its id's hex). */
export const refMatchesId = (ref: string, id: string) => /^t-[0-9a-f]{12}$/.test(ref) && id.replaceAll("-", "").startsWith(ref.slice(2));

const whenOf = (fields: Record<string, string>) => WHEN_KEYS.map((k) => fields[k]).find((v) => v) ?? null;

// ── recurrence ⇄ words ──────────────────────────────────────────────────────

const UNIT = { d: "day", w: "week", m: "month" } as const;

/** "2w" → "every 2 weeks"; a rule this does not know is written as it is. */
export function recurAsWords(recur: string): string {
  const rule = parseRecur(recur);
  if (!rule) return recur;
  return rule.n === 1 ? `every ${UNIT[rule.unit]}` : `every ${rule.n} ${UNIT[rule.unit]}s`;
}

/** "every 2 weeks" → "2w"; years are months ("every 2 years" → "24m", as Onden
 *  has no year unit); other text, and a count too big for a rule, is kept as
 *  it is for the importer's validation to refuse. */
export function recurFromWords(words: string): string {
  const text = words.trim();
  const m = /^every\s+(?:(\d+)\s+)?(day|week|month|year)s?$/i.exec(text);
  if (!m) return text;
  const unit = m[2]!.toLowerCase();
  const n = Number(m[1] ?? 1);
  const rule = unit === "year" ? `${12 * n}m` : `${n}${unit[0]}`;
  return isParsableRecur(rule) ? rule : text;
}

// ── writing ─────────────────────────────────────────────────────────────────

const BOX: Record<string, string> = { todo: " ", done: "x", cancelled: "-", doing: "/" };
const BOX_STATUS: Record<string, string> = { " ": "todo", x: "done", X: "done", "-": "cancelled", "/": "doing" };

/** The inline-field name a `_task_*` key is written under. */
const fieldName = (key: string) => key.replace(/^_task_/, "");

const oneLine = (text: string) => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

function sectionOf(task: TaskListItem, today: string): Section {
  const status = task.fields[STATUS_KEY] ?? "todo";
  if (status === "done" || status === "cancelled") return "done";
  return taskHome({ when: whenOf(task.fields), someday: isTruthy(task.fields[SOMEDAY_KEY]) }, today);
}

/** One task as a list line. */
export function taskLine(task: TaskListItem): string {
  const status = task.fields[STATUS_KEY] ?? "todo";
  const known = status in BOX;
  const parts = [`- [${known ? BOX[status] : " "}] ${oneLine(task.title)}`];
  if (task.bodyLink) parts.push(`[[${task.bodyLink}]]`);
  const recur = task.fields[RECUR_KEY];
  if (recur) parts.push(`🔁 ${recurAsWords(oneLine(recur))}`);
  // A value that is not a date (it would not read back after a symbol) is a
  // field by its name instead.
  const fieldParts: string[] = [];
  const dated = (symbol: string, key: string, value: string | null | undefined) => {
    if (!value) return;
    if (isDay(value)) parts.push(`${symbol} ${value}`);
    else fieldParts.push(`[${fieldName(key)}:: ${oneLine(value)}]`);
  };
  dated("⏳", WRITTEN_WHEN_KEY, whenOf(task.fields));
  dated("📅", DEADLINE_KEY, task.fields[DEADLINE_KEY]);
  dated("✅", "_task_done", task.doneOn);
  if (!known) fieldParts.push(`[status:: ${oneLine(status)}]`);
  const symbolKeys = new Set<string>([STATUS_KEY, RECUR_KEY, DEADLINE_KEY, DONE_AT_KEY, ...WHEN_KEYS]);
  // A legacy `_task_due` beside a `_task_when` is the older copy: not written twice.
  for (const [key, value] of Object.entries(task.fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (symbolKeys.has(key) || !key.startsWith("_task_") || value === "") continue;
    fieldParts.push(`[${fieldName(key)}:: ${oneLine(value)}]`);
  }
  parts.push(...fieldParts);
  parts.push(`^${taskRef(task.id)}`);
  return parts.join(" ");
}

/** The whole list file: frontmatter, a short note on what it is, then the
 *  tasks under five headings (empty ones left out), each in `order`. */
export function renderTaskList(tasks: readonly TaskListItem[], options: { lang: TaskListLang; today: string; exportedAt: string }): string {
  const { lang, today, exportedAt } = options;
  const bySection = new Map<Section, TaskListItem[]>();
  for (const task of tasks) {
    const section = sectionOf(task, today);
    bySection.set(section, [...(bySection.get(section) ?? []), task]);
  }
  const front = writeFrontmatter([entryFor(TASK_LIST_MARKER, TASK_LIST_KIND), entryFor("exported_at", exportedAt)]);
  const blocks = (["today", "upcoming", "anytime", "someday", "done"] as const).flatMap((section) => {
    const list = bySection.get(section);
    if (!list?.length) return [];
    const sorted = [...list].sort((a, b) => (whenOf(a.fields) ?? "~").localeCompare(whenOf(b.fields) ?? "~"));
    return [`## ${HEADINGS[lang][section]}\n\n${sorted.map(taskLine).join("\n")}\n`];
  });
  return `${front}\n> ${INTRO[lang]}\n\n${blocks.join("\n")}`;
}

// ── reading ─────────────────────────────────────────────────────────────────

/** A task line read back. `title` is the line's text before any fields;
 *  `link` is a wikilink that ended it (the task's note file, when the
 *  importer finds one — otherwise it is part of the title, `titleWithLink`). */
export type ParsedTask = {
  title: string;
  titleWithLink: string;
  link: string | null;
  ref: string | null;
  fields: Record<string, string>;
};

const LINE = /^\s*[-*+]\s+\[(.)\]\s+(.*\S)\s*$/;
// Trailing tokens, taken off the end one at a time (fields may come in any order).
const TAIL_REF = new RegExp(`\\s\\^([${BLOCK_ID_CHARS}]+)$`);
const TAIL_FIELD = /\s\[([A-Za-z][\w-]*):: ([^\]\n]*)\]$/;
const TAIL_DATE = /\s(✅|⏳|📅)\s(\d{4}-\d{2}-\d{2}(?:T[\d:]+)?)$/;
const TAIL_RECUR = /\s🔁\s([^⏳📅✅🔁[\]]+?)$/;

/** The `[[link]]` that ends `text` after a blank: where it starts and its target. */
function tailLink(text: string): { index: number; target: string } | null {
  const last = scanWikilinks(text).at(-1);
  if (!last || last.end !== text.length || !/\s/.test(text[last.start - 1] ?? "")) return null;
  const { target } = splitWikilink(last.body);
  return target === "" ? null : { index: last.start - 1, target };
}

/** Whether `content` is a task list an Onden export wrote. */
export function isTaskList(content: string): boolean {
  const front = readFrontmatter(content);
  const entry = front?.entries.find((e) => e.key === TASK_LIST_MARKER);
  return !!entry && entryValue(entry) === TASK_LIST_KIND;
}

/** The tasks of a task list file, in file order. */
export function parseTaskList(content: string): ParsedTask[] {
  const body = readFrontmatter(content)?.body ?? content;
  const tasks: ParsedTask[] = [];
  const fence = fenceScanner();
  for (const raw of body.split(/\r?\n/)) {
    if (fence(raw) !== "outside") continue;
    const m = LINE.exec(raw);
    if (!m) continue;
    let rest = ` ${m[2]!}`;
    let ref: string | null = null;
    const fields: Record<string, string> = {};
    const refMatch = TAIL_REF.exec(rest);
    if (refMatch) { ref = refMatch[1]!; rest = rest.slice(0, refMatch.index); }
    for (;;) {
      const field = TAIL_FIELD.exec(rest);
      if (field) { fields[`_task_${field[1]}`] ??= field[2]!; rest = rest.slice(0, field.index); continue; }
      const date = TAIL_DATE.exec(rest);
      if (date) {
        const key = date[1] === "⏳" ? WRITTEN_WHEN_KEY : date[1] === "📅" ? DEADLINE_KEY : DONE_AT_KEY;
        // ✅ is a day; the instant kept for it is midday UTC, which is that day wherever the person is.
        fields[key] ??= key === DONE_AT_KEY && !date[2]!.includes("T") ? `${date[2]}T12:00:00.000Z` : date[2]!;
        rest = rest.slice(0, date.index);
        continue;
      }
      const recur = TAIL_RECUR.exec(rest);
      if (recur) { fields[RECUR_KEY] ??= recurFromWords(recur[1]!); rest = rest.slice(0, recur.index); continue; }
      break;
    }
    const titleWithLink = rest.trim();
    const linkMatch = tailLink(rest);
    const link = linkMatch ? linkMatch.target.trim() : null;
    const title = (linkMatch ? rest.slice(0, linkMatch.index) : rest).trim();
    fields[STATUS_KEY] ??= BOX_STATUS[m[1]!] ?? "todo";
    tasks.push({ title, titleWithLink, link, ref, fields });
  }
  return tasks.filter((t) => t.titleWithLink !== "");
}
