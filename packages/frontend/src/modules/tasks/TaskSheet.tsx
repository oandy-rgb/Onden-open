// The settings sheet of one task: a circle that finishes it, its title, where it lives, 何時做 as
// pills, then one row each for 時間 / 截止 / 重複 / 提醒. A row shows what is set (grey 「未設定」
// when nothing is) and opens its choices on a tap, one row at a time. Every pill is one write through
// `actions.change`; the page moves the task to its tab as the row updates.

import { useDismiss } from "../../hooks/useEscapeKey";
import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { DatePicker, Pressable, Select, Sheet, TextField, SearchField } from "../../components/ui";
import { TimeField } from "./TimeField";
import { ChoiceRow as Row } from "./ChoiceRow";
import { requestFocus } from "../../lib/focus";
import { useT } from "../../lib/i18n";
import { classNames } from "../../lib/utils";
import { formatLineTime, parseRecur, isClockTime } from "@onden/markdown";
import { addDays, dateTimeId } from "../../lib/localDate";
import {
  describeDay, isOpen, recurPreset, thisFriday, whenChanges, whenChoiceOf,
  type TaskChanges, type TaskItem, type WhenChoice,
} from "../../lib/tasks";
import { dayLabel } from "./taskLabels";
import "./tasks.css";
import { isEnterKey } from "../../lib/keys";
import { useFieldDraft } from "../../hooks/useFieldDraft";

export type NoteChoice = { id: string; title: string };

export type TaskActions = {
  change: (task: TaskItem, changes: TaskChanges) => void;
  complete: (task: TaskItem) => void;
  /** `blockRef`: the `^id` of the task's line, to open the note scrolled to it. */
  openNote: (noteId: string, blockRef?: string | null) => void;
  /** Open the task's own node in the editor (a standalone task's content). */
  openBody: (taskId: string) => void;
  remove: (task: TaskItem) => void;
  /** 不做了: cancelled (a note with no box: taken off its day); the page tells it with an Undo. */
  drop: (task: TaskItem) => void;
  /** Absent until the data layer can move a task into / out of a note. */
  place?: (task: TaskItem, noteId: string) => void;
  unplace?: (task: TaskItem) => void;
};

type Props = {
  task: TaskItem;
  today: string;
  notes: readonly NoteChoice[];
  actions: TaskActions;
  onClose: () => void;
};

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return <Pressable type="button" className={classNames("tk-pill", on && "tk-pill--on")} aria-pressed={on} onClick={onClick}>{children}</Pressable>;
}

function Group({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="tk-sheet-group" role="group" aria-label={label}>
      <div className="tk-sheet-label">{label}{hint && <small>{hint}</small>}</div>
      {children}
    </div>
  );
}

type RowId = "time" | "deadline" | "repeat" | "remind";

export default function TaskSheet({ task, today, notes, actions, onClose }: Props) {
  const t = useT();
  const [pickingDate, setPickingDate] = useState<null | "when" | "deadline" | "remind">(null);
  // Back and Esc fold the open month away first, then close the sheet.
  useDismiss(() => setPickingDate(null), pickingDate !== null);
  const [customRecur, setCustomRecur] = useState(false);
  const [openRow, setOpenRow] = useState<RowId | null>(null);
  const [placing, setPlacing] = useState(false);
  const [noteQuery, setNoteQuery] = useState("");

  const when = whenChoiceOf(task, today);
  const change = (changes: TaskChanges) => actions.change(task, changes);
  const row = (id: RowId) => ({ open: openRow === id, unset: t("Not set"), onToggle: () => { setPickingDate(null); setOpenRow(openRow === id ? null : id); } });
  // A ready-made choice is the whole answer: it writes and the row closes. Editors (a date, a clock, a custom
  // rule) keep it open, and so does a repeat rule: how it counts is asked right under it.
  const choose = (changes: TaskChanges) => { setPickingDate(null); setCustomRecur(false); setOpenRow(null); change(changes); };
  const pickWhen = (choice: WhenChoice) => { setPickingDate(null); change(whenChanges(choice, today)); };
  // The title typed so far, saved on Enter / leaving the box, and also when the sheet closes or the page is hidden
  // with it unsaved. It goes to the task it was typed on (the `change` of that render).
  const title = useFieldDraft<typeof change>({
    target: change, targetKey: task.id, committed: task.title,
    commit: (changeTask, text, { base }) => { const next = text.trim(); if (next && next !== base) changeTask({ title: next }); },
  });
  const commitTitle = () => {
    // An emptied title goes back to the task's own.
    if (!title.text.trim()) title.discard();
    else void title.flush();
  };

  const deadline = task.deadline;
  const deadlinePreset = !deadline ? "none"
    : deadline === today ? "today"
    : deadline === addDays(today, 1) ? "tomorrow"
    : deadline === thisFriday(today) ? "friday" : "date";
  // 「那天早上」 needs a day to mean: the task's, or its deadline's.
  const taskDay = task.whenDate ?? deadline;
  const reminderDay = taskDay ?? today;
  const remindPreset = !task.remindAt ? "none" : task.remindAt === `${reminderDay}T09:00` ? "morning" : "time";
  // Only a wall-clock reminder ("2026-10-30T09:00") has a day and a time to show here; an instant
  // (quick add stores one, with a zone) is another clock's reading and shows as the pill's text only.
  const wallClock = task.remindAt && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(task.remindAt) ? task.remindAt : null;
  const remindDay = wallClock?.split("T")[0] ?? null;
  const remindTime = wallClock?.slice(11, 16) || "09:00";
  const preset = recurPreset(task.recur);
  const rule = task.recur ? parseRecur(task.recur) : null;
  const unitText = { d: t("days"), w: t("weeks"), m: t("months") } as const;
  const recurText = preset === "none" ? null
    : preset === "1d" ? t("Every day") : preset === "1w" ? t("Every week") : preset === "1m" ? t("Every month")
    : rule ? `${t("Every")} ${rule.n} ${unitText[rule.unit as keyof typeof unitText] ?? ""}`.trim() : t("Custom…");

  const matches = useMemo(() => {
    const q = noteQuery.trim().toLowerCase();
    return notes.filter((n) => !q || n.title.toLowerCase().includes(q)).slice(0, 8);
  }, [notes, noteQuery]);

  const fromNote = task.noteId !== null;
  const dateText = (date: string | null) => (date ? dayLabel(describeDay(date, today), t) : "");
  // "Tomorrow 09:00": an instant (quick add stores one, with a zone) is read in the workspace's zone, never as the raw stamp.
  const remindLabel = (at: string) => {
    const instant = /(?:Z|[+-]\d{2}:?\d{2})$/.test(at);
    if (instant && Number.isNaN(new Date(at).getTime())) return t("Pick a time…");
    const [day = "", clock = ""] = (instant ? dateTimeId(new Date(at)) : at.replace("T", " ")).split(" ");
    return `${dateText(day)} ${/\d{2}:\d{2}/.exec(clock)?.[0] ?? ""}`.trim();
  };

  return (
    <Sheet label={t("Edit {title}", { title: task.title })} className="tk-sheet-layer" onClose={onClose} cardClassName="tk-sheet">
      <div className="tk-sheet-top">
        <Pressable type="button" className="tk-box" aria-label={t("Complete")} onClick={() => { actions.complete(task); onClose(); }}>
          <span className="tk-box-mark" aria-hidden />
        </Pressable>
        <TextField
          className="tk-sheet-title"
          value={title.text}
          aria-label={t("Task title")}
          onChange={(e) => title.edit(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => { if (isEnterKey(e)) { e.preventDefault(); commitTitle(); e.currentTarget.blur(); } }}
        />
      </div>
      {fromNote ? (
        <Pressable type="button" className="tk-sheet-from" onClick={() => { onClose(); actions.openNote(task.noteId!, task.blockRef); }}>
          {t("From {title}", { title: task.noteTitle || t("Untitled") })}<ChevronRight size={14} aria-hidden />
        </Pressable>
      ) : (
        <p className="tk-sheet-source">{t("A standalone task.")}</p>
      )}

      <>
        <Group label={t("When")} hint={t("Decides which page it shows up on")}>
          <div className="tk-pills">
          <Pill on={when === "today"} onClick={() => pickWhen({ kind: "today" })}>{t("Today")}</Pill>
          <Pill on={when === "evening"} onClick={() => pickWhen({ kind: "evening" })}>{t("Tonight")}</Pill>
          <Pill on={when === "tomorrow"} onClick={() => pickWhen({ kind: "tomorrow" })}>{t("Tomorrow")}</Pill>
          <Pill on={when === "nextMonday"} onClick={() => pickWhen({ kind: "nextMonday" })}>{t("Next Monday")}</Pill>
          <Pill on={when === "date" || pickingDate === "when"} onClick={() => setPickingDate(pickingDate === "when" ? null : "when")}>
            {when === "date" ? dateText(task.whenDate) : t("Pick a date…")}
          </Pill>
          </div>
          <div className="tk-pills tk-sheet-loose">
            <span className="tk-sheet-loose-label">{t("No day")}</span>
            <Pill on={when === "anytime"} onClick={() => pickWhen({ kind: "anytime" })}>{t("Anytime")}</Pill>
            <Pill on={when === "someday"} onClick={() => pickWhen({ kind: "someday" })}>{t("Someday")}</Pill>
          </div>
        </Group>
        {pickingDate === "when" && (
          <DatePicker inline today={today} label={t("Pick a date…")} value={task.whenDate}
            onChange={(date) => { if (date) pickWhen({ kind: "date", date }); }} />
        )}

        <div className="tk-sheet-rows">
        {(task.whenDate || task.time ? (
          <Row label={t("Time")} value={task.time ? formatLineTime(task.time, task.until) : null} {...row("time")}>
            <div className="tk-sheet-custom">
              <TimeField className="tk-sheet-input" hourLabel={t("Hour")} minuteLabel={t("Minute")} label={t("Starts at")} value={task.time ?? ""}
                onChange={(v) => { if (isClockTime(v)) change({ time: v }); }} />
              {task.time && (
                <>
                  <span>–</span>
                  <TimeField className="tk-sheet-input" hourLabel={t("Hour")} minuteLabel={t("Minute")} label={t("Ends at")} value={task.until ?? ""}
                    onChange={(v) => { if (isClockTime(v) && v > task.time!) change({ until: v }); else if (v === "") change({ until: null }); }} />
                </>
              )}
              {task.time && <Pill on={false} onClick={() => choose({ time: null })}>{t("Clear")}</Pill>}
            </div>
          </Row>
        ) : <p className="tk-sheet-example">{t("Pick a day first to give it a time.")}</p>)}

        <Row label={t("Deadline")} value={deadline ? dateText(deadline) : null} {...row("deadline")}>
          <p className="tk-sheet-example">{t("Never hides it; when close, it floats up to Today")}</p>
          <div className="tk-pills">
          <Pill on={deadlinePreset === "today"} onClick={() => choose({ deadline: today })}>{t("Today")}</Pill>
          <Pill on={deadlinePreset === "tomorrow"} onClick={() => choose({ deadline: addDays(today, 1) })}>{t("Tomorrow")}</Pill>
          <Pill on={deadlinePreset === "friday"} onClick={() => choose({ deadline: thisFriday(today) })}>{dateText(thisFriday(today))}</Pill>
          <Pill on={deadlinePreset === "date" || pickingDate === "deadline"} onClick={() => setPickingDate(pickingDate === "deadline" ? null : "deadline")}>
            {deadlinePreset === "date" ? dateText(deadline) : t("Pick a date…")}
          </Pill>
          {deadline && <Pill on={false} onClick={() => choose({ deadline: null })}>{t("Clear")}</Pill>}
          </div>
          {pickingDate === "deadline" && (
            <DatePicker inline today={today} label={t("Deadline date")} value={deadline}
              onChange={(date) => { if (date) change({ deadline: date }); }} />
          )}
        </Row>
        </div>
      </>

      <div className="tk-sheet-rows">
        <Row label={t("Repeat")} value={recurText} {...row("repeat")}>
          <div className="tk-pills">
          <Pill on={preset === "1d"} onClick={() => { setCustomRecur(false); change({ recur: "1d" }); }}>{t("Every day")}</Pill>
          <Pill on={preset === "1w"} onClick={() => { setCustomRecur(false); change({ recur: "1w" }); }}>{t("Every week")}</Pill>
          <Pill on={preset === "1m"} onClick={() => { setCustomRecur(false); change({ recur: "1m" }); }}>{t("Every month")}</Pill>
          <Pill on={preset === "custom" || customRecur} onClick={() => setCustomRecur(!customRecur)}>{t("Custom…")}</Pill>
          {task.recur && <Pill on={false} onClick={() => choose({ recur: null })}>{t("Clear")}</Pill>}
          </div>
        {(customRecur || preset === "custom") && (
          <div className="tk-sheet-custom">
            <span>{t("Every")}</span>
            <TextField type="number" min={1} className="tk-sheet-input tk-sheet-input--n" aria-label={t("Repeat every")}
              defaultValue={rule?.n ?? 2}
              onChange={(e) => { const n = Math.floor(Number(e.target.value)); if (n >= 1) change({ recur: `${n}${rule?.unit ?? "d"}` }); }} />
            <Select className="tk-sheet-input" aria-label={t("Repeat unit")} value={rule?.unit ?? "d"}
              onChange={(e) => change({ recur: `${rule?.n ?? 2}${e.target.value}` })}>
              <option value="d">{t("days")}</option>
              <option value="w">{t("weeks")}</option>
              <option value="m">{t("months")}</option>
            </Select>
          </div>
        )}
        {task.recur && (
          <Group label={t("Count from")}>
            <div className="tk-pills">
            <Pill on={task.recurMode === "fixed"} onClick={() => change({ recur_mode: "fixed" })}>{t("On schedule")}</Pill>
            <Pill on={task.recurMode === "after"} onClick={() => change({ recur_mode: "after" })}>{t("From completion")}</Pill>
            </div>
          </Group>
        )}
        {task.recur && (
          <p className="tk-sheet-example">
            {task.recurMode === "after" ? t("e.g. watering plants: the next one is a week after you finish this one") : t("e.g. paying the electricity bill: always on the same day, even if you pay late")}
          </p>
        )}
        </Row>

        <Row label={t("Reminder")} value={task.remindAt ? remindLabel(task.remindAt) : null} {...row("remind")}>
          <div className="tk-pills">
          {(taskDay || remindPreset === "morning") && <Pill on={remindPreset === "morning"} onClick={() => choose({ remind_at: `${reminderDay}T09:00` })}>{t("That morning, 9:00")}</Pill>}
          <Pill on={remindPreset === "time" || pickingDate === "remind"} onClick={() => setPickingDate(pickingDate === "remind" ? null : "remind")}>
            {remindPreset === "time" ? remindLabel(task.remindAt!) : t("Pick a time…")}
          </Pill>
          {task.remindAt && <Pill on={false} onClick={() => choose({ remind_at: null })}>{t("Clear")}</Pill>}
          </div>
        {pickingDate === "remind" && (
          <>
            <DatePicker inline today={today} label={t("Reminder day")} value={remindDay ?? null}
              onChange={(date) => { if (date) change({ remind_at: `${date}T${remindTime}` }); }} />
            <TimeField className="tk-sheet-input" hourLabel={t("Hour")} minuteLabel={t("Minute")} label={t("Reminder clock time")} value={remindTime}
              onChange={(v) => { if (v) change({ remind_at: `${remindDay ?? reminderDay}T${v}` }); }} />
          </>
        )}
        </Row>
        </div>

      <div className="tk-sheet-foot">
        {task.status !== "done" && <Pressable type="button" onClick={() => { onClose(); requestFocus(task.id); }}>{t("Start focus")}</Pressable>}
        {fromNote ? (
          actions.unplace && (
            <Pressable type="button" onClick={() => { actions.unplace!(task); onClose(); }}>
              {t("Take out of note")}<small>{t("Its line leaves the note; it becomes a standalone task")}</small>
            </Pressable>
          )
        ) : (
          <>
            {actions.place && <Pressable type="button" aria-expanded={placing} onClick={() => setPlacing(!placing)}>{t("Put in a note…")}</Pressable>}
            <Pressable type="button" onClick={() => { onClose(); actions.openBody(task.id); }}>{t("Write details")}</Pressable>
          </>
        )}
        {isOpen(task.status) && (
          <Pressable type="button" onClick={() => { actions.drop(task); onClose(); }}>
            {t("Won't do")}<small>{t("Crossed out, not deleted")}</small>
          </Pressable>
        )}
        <Pressable type="button" className="tk-sheet-delete" onClick={() => { actions.remove(task); onClose(); }}>
          {t("Delete task")}{task.blockRef && <small>{t("Its line leaves the note too")}</small>}
        </Pressable>
      </div>
      {placing && actions.place && (
        <div className="tk-sheet-notes">
          <SearchField label={t("Search notes…")} value={noteQuery} onValueChange={setNoteQuery} />
          <ul>
            {matches.map((n) => (
              <li key={n.id}><Pressable type="button" onClick={() => { actions.place!(task, n.id); onClose(); }}>{n.title || t("Untitled")}</Pressable></li>
            ))}
          </ul>
        </div>
      )}
    </Sheet>
  );
}
