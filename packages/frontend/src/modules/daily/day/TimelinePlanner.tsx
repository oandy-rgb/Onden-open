// The timeline you can plan on. Planning a time is changing the first words of
// a task's line in its note (`- [ ] 14:00–14:30 title`), so this only picks a
// slot — a tap on an empty stretch, a held-and-drawn stretch on a phone, or a
// task dragged from 「還沒排時間」 onto an hour — and asks for what goes
// there: the tasks module's quick-add (a new task, said in words, with the
// slot's length and clock to adjust) or an existing task it lists. The
// writes are createQuickTask (new) and scheduleTaskAt (existing, with 復原).
// With the tasks module off it is the plain timeline.

import { Suspense, useState, type ComponentProps } from "react";
import { Popover, Sheet, usePopover } from "../../../components/ui";
import { MOBILE_QUERY, useMediaQuery } from "../../../hooks/useIsMobile";
import { useTaskRows } from "../../../lib/appStore";
import { useT } from "../../../lib/i18n";
import { QuickAddPanel } from "../../taskParts";
import DayTimeline from "./DayTimeline";
import { scheduleTaskAt } from "./dayTaskWrites";
import { type PlacedSlot } from "./timelineSlots";

type Props = ComponentProps<typeof DayTimeline> & { enabled: boolean };

export default function TimelinePlanner({ enabled, ...timeline }: Props) {
  const t = useT();
  const phone = useMediaQuery(MOBILE_QUERY);
  const tasks = useTaskRows();
  const [draft, setDraft] = useState<PlacedSlot | null>(null);
  const { date } = timeline;
  const close = () => setDraft(null);
  const popover = usePopover<HTMLDivElement>({ open: !!draft && !phone, onClose: close, placement: "bottom-start" });

  const dropTask = (id: string, slot: PlacedSlot) => {
    // A done task is not moved: its time is a record of when it was.
    if (tasks.find((task) => task.id === id)?.status === "done") return;
    return scheduleTaskAt(id, date, slot);
  };

  // The slot's content is the tasks module's quick-add (one way to say a task, here and in the ＋ menu);
  // it is given the slot and the one write that is the timeline's own: planning an existing task.
  const form = draft && (
    <div className="day-plan">
      <Suspense fallback={null}>
        <QuickAddPanel key={`${date}:${draft.startMinutes}`} slot={{ date, time: draft.time, until: draft.until }}
          onSchedule={(id, day, times) => scheduleTaskAt(id, day, times)} onDone={close} onClose={close} />
      </Suspense>
    </div>
  );

  return (
    <>
      <DayTimeline {...timeline} draft={draft} draftRef={popover.anchor}
        plan={enabled ? { onSlot: setDraft, onDropTask: dropTask, onMoveBlock: (id, slot) => scheduleTaskAt(id, date, slot) } : undefined} />
      {draft && !phone && <Popover popover={popover} label={t("Plan a time")} className="day-plan-popover">{form}</Popover>}
      {draft && phone && <Sheet label={t("Plan a time")} onClose={close}>{form}</Sheet>}
    </>
  );
}
