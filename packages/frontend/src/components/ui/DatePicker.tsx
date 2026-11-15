import { useEffect, useId, useState } from "react";
import { CalendarDays } from "lucide-react";
import { addDays, weekdayOf } from "@onden/markdown";
import { useIsMobile } from "../../hooks/useIsMobile";
import { getLocale, useT } from "../../lib/i18n";
import { isEnterKey } from "../../lib/keys";
import { dayIdLabel } from "../../lib/timeLabels";
import { classNames } from "../../lib/utils";
import { Button, buttonClass } from "./Button";
import { FieldError } from "./FieldError";
import { MonthGrid } from "./MonthGrid";
import { Popover } from "./Popover";
import { usePopover } from "./usePopover";
import "./ui.css";

// The one place a person picks a calendar day (YYYY-MM-DD). A text box on top
// reads what they type ("明天", "下週三", "11/3") with the same reader as quick
// add (@onden/markdown parseDateText); under it the month (ui/MonthGrid, the
// same one the diary shows) and the quick picks Today / Tomorrow /
// Next week / Clear. `today` is the workspace's day, never the device's.
//
//   <DatePicker value={task.whenDate} onChange={(d) => save(d)} today={today} label={t("Which day")} />
//   <DatePicker inline … />   // the panel itself, for a surface that is already a sheet
//
// Closed, it is one button showing the chosen day; open, it floats at the
// button on a desk and slides up as a bottom sheet on a phone (Popover `sheet`).
// Keys: arrows move a day / a week, PageUp / PageDown a month, Home / End the
// week's ends, Enter or Space picks, Esc closes.

// The typed-date reader is the quick-add grammar (several KiB of word lists); the picker opens without it
// and reads typed words from the moment it has loaded (a few ms, once per page). Kept out of the first
// screen's JavaScript: only a person who types a date needs it.
type DateReader = typeof import("./dateText").parseDateText;
let dateReader: DateReader | null = null;
const loadDateReader = (): Promise<void> => (dateReader ? Promise.resolve() : import("./dateText").then((m) => { dateReader = m.parseDateText; }));

export type DatePickerProps = {
  /** The chosen day, or null for none. */
  value: string | null;
  /** The person chose a day, or cleared it (null; only when `clearable`). */
  onChange: (date: string | null) => void;
  /** The workspace's day (lib/localDate todayId, hooks/useToday). */
  today: string;
  /** Accessible name of the button and the panel. */
  label: string;
  /** The earliest day that can be chosen. */
  min?: string;
  clearable?: boolean;
  /** Render the panel in place instead of behind a button. */
  inline?: boolean;
  className?: string;
};

export function DatePicker(props: DatePickerProps) {
  const t = useT();
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const pop = usePopover<HTMLButtonElement>({ open, onClose: () => setOpen(false), placement: "bottom-start" });
  if (props.inline) return <DatePanel {...props} />;
  const choose = (date: string | null) => { props.onChange(date); setOpen(false); };
  return (
    <>
      <button ref={pop.anchor} type="button" className={buttonClass("secondary", "sm", classNames("ui-datepicker-trigger", props.className))}
        aria-haspopup="dialog" aria-expanded={open} aria-label={props.label} onClick={() => { void loadDateReader(); setOpen((o) => !o); }}>
        <CalendarDays size={14} aria-hidden="true" />
        <span>{props.value ? dayIdLabel(props.value) : t("Pick a date…")}</span>
      </button>
      {open && (
        <Popover popover={pop} label={props.label} className="ui-datepicker-pop" sheet={mobile}>
          <DatePanel {...props} onChange={choose} />
        </Popover>
      )}
    </>
  );
}

function DatePanel({ value, onChange, today, label, min, clearable, className }: DatePickerProps) {
  const t = useT();
  const mobile = useIsMobile();
  const hintId = useId();
  // The day the month grid shows; typing a readable date moves it there.
  const [shown, setShown] = useState(value ?? today);
  const [draft, setDraft] = useState("");
  const [unreadable, setUnreadable] = useState(false);
  const [, readerLoaded] = useState(dateReader !== null);
  useEffect(() => {
    let live = true;
    void loadDateReader().then(() => { if (live) readerLoaded(true); });
    return () => { live = false; };
  }, []);

  const allowed = (date: string) => min === undefined || date >= min;
  const read = (text: string): string | null => {
    const found = dateReader?.(text, { today, locale: getLocale() })?.date ?? null;
    return found !== null && allowed(found) ? found : null;
  };
  const typed = draft.trim() ? read(draft) : null;

  const pick = (date: string) => { if (allowed(date)) onChange(date); };

  const submitDraft = () => {
    if (!draft.trim()) return;
    if (typed) { setUnreadable(false); pick(typed); } else setUnreadable(true);
  };

  // next Monday (what "next week" reads as), counted here so the quick picks need no reader
  const nextWeek = addDays(today, (8 - weekdayOf(today)) % 7 || 7);
  const quick: Array<[string, string]> = [[t("Today"), today], [t("Tomorrow"), addDays(today, 1)], [t("Next week"), nextWeek]];

  return (
    <div className={classNames("ui-datepicker", className)} role="group" aria-label={label}>
      <input type="text" className="ui-datepicker-input" value={draft} autoFocus={!mobile}
        aria-label={t("Type a date")} aria-invalid={unreadable || undefined} aria-describedby={hintId}
        placeholder={t("Tomorrow, next Wed, 11/3…")}
        onChange={(e) => { setDraft(e.target.value); setUnreadable(false); const found = e.target.value.trim() ? read(e.target.value) : null; if (found) setShown(found); }}
        onKeyDown={(e) => { if (isEnterKey(e)) { e.preventDefault(); submitDraft(); } }} />
      <div id={hintId} className="ui-datepicker-hint">
        {unreadable ? <FieldError>{t("Can't read that as a day")}</FieldError> : <span role="status">{typed ? t("→ {date}", { date: dayIdLabel(typed) }) : ""}</span>}
      </div>
      <div className="ui-datepicker-quick">
        {quick.map(([text, date]) => (
          <Button key={date} variant="secondary" size="sm" disabled={!allowed(date)} onClick={() => pick(date)}>{text}</Button>
        ))}
        {clearable && value !== null && <Button variant="ghost" size="sm" onClick={() => onChange(null)}>{t("Clear")}</Button>}
      </div>
      {/* A phone must not open its keyboard over the sheet: focus goes to the grid instead. */}
      <MonthGrid value={value} today={today} onPick={pick} show={shown} allowed={allowed} autoFocus={mobile} />
    </div>
  );
}
