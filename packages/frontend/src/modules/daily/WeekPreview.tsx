import { useToday } from "../../hooks/useToday";
import { addDays } from "@onden/markdown";
import { dateLabel } from "../../lib/timeLabels";

// Settings › 功能 › 日記: a week strip like the journal's calendar, today
// marked. Shows what the feature is; it holds nothing to press.
export default function WeekPreview() {
  const today = useToday();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 3));
  return (
    <div className="feature-preview feature-preview--week" aria-hidden="true">
      {days.map((day) => (
        <span key={day} className={`feature-preview-day${day === today ? " is-today" : ""}`}>
          <small>{/* The day's own calendar weekday: noon UTC read in UTC cannot shift to a neighbouring day. */}
          {dateLabel(`${day}T12:00:00Z`, "weekdayShort", "UTC")}</small>
          <b>{Number(day.slice(8))}</b>
        </span>
      ))}
    </div>
  );
}
