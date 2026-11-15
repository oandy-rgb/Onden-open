// M3.3 — Calendar layout renderer.
//
// Places query rows that carry a date field onto a Monday-first month grid.
// The date field is auto-picked from the view's visible_fields (a field whose
// name hints at a date), falling back to the built-in updated_at so the layout
// always renders something useful. Prev/next month navigation is local state;
// the underlying query is the same exec result shared by every layout.
// The month shown is remembered per view on this device (V3), and a day with
// more rows than fit opens in place ("+N more").

import { Pressable } from "../../components/ui";
import { buildMonthGrid, stepMonth } from "@onden/markdown";
import { monthId } from "../../lib/localDate";
import { useToday } from "../../hooks/useToday";
import { useMemo, useState } from "react";
import { getPrefJson, PREFS, setPrefJson } from "../../lib/prefs";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import type { ExecResponse } from "../../lib/viewExec";
import {
  calendarDateField,
  bucketRowsByDay,
  monthLabel,
  WEEKDAY_LABELS,
} from "../../components/viewLayoutKit";
import { useT } from "../../lib/i18n";
import EmptyState from "../../components/EmptyState";

type Props = {
  exec: ExecResponse;
  onSelectNode?: (id: string) => void;
  /** The saved view: its month is remembered under this id. */
  viewId?: string;
};

function monthsByView(): Record<string, string> {
  const stored = getPrefJson(PREFS.calendarMonths);
  return stored && typeof stored === "object" ? stored as Record<string, string> : {};
}

const MAX_CHIPS_PER_DAY = 3;

export default function CalendarLayout({ exec, onSelectNode, viewId }: Props) {
  const t = useT();
  const today = useToday();
  // Open on the workspace's current month (lib/localDate), not the browser's.
  const [cursor, setCursor] = useState(() => {
    const remembered = viewId ? monthsByView()[viewId] : undefined;
    const [year, month] = (remembered && /^\d{4}-\d{2}$/.test(remembered) ? remembered : today).split("-").map(Number);
    return { year: year!, month: month! - 1 };
  });
  // Only a month someone moved to is remembered; 「Today」 forgets it, so an
  // untouched calendar keeps following the current month.
  const remember = (month: string | null) => {
    if (!viewId) return;
    const months = monthsByView();
    if (month) months[viewId] = month;
    else delete months[viewId];
    setPrefJson(PREFS.calendarMonths, months);
  };
  // The day opened past its first chips ("+N more"), by YYYY-MM-DD.
  const [openDay, setOpenDay] = useState<string | null>(null);

  const dateField = calendarDateField(exec.view.layout_config?.date_field);
  // The built-in dates are named as the field picker names them, never by their stored id.
  const dateFieldName = dateField === "created_at" ? t("Created date") : dateField === "updated_at" ? t("Last edited date") : dateField;
  const buckets = useMemo(() => bucketRowsByDay(exec.rows, dateField), [exec.rows, dateField]);
  const grid = useMemo(
    () => buildMonthGrid(cursor.year, cursor.month, today),
    [cursor.year, cursor.month, today],
  );

  const placedCount = useMemo(
    () => Array.from(buckets.values()).reduce((n, list) => n + list.length, 0),
    [buckets],
  );

  const step = (delta: number) => {
    const next = stepMonth(cursor.year, cursor.month, delta);
    setCursor(next);
    remember(monthId(next.year, next.month));
  };
  const goToday = () => {
    const [year, month] = today.split("-").map(Number);
    setCursor({ year: year!, month: month! - 1 });
    remember(null);
  };

  if (exec.rows.length === 0) {
    return <EmptyState size="inline" title={t("No rows match the current filters.")} />;
  }

  return (
    <div className="cv-cal">
      <div className="cv-cal-nav">
        <Pressable className="cv-cal-navbtn" onClick={() => step(-1)} title={t("Previous month")} aria-label={t("Previous month")}>
          <ChevronLeft size={14} />
        </Pressable>
        <span className="cv-cal-title">{monthLabel(cursor.year, cursor.month)}</span>
        <Pressable className="cv-cal-navbtn" onClick={() => step(1)} title={t("Next month")} aria-label={t("Next month")}>
          <ChevronRight size={14} />
        </Pressable>
        <Pressable className="cv-cal-today" onClick={goToday} title={t("Jump to current month")}>
          {t("Today")}
        </Pressable>
        <span className="cv-cal-field" title={t("Rows are placed by this date field")}>
          <CalendarDays size={11} className="cv-icon-middle" /> {dateFieldName}
        </span>
      </div>

      <div className="cv-cal-grid" role="grid">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} className="cv-cal-weekday" role="columnheader">{t(w)}</div>
        ))}
        {grid.map((cell) => {
          const rows = buckets.get(cell.key) ?? [];
          const open = openDay === cell.key;
          const shown = open ? rows : rows.slice(0, MAX_CHIPS_PER_DAY);
          const extra = rows.length - MAX_CHIPS_PER_DAY;
          return (
            <div
              key={cell.key}
              role="gridcell"
              className={
                "cv-cal-cell" +
                (cell.inMonth ? "" : " cv-cal-cell--out") +
                (cell.isToday ? " cv-cal-cell--today" : "")
              }
            >
              <span className="cv-cal-daynum">{cell.day}</span>
              <div className="cv-cal-chips">
                {shown.map((row) => (
                  <Pressable
                    key={row.id}
                    className="cv-cal-chip"
                    onClick={() => onSelectNode?.(row.id)}
                    disabled={!onSelectNode}
                    title={row.title || t("(untitled)")}
                  >
                    {row.title || t("(untitled)")}
                  </Pressable>
                ))}
                {extra > 0 && (
                  <Pressable type="button" className="cv-cal-more" aria-expanded={open}
                    onClick={() => setOpenDay(open ? null : cell.key)}>
                    {open ? t("Show less") : t("+{n} more", { n: extra })}
                  </Pressable>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {placedCount < exec.rows.length && (
        <p className="cv-cal-note">
          {t("{n} of {total} rows have no “{field}” date and aren’t shown on the grid.", { n: exec.rows.length - placedCount, total: exec.rows.length, field: dateFieldName })}
        </p>
      )}
    </div>
  );
}
