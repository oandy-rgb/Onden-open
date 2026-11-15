// One task line, the same for both sources: a standalone task and a
// checkbox line inside a note.
// The row only draws; the page owns what ticking and tapping do.

import { Check, Repeat, Timer } from "lucide-react";
import { Button, Chip, Pressable } from "../../components/ui";
import { formatLineTime } from "@onden/markdown";
import { classNames } from "../../lib/utils";
import { useT } from "../../lib/i18n";
import { deadlineIsSoon, describeDay, homeTab, hostNoteLabel, isOpen, isOverdue, leftOverAge, type TaskItem } from "../../lib/tasks";
import { dayLabel, deadlineLabel, leftOverLabel, recurChipText } from "./taskLabels";
import { displayTitle } from "../../lib/noteLabel";
import { taskDragSource } from "../../lib/taskDrag";
import "./tasks.css";

type Props = {
  task: TaskItem;
  today: string;
  /** The upcoming tab groups by day, so the day is not repeated on the row. */
  showWhen: boolean;
  /** Ticked a moment ago: the row stays, struck through, until the tab changes. */
  justDone?: boolean;
  disabled?: boolean;
  onToggle: (task: TaskItem) => void;
  onOpen: (task: TaskItem) => void;
  /** Begin a focus on this task; absent: no focus button (a row that is not an open task). */
  onFocus?: (task: TaskItem) => void;
  /** An open task can be dragged to an hour of the day timeline beside the list (plans its time). */
  planDrag?: boolean;
  /** A visible 「排到今天」 button (day becomes today); absent: no button. */
  onPlanToday?: (task: TaskItem) => void;
  /** Minutes already spent in focus on this task today; shown as a chip when above zero. */
  focusedMinutes?: number;
  /** A late task gets a visible 「某天」 button that parks it; absent: no button. */
  onSomeday?: (task: TaskItem) => void;
};

export default function TaskRow({ task, today, showWhen, justDone = false, disabled = false, onToggle, onOpen, onFocus, planDrag = false, focusedMinutes = 0, onPlanToday, onSomeday }: Props) {
  const t = useT();
  const done = !isOpen(task.status) || justDone;
  const whenText = showWhen && task.whenDate && !done ? dayLabel(describeDay(task.whenDate, today), t) : null;
  const soon = deadlineIsSoon(task.deadline, today);
  // A past day sits on 今天 but is called late, as the due-soon notification calls it.
  const hostNote = hostNoteLabel(task.noteTitle, task.whenDate ?? today, today);
  const late = !done && task.whenDate && isOverdue(task, today) ? leftOverLabel(leftOverAge(task.whenDate, today), t) : null;

  return (
    <li className={classNames("tk-row", done && "tk-row--done")} {...(planDrag && !done && !task.time ? taskDragSource(task.id) : {})}>
      <Pressable
        type="button"
        className={classNames("tk-box", task.someday && "tk-box--someday", done && "tk-box--checked")}
        role="checkbox"
        aria-checked={done}
        disabled={disabled}
        onClick={() => onToggle(task)}
        aria-label={done ? t("Reopen {title}", { title: task.title }) : t("Mark {title} done", { title: task.title })}
      >
        <span className="tk-box-mark" aria-hidden>{done && <Check size={14} strokeWidth={3} />}</span>
      </Pressable>
      <Pressable type="button" className="tk-main" onClick={() => onOpen(task)} aria-label={t("Edit {title}", { title: task.title })}>
        <span className="tk-title">{displayTitle(task.title)}</span>
        {(whenText || late || task.time || task.deadline || task.recur || task.evening || focusedMinutes > 0) && (
          <span className="tk-chips">
            {late && <span className="tk-chip tk-chip--overdue">{late}</span>}
            {whenText && !late && <span className="tk-chip">{whenText}</span>}
            {task.time && <span className="tk-chip">{formatLineTime(task.time, task.until)}</span>}
            {task.evening && <span className="tk-chip tk-chip--evening">{homeTab(task, today) === "upcoming" ? t("Evening") : t("Tonight")}</span>}
            {task.deadline && (
              <span className={classNames("tk-chip", soon ? "tk-chip--deadline-soon" : "tk-chip--deadline")}>
                {deadlineLabel(task.deadline, today, t)}
              </span>
            )}
            {focusedMinutes > 0 && <Chip tone="accent" className="tk-focused"><Timer size={11} aria-hidden /> {t("Focused {n} min", { n: focusedMinutes })}</Chip>}
            {task.recur && (
              <span className="tk-chip tk-chip--recur">
                <Repeat size={11} aria-hidden /> {recurChipText(task, t)}
              </span>
            )}
          </span>
        )}
        {hostNote && <span className="tk-note">{hostNote}</span>}
      </Pressable>
      {onPlanToday && !done && task.whenDate !== today && (
        <Button size="sm" variant="secondary" className="tk-plan-today" aria-label={t("Plan {title} for today", { title: task.title })} onClick={() => onPlanToday(task)}>
          {t("Plan for today")}
        </Button>
      )}
      {onSomeday && late && (
        <Button size="sm" variant="ghost" className="tk-someday" aria-label={t("Move {title} to Someday", { title: task.title })} onClick={() => onSomeday(task)}>
          {t("Someday")}
        </Button>
      )}
      {onFocus && !done && (
        <Button variant="icon" className="tk-focus" aria-label={t("Start focus on {title}", { title: task.title })} onClick={() => onFocus(task)}>
          <Timer size={16} aria-hidden="true" />
        </Button>
      )}
    </li>
  );
}
