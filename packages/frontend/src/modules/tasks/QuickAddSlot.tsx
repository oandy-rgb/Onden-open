// Quick-add inside a timeline slot: the length and clock of the slot, and the existing tasks that can
// go into it. Rendered by QuickAddPanel when it is given a slot; the writes are the panel's.

import { Button } from "../../components/ui";
import { TimeField } from "./TimeField";
import { useT } from "../../lib/i18n";
import { classNames } from "../../lib/utils";
import { clockPlus, dayLabel, durationLabel } from "./quickAddTask";
import type { SlotTaskChoice } from "./slotTasks";

/** The lengths offered; each sets the end from the start. */
const LENGTHS = [15, 30, 60, 120] as const;

const minutesOf = (clock: string): number => { const [h, m] = clock.split(":").map(Number) as [number, number]; return h * 60 + m; };

export type SlotTimes = { time: string; until: string | null };

export function SlotTimeFields({ times, disabled, onChange }: { times: SlotTimes; disabled: boolean; onChange: (times: SlotTimes) => void }) {
  const t = useT();
  const length = times.until ? minutesOf(times.until) - minutesOf(times.time) : null;
  return (
    <fieldset className="quick-add-slot" disabled={disabled}>
      <legend className="quick-add-slot-legend">{t("How long")}</legend>
      <div className="quick-add-slot-lengths" role="group" aria-label={t("How long")}>
        {LENGTHS.map((minutes) => (
          <Button key={minutes} size="sm" aria-pressed={length === minutes} className={classNames("quick-add-slot-length", length === minutes && "is-selected")}
            onClick={() => onChange({ ...times, until: clockPlus(times.time, minutes) })}>{durationLabel(minutes)}</Button>
        ))}
      </div>
      <div className="quick-add-slot-clock">
        {/* The app's own 24-hour clock, as the line above and the task sheet read: the native time box shows 1:30 for 13:30 on some phones. */}
        <div className="quick-add-slot-part">{t("Starts at")}
          <TimeField hourLabel={t("Hour")} minuteLabel={t("Minute")} label={t("Starts at")} value={times.time} onChange={(time) => {
            if (!time) return;
            // moving the start keeps the length
            onChange({ time, until: length ? clockPlus(time, length) : times.until && times.until > time ? times.until : null });
          }} />
        </div>
        <div className="quick-add-slot-part">{t("Ends at")}
          <TimeField hourLabel={t("Hour")} minuteLabel={t("Minute")} label={t("Ends at")} value={times.until ?? ""}
            onChange={(until) => onChange({ ...times, until: until && until > times.time ? until : null })} />
        </div>
      </div>
    </fieldset>
  );
}

/** Existing tasks that can take the slot; choosing one plans it there. */
export function SlotTaskList({ choices, today, typed, busy, onPick }: {
  choices: SlotTaskChoice[];
  today: string;
  typed: boolean;
  busy: boolean;
  onPick: (choice: SlotTaskChoice) => void;
}) {
  const t = useT();
  if (choices.length === 0) return null;
  return (
    <section className="quick-add-slot-tasks" aria-label={typed ? t("Tasks with this name") : t("Not scheduled yet")}>
      <h4 className="quick-add-slot-tasks-title">{typed ? t("Put an existing task here") : t("Not scheduled yet")}</h4>
      <ul>
        {choices.map(({ task, bucket }) => (
          <li key={task.id}>
            <Button variant="ghost" className="quick-add-slot-task" disabled={busy} onClick={() => onPick({ task, bucket })}>
              <span className="quick-add-slot-task-title">{task.title}</span>
              <span className="quick-add-slot-task-when">{whenLabel(task.when_date ?? task.due_date ?? null, bucket, today, t)}</span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function whenLabel(date: string | null, bucket: SlotTaskChoice["bucket"], today: string, t: ReturnType<typeof useT>): string {
  if (bucket === "later") return t("Someday");
  if (bucket === "unscheduled" || !date) return t("Anytime");
  if (bucket === "overdue") return t("Overdue · {day}", { day: dayLabel(date, today) });
  return dayLabel(date, today);
}

