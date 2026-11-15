import { Select } from "../../components/ui";
import "./TimeField.css";

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, "0"));

export type TimeFieldProps = {
  /** "HH:MM" on a 24-hour clock, or "" for no time. */
  value: string;
  /** "HH:MM" once both parts are chosen; "" when the person clears the hour. */
  onChange: (value: string) => void;
  /** What the field is for ("Starts at"); the two parts are named by the words below. */
  label: string;
  hourLabel: string;
  minuteLabel: string;
  className?: string;
};

/** A time of day on the 24-hour clock (the task sheet, the slot being planned), the same in every browser and locale.
 *  The native time box shows 12 hours with 上午/下午 on some devices while the
 *  timeline and every label in the app read 24 hours. Choosing an hour first
 *  fills in :00, so one choice already gives a valid time. */
export function TimeField({ value, onChange, label, hourLabel, minuteLabel, className }: TimeFieldProps) {
  const [hour = "", minute = ""] = /^\d{2}:\d{2}$/.test(value) ? value.split(":") : [];
  return (
    <span className="tk-time-field" role="group" aria-label={label}>
      <Select className={className} aria-label={hourLabel} value={hour}
        onChange={(e) => onChange(e.target.value ? `${e.target.value}:${minute || "00"}` : "")}>
        <option value="">--</option>
        {HOURS.map((h) => <option key={h} value={h}>{h}</option>)}
      </Select>
      <span aria-hidden>:</span>
      <Select className={className} aria-label={minuteLabel} value={minute} disabled={!hour}
        onChange={(e) => onChange(`${hour}:${e.target.value}`)}>
        <option value="" hidden>--</option>
        {MINUTES.map((m) => <option key={m} value={m}>{m}</option>)}
      </Select>
    </span>
  );
}
