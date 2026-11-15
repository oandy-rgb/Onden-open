// The 今天 page's left column: the things of the day, in three lists that are the Tasks page's own rows
// (TaskRow, TaskSheet) under its own rules (todayLists over lib/tasks):
//   還沒做完     what was planned for an earlier day and is still open. Never moved by itself: each row has
//               its own 排到今天 (and 某天).
//   今天要做的   the day's tasks and the day's events from subscribed calendars (no tick box), then 「加一件事…」.
//   還沒排的     what could go on today; 「全部的事 ›」 opens the rest of the Tasks page's lists.
// A past day lists what that day had planned, done and left undone; a later day, what is planned for it.

import { Plus } from "lucide-react";
import { Button } from "../../../components/ui";
import EmptyState from "../../../components/EmptyState";
import { useT } from "../../../lib/i18n";
import { requestFocus } from "../../../lib/focus";
import { CANDIDATES_SHOWN, type TaskItem } from "../../../lib/tasks";
import { eventsOnDay, type ExternalEvent } from "../../../lib/externalCalendars";
import { openQuickAddTask, TaskRow, TaskSection, type TaskBoard } from "../../taskParts";
import { ExternalCard } from "../day/external/ExternalDayParts";
import type { TodayLists } from "./todayLists";

type Props = {
  date: string;
  today: string;
  board: TaskBoard;
  lists: TodayLists;
  /** Minutes focused today per task (only tasks with some). */
  focusByTask: ReadonlyMap<string, number>;
  external: readonly ExternalEvent[];
  onOpenExternal: (event: ExternalEvent) => void;
  onSeeAll: () => void;
};

export default function TasksColumn({ date, today, board, lists, focusByTask, external, onOpenExternal, onSeeAll }: Props) {
  const t = useT();
  const isToday = date === today;
  const row = (task: TaskItem, opts: { plan?: boolean } = {}) => (
    <TaskRow key={task.id} task={task} today={today} showWhen={task.whenDate !== date} justDone={board.justDone.has(task.id)}
      onToggle={board.toggle} onOpen={(item) => board.setSheetId(item.id)} onFocus={(item) => requestFocus(item.id)} planDrag
      focusedMinutes={focusByTask.get(task.id) ?? 0}
      onPlanToday={opts.plan ? (item) => { void board.planToday(item); } : undefined}
      onSomeday={opts.plan ? board.parkSomeday : undefined} />
  );
  const events = eventsOnDay(external, date);
  const dayTitle = isToday ? t("To do today") : t("To do on this day");
  const planned = lists.planned.length + events.length;
  const unplanned = lists.unplanned.slice(0, CANDIDATES_SHOWN + 2);

  return (
    <div className="today-tasks">
      {lists.leftOver.length > 0 && (
        <TaskSection title={t("Not finished yet")} count={lists.leftOver.length}>
          <ul className="tasks-list">{lists.leftOver.map((task) => row(task, { plan: true }))}</ul>
        </TaskSection>
      )}
      <TaskSection title={dayTitle} count={planned} note={lists.stillOpen > 0 ? t("Still open now: {n}", { n: lists.stillOpen }) : undefined}>
        {planned === 0 && <EmptyState size="inline" title={isToday ? t("Nothing planned for today.") : t("Nothing planned for this day.")} />}
        <ul className="tasks-list">
          {events.map((event) => <ExternalCard key={event.id} event={event} onOpen={onOpenExternal} />)}
          {lists.planned.map((task) => row(task))}
        </ul>
        {date >= today && (
          <Button variant="ghost" className="today-add" onClick={() => openQuickAddTask(undefined, { day: date })}>
            <Plus size={16} aria-hidden="true" /> {t("Add something…")}
          </Button>
        )}
      </TaskSection>
      {isToday ? (
        <TaskSection title={t("Still to plan")} count={lists.unplanned.length}
          action={<Button size="sm" variant="ghost" className="today-all" onClick={onSeeAll}>{t("All tasks ›")}</Button>}>
          {unplanned.length > 0 && <ul className="tasks-list">{unplanned.map((task) => row(task, { plan: true }))}</ul>}
        </TaskSection>
      ) : (
        <Button variant="ghost" className="today-all today-all--alone" onClick={onSeeAll}>{t("All tasks ›")}</Button>
      )}
    </div>
  );
}
