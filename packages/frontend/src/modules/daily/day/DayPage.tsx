// 日記 · 單天頁: one day at a time, the way a page of a notebook is read. Top to
// bottom: the date (a button that opens the month; beside it the small 「今天」, or
// 「回到今天」 on another day), the week row or the month (DayStrip), 「去年今天」 when
// there is something to show, the day's note drawn in full (read-only: a tap on the
// words opens the note to write in it; links in it go where they point) or, with
// none, a 「寫點什麼…」 row that starts it through dayNotes.openDay. Under the words:
// one line to the Tasks page, what happened (captures, tasks finished, notes made or
// saved) and who mentions the day. The journal looks back; the timeline and planning
// are the Tasks page's.

import { useDismiss } from "../../../hooks/useEscapeKey";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "../../../components/ui";
import { useT } from "../../../lib/i18n";
import { dayIdLabel } from "../../../lib/timeLabels";
import { classNames } from "../../../lib/utils";
import DayNoteBody from "./DayNoteBody";
import { useDayNote } from "./useDayNote";
import DayStrip from "./DayStrip";
import LastYearCard from "./LastYearCard";
import DayBelow from "./DaySections";
import "./day.css";

type Props = {
  date: string;
  today: string;
  /** Days with a written note (the solid dot). */
  written: ReadonlySet<string>;
  /** Days with a task scheduled (the hollow dot). */
  planned: ReadonlySet<string>;
  onPick: (date: string) => void;
  onOpenNode: (id: string) => void;
  /** Open that day's note, starting it first when there is none. */
  onWrite: (date: string) => void;
  onOpenView?: (id: string) => void;
  tasksOn: boolean;
  starting: boolean;
};

export default function DayPage({ date, today, written: writtenDays, planned, onPick, onOpenNode, onWrite, onOpenView, tasksOn, starting }: Props) {
  const t = useT();
  const { nodes, day, captures } = useDayNote(date);
  const [monthOpen, setMonthOpen] = useState(false);
  // Back and Esc fold the month back to the week.
  useDismiss(() => setMonthOpen(false), monthOpen);

  return (
    <section className="day-page" aria-label={t("This day's page")} data-date={date}>
      <header className="day-page-head">
        <h2 className={classNames("day-page-title", date === today && "is-today")}>
          <Button variant="ghost" className="day-page-datebtn" aria-expanded={monthOpen} title={t("Show the month")} onClick={() => setMonthOpen((v) => !v)}>
            {dayIdLabel(date, "long")}<ChevronDown size={16} aria-hidden="true" />
          </Button>
        </h2>
        {date === today
          ? <span className="day-page-word">{t("Today")}</span>
          : <Button variant="ghost" size="sm" className="day-page-back" onClick={() => onPick(today)}>{t("Back to today")}</Button>}
      </header>

      <DayStrip date={date} today={today} written={writtenDays} planned={planned} onPick={onPick} monthOpen={monthOpen} onMonthOpenChange={setMonthOpen} />

      <LastYearCard date={date} onOpenNode={onOpenNode} />

      <div className="day-page-note">
        <DayNoteBody day={day} nodes={nodes} onOpenNode={onOpenNode} empty={(
          <Button variant="ghost" className="journal-placeholder" disabled={starting}
            onClick={() => (day ? onOpenNode(day.id) : onWrite(date))}>{t("Write something…")}</Button>
        )} />
      </div>

      <DayBelow date={date} today={today} day={day} captures={captures} nodes={nodes} tasksOn={tasksOn}
        onOpenNode={onOpenNode} onOpenView={onOpenView} />
    </section>
  );
}
