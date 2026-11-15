// The 今天 page's right column: the whole day as a timeline, open from the first line (nothing folded — the
// person sees the day at once), with the red line for now. On top, what has no time yet (dragged onto an
// hour to plan it, or opened). The timeline is TimelinePlanner (tap an hour, drag a task onto it, move and
// stretch a planned block); with focus on it has two lanes: what was planned and the calendar's events,
// and — narrow, at the right edge — the time really spent in focus (DayTimeline focusLane). A past day adds
// 「那天的時間花在哪」 under it.

import { onTimeline } from "@onden/markdown";
import { useT } from "../../../lib/i18n";
import { eventsOnDay, type ExternalEvent } from "../../../lib/externalCalendars";
import { displayTitle } from "../../../lib/noteLabel";
import { taskDragSource } from "../../../lib/taskDrag";
import { Button } from "../../../components/ui";
import { useAllNodes } from "../../../lib/appStore";
import type { TaskItem } from "../../../lib/tasks";
import type { TaskBoard } from "../../taskParts";
import { useDayItemActions } from "../day/dayTaskWrites";
import { useDayItems } from "../day/useDayItems";
import TimelinePlanner from "../day/TimelinePlanner";
import TimeSpent from "./TimeSpent";
import { focusTotals } from "./focusTotals";
import type { FocusOfDay } from "../day/useFocusOfDay";

type Props = {
  date: string;
  today: string;
  tasksOn: boolean;
  /** Two lanes (planned | really focused); a phone keeps the one lane. */
  twoLanes: boolean;
  board: TaskBoard;
  /** The day's tasks, for what has no time yet and the table of time spent. */
  dayTasks: readonly TaskItem[];
  focus: FocusOfDay | null;
  nowMs: number;
  onOpenNode: (id: string) => void;
  /** The events of subscribed calendars on the shown days (one read for the page) and how one is opened. */
  external: readonly ExternalEvent[];
  onOpenExternal: (event: ExternalEvent) => void;
};

export default function TimelineColumn({ date, today, tasksOn, twoLanes, board, dayTasks, focus, nowMs, onOpenNode, external, onOpenExternal }: Props) {
  const t = useT();
  const nodes = useAllNodes();
  const { items } = useDayItems(date, today, focus);
  const { open } = useDayItemActions(onOpenNode);
  const untimed = dayTasks.filter((task) => task.status !== "done" && task.status !== "cancelled" && !task.time);
  const titleOf = (id: string) => nodes.find((node) => node.id === id)?.title;
  const past = date < today;
  const spentTotals = past && focus ? focusTotals(date, focus.sessions, focus.running, nowMs) : null;

  return (
    <section className="today-timeline" aria-label={t("Day timeline")}>
      {tasksOn && untimed.length > 0 && (
        <div className="today-untimed" aria-label={t("Not timed yet")}>
          <span className="today-untimed-label">{t("Not timed yet")}</span>
          <ul className="today-untimed-list">
            {untimed.map((task) => (
              <li key={task.id} {...taskDragSource(task.id)}>
                <Button size="sm" variant="ghost" className="today-untimed-item" onClick={() => board.setSheetId(task.id)}>{displayTitle(task.title)}</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {twoLanes && tasksOn && (
        <p className="today-lane-legend" aria-hidden="true"><span>{t("Planned")}</span><span>{t("Focused")}</span></p>
      )}
      <div className="today-timeline-scroll">
        <TimelinePlanner key={date} enabled={tasksOn} focusLane={twoLanes && tasksOn} date={date} items={items.filter(onTimeline)} nowMs={nowMs}
          onOpen={open} external={eventsOnDay(external, date)} onOpenExternal={onOpenExternal} />
        {spentTotals && <TimeSpent tasks={dayTasks} titleOf={titleOf} totals={spentTotals} />}
      </div>
    </section>
  );
}
