import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, addMonths, buildMonthGrid, stepMonth } from "@onden/markdown";
import { useT } from "../../lib/i18n";
import { isImeComposing } from "../../lib/keys";
import { dayIdLabel, monthLabel } from "../../lib/timeLabels";
import { classNames } from "../../lib/utils";
import { buttonClass } from "./Button";
import "./ui.css";

// One month of days to pick from — ‹ month ›, the weekday row and the day cells —
// drawn the same wherever a person picks a day off a month: DatePicker's panel,
// the journal's month (which replaces its week row). The days are @onden/markdown's
// buildMonthGrid; `today` is the workspace's day. Cells are 44px for a finger and
// share the width they get (a phone sheet, a 308px panel).
//
//   <MonthGrid value={date} today={today} onPick={go} marked={daysWithThings} />
//
// `marked` is a solid dot (something written), `planned` a hollow one (something
// scheduled). `hideNav` leaves the ‹ month › row to the owner, who then steps the
// month through `show` and hears keyboard month moves through `onMonthChange`.
// MonthDayCell is the one day cell: the journal's week row draws the same one.
//
// Keys: arrows move a day / a week, PageUp / PageDown a month, Home / End the
// week's ends, Enter or Space picks.

export type MonthGridProps = {
  /** The chosen day (filled), or null. */
  value: string | null;
  today: string;
  onPick: (date: string) => void;
  /** The day whose month shows and where the tab stop sits; a new value moves the grid there. Default: value, else today. */
  show?: string;
  /** Days with something written: a solid dot under the number. */
  marked?: ReadonlySet<string>;
  /** Days with something scheduled: a hollow dot under the number. */
  planned?: ReadonlySet<string>;
  /** The owner draws its own ‹ month › row. */
  hideNav?: boolean;
  /** The month on show changed from the keyboard (not from `show`). */
  onMonthChange?: (date: string) => void;
  /** Days that may be picked; the rest are drawn disabled. */
  allowed?: (date: string) => boolean;
  /** Focus the tab-stop day on mount (a phone sheet, where focusing a text box would open the keyboard). */
  autoFocus?: boolean;
  className?: string;
};

/** The weekday headings, Monday first (zh-TW: 一 二 三…). */
export const MONDAY_FIRST_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

type DayCellProps = {
  date: string;
  day: number;
  picked: boolean;
  today: boolean;
  out?: boolean;
  written?: boolean;
  planned?: boolean;
  tabIndex?: number;
  disabled?: boolean;
  onPick: (date: string) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>, date: string) => void;
};

/** One day: the number in a circle (filled when picked, ringed when today) and its dots. */
export function MonthDayCell({ date, day, picked, today, out, written, planned, tabIndex, disabled, onPick, onKeyDown }: DayCellProps) {
  const t = useT();
  const has = !!written || !!planned;
  return (
    <button type="button" role="gridcell" data-day={date}
      className={classNames("ui-month-day", out && "is-out", today && "is-today", picked && "is-picked", has && "has-things")}
      tabIndex={tabIndex} disabled={disabled}
      aria-selected={picked} aria-current={today ? "date" : undefined}
      aria-label={has ? t("{date}, has things on it", { date: dayIdLabel(date) }) : dayIdLabel(date)}
      onClick={() => onPick(date)} onKeyDown={onKeyDown && ((e) => onKeyDown(e, date))}>
      {day}
      {has && (
        <span className="ui-month-dots" aria-hidden="true">
          {written && <span className="ui-month-dot is-written" />}
          {planned && <span className="ui-month-dot is-planned" />}
        </span>
      )}
    </button>
  );
}

function monthOf(date: string): { year: number; month: number } {
  const [year, month] = date.split("-").map(Number);
  return { year: year!, month: month! - 1 };
}

export function MonthGrid({ value, today, onPick, show, marked, planned, hideNav, onMonthChange, allowed = () => true, autoFocus, className }: MonthGridProps) {
  const t = useT();
  const start = show ?? value ?? today;
  const [cursor, setCursor] = useState(() => monthOf(start));
  // The day the grid's one tab stop sits on (roving tabindex).
  const [focusDay, setFocusDay] = useState(start);
  const grid = buildMonthGrid(cursor.year, cursor.month, today);
  const gridRef = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  const showMonth = (date: string) => { setCursor(monthOf(date)); setFocusDay(date); };
  const step = (months: number) => {
    setCursor(stepMonth(cursor.year, cursor.month, months));
    setFocusDay(addMonths(focusDay, months));
  };

  // The owner moved `show` (a typed date): bring that month up.
  const shown = useRef(start);
  useEffect(() => {
    if (show === undefined || show === shown.current) return;
    shown.current = show;
    showMonth(show);
  }, [show]);

  useEffect(() => {
    if (autoFocus) gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount only
  }, []);

  // Arrow keys moved the focused day: bring focus to its cell once rendered.
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)?.focus();
  }, [focusDay, cursor]);

  const onCellKey = (event: ReactKeyboardEvent<HTMLButtonElement>, date: string) => {
    if (isImeComposing(event)) return;
    const weekday = (grid.findIndex((c) => c.key === date)) % 7;
    const target: string | null = {
      ArrowLeft: addDays(date, -1), ArrowRight: addDays(date, 1), ArrowUp: addDays(date, -7), ArrowDown: addDays(date, 7),
      Home: addDays(date, -weekday), End: addDays(date, 6 - weekday),
      PageUp: addMonths(date, -1), PageDown: addMonths(date, 1),
    }[event.key] ?? null;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    moved.current = true;
    showMonth(target);
    onMonthChange?.(target);
  };

  return (
    <div className={classNames("ui-month", className)}>
      {!hideNav && (
        <div className="ui-month-nav">
          <button type="button" className={buttonClass("icon", "sm")} onClick={() => step(-1)} aria-label={t("Previous month")}><ChevronLeft size={14} /></button>
          <span className="ui-month-title" aria-live="polite">{monthLabel(cursor.year, cursor.month)}</span>
          <button type="button" className={buttonClass("icon", "sm")} onClick={() => step(1)} aria-label={t("Next month")}><ChevronRight size={14} /></button>
        </div>
      )}
      <div ref={gridRef} className="ui-month-grid" role="grid" aria-label={monthLabel(cursor.year, cursor.month)}>
        <div role="row" className="ui-month-row">
          {MONDAY_FIRST_WEEKDAYS.map((w) => <span key={w} role="columnheader" className="ui-month-weekday">{t(w)}</span>)}
        </div>
        {Array.from({ length: grid.length / 7 }, (_, row) => (
          <div key={row} role="row" className="ui-month-row">
            {grid.slice(row * 7, row * 7 + 7).map((cell) => (
              <MonthDayCell key={cell.key} date={cell.key} day={cell.day} out={!cell.inMonth} today={cell.isToday}
                picked={cell.key === value} written={marked?.has(cell.key)} planned={planned?.has(cell.key)}
                tabIndex={cell.key === focusDay ? 0 : -1} disabled={!allowed(cell.key)} onPick={onPick} onKeyDown={onCellKey} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
