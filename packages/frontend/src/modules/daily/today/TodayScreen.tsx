// 今天 (?view=today): the day's page — journal and tasks together, a trial page beside the Journal and
// Tasks pages (those are unchanged). The parts are the existing ones, composed:
//   header      ‹ date ›, 今天 / 回到今天, the day's focus, and 天｜3 天｜週｜月
//   left        the day's things (TasksColumn: TaskRow, TaskSheet, the Tasks page's rules)
//   middle      the day's note, with a box to write in it (JournalColumn); can be folded away
//   right       the day as a timeline with a lane for the time really focused (TimelineColumn)
// 3 天 / 週 are the day pane's WeekBoard, 月 the month calendar of the week row (DayStrip). A phone is one
// column (PhoneToday). With the journal off there is no middle; with tasks off, no left column and the
// timeline is only a timeline; with both off the page is not offered (hooks/shellNavigation).
// Layout choices (widths, the folded journal, the span, the phone's view) are kept on this device.

import { useMemo, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, PanelLeftOpen } from "lucide-react";
import { Button, Chip, ColumnResizer, Segmented } from "../../../components/ui";
import EmptyState from "../../../components/EmptyState";
import { addToast } from "../../../lib/appStore";
import { useExternalEvents } from "../../../hooks/useExternalEvents";
import { useIsMobile, useMediaQuery } from "../../../hooks/useIsMobile";
import { useDailyNotesEnabled, useTasksEnabled } from "../../../hooks/useModuleFilter";
import { useNowMs } from "../../../hooks/useNowMs";
import { useToday } from "../../../hooks/useToday";
import { useT } from "../../../lib/i18n";
import { WIDE_QUERY } from "../../../lib/mediaQuery";
import { useColumnWidth, type PaneColumn } from "../../../lib/paneWidths";
import { PREFS, usePersistedChoice, usePersistedFlag } from "../../../lib/prefs";
import { addDays } from "../../../lib/localDate";
import { dayIdLabel } from "../../../lib/timeLabels";
import { classNames } from "../../../lib/utils";
import type { ExternalEvent } from "../../../lib/externalCalendars";
import { FocusPageBar, TaskSheet, useTaskBoard } from "../../taskParts";
import DayStrip, { weekDays, weekdayText } from "../day/DayStrip";
import ExternalEventSheet from "../day/external/ExternalEventSheet";
import WeekBoard from "../day/WeekBoard";
import { useDayItemActions } from "../day/dayTaskWrites";
import { rememberTodayPickedDay, todayPickedDay } from "./todayPickedDay";
import { useShownDay } from "../useShownDay";
import { useDayMarks } from "../useDayMarks";
import AllTasksPanel from "./AllTasksPanel";
import JournalColumn from "./JournalColumn";
import PhoneToday from "./PhoneToday";
import TasksColumn from "./TasksColumn";
import TimelineColumn from "./TimelineColumn";
import { focusTotals } from "./focusTotals";
import { todayLists } from "./todayLists";
import { useFocusOfDay } from "../day/useFocusOfDay";
import "../day/day.css";
import "./strings";
import "./today.css";

type Range = "day" | "3days" | "week" | "month";
const RANGES: readonly Range[] = ["day", "3days", "week", "month"];
const RANGE_LABEL: Record<Range, string> = { day: "1 day", "3days": "3 days", week: "Week", month: "Month" };

const TASKS_COLUMN: PaneColumn = { min: 260, max: 520, fallback: 340, pref: PREFS.todayTasksWidth };
const TIMELINE_COLUMN: PaneColumn = { min: 280, max: 560, fallback: 380, pref: PREFS.todayTimelineWidth };
/** What the journal column keeps when the other two are dragged wide. */
const JOURNAL_MIN = 320;

type Props = {
  online: boolean;
  onOpenNode: (id: string) => void;
  onRefresh: () => Promise<void> | void;
};

const toastError = (message: string) => addToast(message, "error");

export default function TodayScreen({ online, onOpenNode, onRefresh }: Props) {
  const t = useT();
  const phone = useIsMobile();
  const wide = useMediaQuery(WIDE_QUERY);
  const today = useToday();
  const nowMs = useNowMs();
  const tasksOn = useTasksEnabled();
  const dailyOn = useDailyNotesEnabled();
  const [date, pick] = useShownDay(today, todayPickedDay, rememberTodayPickedDay);
  const [range, setRange] = usePersistedChoice<Range>(PREFS.todayRange, RANGES, "day");
  const [folded, setFolded] = usePersistedFlag(PREFS.todayJournalFolded, false);
  const [allOpen, setAllOpen] = useState(false);
  // Below the wide width there is no room for three columns: the right one is the timeline or the journal.
  const [narrowPane, setNarrowPane] = useState<"timeline" | "journal">("timeline");
  const [tasksWidth, setTasksWidth] = useColumnWidth(TASKS_COLUMN);
  const [timelineWidth, setTimelineWidth] = useColumnWidth(TIMELINE_COLUMN);
  const [openEvent, setOpenEvent] = useState<ExternalEvent | null>(null);

  const board = useTaskBoard({ online, onSelectNode: onOpenNode, onRefresh: () => { void onRefresh(); }, onError: toastError });
  const dayMarks = useDayMarks(tasksOn);
  // With the journal off nothing of it shows, not even the dots of written days.
  const marks = useMemo(() => ({ ...dayMarks, written: dailyOn ? dayMarks.written : new Set<string>() }), [dayMarks, dailyOn]);
  const { open: openDayItem } = useDayItemActions(onOpenNode);


  const spanDays = range === "week" ? weekDays(date) : range === "3days" ? [date, addDays(date, 1), addDays(date, 2)] : [date];
  const external = useExternalEvents(spanDays[0]!, spanDays[spanDays.length - 1]!);

  const lists = useMemo(() => todayLists(board.items, date, today, board.justDone), [board.items, date, today, board.justDone]);
  const focus = useFocusOfDay(date, tasksOn);
  const totals = useMemo(() => focusTotals(date, focus?.sessions ?? [], focus?.running ?? null, nowMs), [date, focus, nowMs]);

  if (!tasksOn && !dailyOn) {
    return <section className="today-screen"><EmptyState size="panel" title={t("Today needs the journal or tasks to be on.")} /></section>;
  }

  const dayLine = `${dayIdLabel(date, "short")} ${weekdayText(date)}`;
  const header = (
    <header className="today-head">
      <div className="today-head-date">
        <Button variant="icon" size="sm" aria-label={t("Previous day")} onClick={() => pick(addDays(date, -1))}><ChevronLeft size={16} aria-hidden="true" /></Button>
        <h2 className={classNames("today-head-title", date === today && "is-today")}>{dayLine}</h2>
        <Button variant="icon" size="sm" aria-label={t("Next day")} onClick={() => pick(addDays(date, 1))}><ChevronRight size={16} aria-hidden="true" /></Button>
        {date === today ? <Chip tone="accent" className="today-head-word">{t("Today")}</Chip>
          : <Button variant="ghost" size="sm" onClick={() => pick(today)}>{t("Back to today")}</Button>}
      </div>
      {tasksOn && totals.total > 0 && (
        <span className="today-head-focus">{t(date === today ? "Focused today: {n} min" : "Focused that day: {n} min", { n: totals.total })}</span>
      )}
      <div className="today-head-switch">
        {!phone && tasksOn && dailyOn && !wide && range === "day" && (
          <Segmented label={t("Day timeline")} value={narrowPane}
            options={[{ value: "timeline", label: t("Timeline view") }, { value: "journal", label: t("Journal view") }]} onChange={setNarrowPane} />
        )}
        {!phone && tasksOn && dailyOn && wide && folded && range === "day" && (
          <Button size="sm" variant="ghost" onClick={() => setFolded(false)}><PanelLeftOpen size={14} aria-hidden="true" /> {t("Show the journal")}</Button>
        )}
        {!phone && (
          <Segmented label={t("How many days")} value={range} options={RANGES.map((id) => ({ value: id, label: t(RANGE_LABEL[id]) }))} onChange={(next) => { setRange(next); setAllOpen(false); }} />
        )}
      </div>
    </header>
  );

  const sheets = (
    <>
      {board.sheetTask && (
        <TaskSheet key={board.sheetTask.id} task={board.sheetTask} today={today} notes={board.notes} actions={board.actions} onClose={() => board.setSheetId(null)} />
      )}
      {openEvent && <ExternalEventSheet event={openEvent} onClose={() => setOpenEvent(null)} onOpenNode={onOpenNode} />}
    </>
  );

  if (phone) {
    return (
      <section className="today-screen is-phone" data-testid="today-screen">
        <PhoneToday date={date} today={today} onPick={pick} header={header} tasksOn={tasksOn} dailyOn={dailyOn} board={board} lists={lists}
          focusByTask={totals.byTask} focus={focus} nowMs={nowMs} marks={marks} external={external} onOpenExternal={setOpenEvent} onOpenNode={onOpenNode} />
        {sheets}
      </section>
    );
  }

  let body;
  if (range === "3days" || range === "week") {
    body = (
      <div className="today-board">
        <WeekBoard days={spanDays} today={today} selected={date} nowMs={nowMs} onPick={(day) => { pick(day); setRange("day"); }} onOpen={openDayItem}
          external={external} onOpenExternal={setOpenEvent} />
      </div>
    );
  } else if (range === "month") {
    body = (
      <div className="today-month">
        <DayStrip date={date} today={today} written={marks.written} planned={marks.planned} monthOpen onMonthOpenChange={() => {}}
          onPick={(day) => { pick(day); setRange("day"); }} />
      </div>
    );
  } else {
    // Which columns the width allows: the journal is the middle one only on a wide page, otherwise it shares the right one.
    const middle = dailyOn && !folded && wide;
    const journalAside = tasksOn && dailyOn && !wide && narrowPane === "journal";
    const layout = tasksOn && middle ? "three" : tasksOn ? "tasks-timeline" : "journal-timeline";
    body = (
      <div className={classNames("today-body", `is-${layout}`)}
        style={{ "--today-tasks-w": tasksWidth ? `${tasksWidth}px` : undefined, "--today-timeline-w": timelineWidth ? `${timelineWidth}px` : undefined } as CSSProperties}>
        {allOpen && tasksOn ? (
          <div className="today-cell today-cell--over"><AllTasksPanel today={today} board={board} onClose={() => setAllOpen(false)} /></div>
        ) : (
          <>
            {tasksOn && (
              <div className="today-cell today-cell--tasks">
                <TasksColumn date={date} today={today} board={board} lists={lists} focusByTask={totals.byTask} external={external}
                  onOpenExternal={setOpenEvent} onSeeAll={() => setAllOpen(true)} />
                {layout === "three" && <ColumnResizer column={TASKS_COLUMN} width={tasksWidth} onResize={setTasksWidth} label={t("Resize the tasks column")}
                  keepBeside={JOURNAL_MIN + (timelineWidth ?? TIMELINE_COLUMN.fallback)} />}
              </div>
            )}
            {(middle || !tasksOn) && dailyOn && !journalAside && (
              <div className="today-cell today-cell--journal">
                <JournalColumn date={date} today={today} onOpenNode={onOpenNode} onFold={tasksOn && wide ? () => setFolded(true) : undefined} />
              </div>
            )}
          </>
        )}
        <div className="today-cell today-cell--timeline">
          {layout !== "tasks-timeline" && (
            <ColumnResizer column={TIMELINE_COLUMN} width={timelineWidth} edge="start" onResize={setTimelineWidth} label={t("Resize the timeline")}
              keepBeside={JOURNAL_MIN + (tasksOn ? tasksWidth ?? TASKS_COLUMN.fallback : 0)} />
          )}
          {journalAside ? (
            <JournalColumn date={date} today={today} onOpenNode={onOpenNode} />
          ) : (
            <TimelineColumn date={date} today={today} tasksOn={tasksOn} twoLanes board={board} dayTasks={lists.planned} focus={focus} nowMs={nowMs}
              onOpenNode={onOpenNode} external={external} onOpenExternal={setOpenEvent} />
          )}
        </div>
      </div>
    );
  }

  return (
    <section className="today-screen" data-testid="today-screen" data-focus-stays>
      {header}
      {tasksOn && <FocusPageBar />}
      {body}
      {sheets}
    </section>
  );
}
