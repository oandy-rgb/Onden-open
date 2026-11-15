// A date field's value: just the day until it is pressed; then the quick picks
// (today, tomorrow, the same weekday next week) and the date box appear, and
// choosing any of them closes the row. "Today" is the workspace's (useToday).

import { useState } from "react";
import { addDays, isCalendarDay } from "@onden/markdown";
import { useToday } from "../../hooks/useToday";
import { useT } from "../../lib/i18n";
import { dayIdLabel } from "../../lib/timeLabels";
import { DatePicker, Pressable } from "../ui";

export function DateValueField({ label, value, onSave }: { label: string; value: string; onSave: (next: string) => void }) {
  const t = useT();
  const today = useToday();
  const [open, setOpen] = useState(false);
  const day = isCalendarDay(value) ? value : null;
  const choose = (next: string) => { setOpen(false); onSave(next); };
  const nextWeek = addDays(today, 7);
  return (
    <div className="attr-date">
      <Pressable className="attr-input attr-date-value" aria-label={label} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {day ? dayIdLabel(day) : <em className="attr-fill">{t("Add {field}…", { field: label })}</em>}
      </Pressable>
      {open && (
        <div className="attr-date-picks">
          <Pressable className="attr-choice" onClick={() => choose(today)}>{t("Today")}</Pressable>
          <Pressable className="attr-choice" onClick={() => choose(addDays(today, 1))}>{t("Tomorrow")}</Pressable>
          <Pressable className="attr-choice" onClick={() => choose(nextWeek)}>
            {t("Next {weekday}", { weekday: dayIdLabel(nextWeek, "weekdayShort") })}
          </Pressable>
          <DatePicker clearable className="attr-date-other" today={today} label={t("Pick a date…")} value={day} onChange={(date) => choose(date ?? "")} />
        </div>
      )}
    </div>
  );
}
