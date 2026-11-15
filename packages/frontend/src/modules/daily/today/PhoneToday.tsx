// 今天 on a phone: one column, no side-by-side. A header (the day, and 清單｜時間軸｜月 at the right, the one
// last chosen is kept), then
//   清單    the week row; one line for the day's journal (the last words written, a tap opens the note to
//           write in it — 「寫點什麼…」 when there are none); then the day's things (TasksColumn)
//   時間軸  the day as a timeline (one lane: the focus records are drawn as the day page draws them)
//   月      the month; a tap on a day goes back to the list on that day
// The running focus is the bar above the navigation (FocusScreens), not drawn here. 「全部的事」 covers the list.

import { useDismiss } from "../../../hooks/useEscapeKey";
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { plainExcerpt } from "@onden/markdown";
import { Button, Pressable, Segmented } from "../../../components/ui";
import { nodeNeedsBody } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { PREFS, usePersistedChoice } from "../../../lib/prefs";
import type { ExternalEvent } from "../../../lib/externalCalendars";
import type { TaskBoard } from "../../taskParts";
import DayStrip from "../day/DayStrip";
import { useDayNote } from "../day/useDayNote";
import { useWriteDay } from "../useWriteDay";
import JournalColumn from "./JournalColumn";
import AllTasksPanel from "./AllTasksPanel";
import TasksColumn from "./TasksColumn";
import TimelineColumn from "./TimelineColumn";
import type { FocusOfDay } from "../day/useFocusOfDay";
import type { TodayLists } from "./todayLists";

type View = "list" | "timeline" | "month";
const VIEWS: readonly View[] = ["list", "timeline", "month"];
const VIEW_LABEL: Record<View, string> = { list: "Task list", timeline: "Timeline view", month: "Month" };

type Props = {
  date: string;
  today: string;
  onPick: (date: string) => void;
  /** The page's header row (the day and its ‹ ›), drawn over the view switch. */
  header: ReactNode;
  tasksOn: boolean;
  dailyOn: boolean;
  board: TaskBoard;
  lists: TodayLists;
  focusByTask: ReadonlyMap<string, number>;
  focus: FocusOfDay | null;
  nowMs: number;
  marks: { written: ReadonlySet<string>; planned: ReadonlySet<string> };
  external: readonly ExternalEvent[];
  onOpenExternal: (event: ExternalEvent) => void;
  onOpenNode: (id: string) => void;
};

/** The last line of words in the note, as plain text. */
export function lastWords(markdown: string | null | undefined): string {
  const lines = (markdown ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  return last ? plainExcerpt(last, 80) : "";
}

export default function PhoneToday({ date, today, onPick, header, tasksOn, dailyOn, board, lists, focusByTask, focus, nowMs, marks, external, onOpenExternal, onOpenNode }: Props) {
  const t = useT();
  const [view, setView] = usePersistedChoice<View>(PREFS.todayPhoneView, VIEWS, "list");
  const [allOpen, setAllOpen] = useState(false);
  const { day, byDate } = useDayNote(date);
  const { writeDay, starting } = useWriteDay((d) => byDate.get(d), onOpenNode);
  const words = day && !nodeNeedsBody(day) ? lastWords(day.markdown) : "";
  const shown: View = view;
  const [monthOpen, setMonthOpen] = useState(false);
  // The month dropped down under the week row (journal-only page): Back folds it back to the week.
  useDismiss(() => setMonthOpen(false), monthOpen);
  // Tasks off, journal on: the page is the journal's own column (as the Journal page is), under the same week row and
  // month (DayStrip), with nothing else to switch between.
  if (!tasksOn) {
    return (
      <>
        {header}
        <div className="today-phone-body">
          <Button variant="ghost" size="sm" aria-expanded={monthOpen} onClick={() => setMonthOpen((open) => !open)}>{t("Show the month")}</Button>
          <DayStrip date={date} today={today} written={marks.written} planned={marks.planned} onPick={onPick} monthOpen={monthOpen} onMonthOpenChange={setMonthOpen} />
          <JournalColumn date={date} today={today} onOpenNode={onOpenNode} />
        </div>
      </>
    );
  }
  const options = VIEWS.map((id) => ({ value: id, label: t(VIEW_LABEL[id]) }));

  return (
    <>
      {header}
      <div className="today-phone-switch">
        <Segmented label={t("Day timeline")} value={shown} options={options} onChange={setView} />
      </div>
      <div className="today-phone-body">
        {shown === "list" && (allOpen ? <AllTasksPanel today={today} board={board} onClose={() => setAllOpen(false)} /> : (
          <>
            <DayStrip date={date} today={today} written={marks.written} planned={marks.planned} onPick={onPick} monthOpen={false} onMonthOpenChange={() => {}} />
            {dailyOn && (
              <Pressable type="button" className="today-phone-journal" disabled={starting || date > today} onClick={() => void writeDay(date)}>
                <span className="today-phone-journal-label">{t(date === today ? "Today's journal" : "This day's journal")}</span>
                <span className="today-phone-journal-words">{words || (date > today ? t("This day has no journal yet.") : t("Write something…"))}</span>
                <ChevronRight size={16} aria-hidden="true" />
              </Pressable>
            )}
            {tasksOn && <TasksColumn date={date} today={today} board={board} lists={lists} focusByTask={focusByTask} external={external}
              onOpenExternal={onOpenExternal} onSeeAll={() => setAllOpen(true)} />}
          </>
        ))}
        {shown === "timeline" && (
          <TimelineColumn date={date} today={today} tasksOn={tasksOn} twoLanes={false} board={board} dayTasks={lists.planned} focus={focus} nowMs={nowMs}
            onOpenNode={onOpenNode} external={external} onOpenExternal={onOpenExternal} />
        )}
        {shown === "month" && (
          <div className="today-month">
            <DayStrip date={date} today={today} written={marks.written} planned={marks.planned} monthOpen onMonthOpenChange={() => {}}
              onPick={(day) => { onPick(day); setView("list"); }} />
          </div>
        )}
      </div>
    </>
  );
}
