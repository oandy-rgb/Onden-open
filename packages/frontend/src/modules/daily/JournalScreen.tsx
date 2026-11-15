// The 日記 / Journal page (?view=daily): one day at a time (day/DayPage), one centred
// column on a phone and a desktop alike. The day's note is drawn in full, read-only;
// a tap on it opens the note to write in (onOpenNode), a day with no note offers
// 「寫點什麼…」 and starts it through dayNotes.openDay, the same single entry as
// today's note (lib/data/dayNotes.ts, D68). Under it: the way to the Tasks page, what
// happened and who mentions the day. The journal looks back (write and remember); the
// timeline, 1 天 / 3 天 / 週 and planning are on the Tasks page. The chosen day is kept
// while a note is open (pickedDay), so coming back lands on the same day.
// Listed only while the daily-notes module is imported; the notes are kept either way.

import { useTasksEnabled } from "../../hooks/useModuleFilter";
import { useToday } from "../../hooks/useToday";
import DayPage from "./day/DayPage";
import { useWriteDay } from "./useWriteDay";
import type { ModuleScreenProps } from "../types";
import { useDayMarks } from "./useDayMarks";
import { useShownDay } from "./useShownDay";
import { pickedDay, rememberPickedDay } from "./pickedDay";
import "./JournalScreen.css";

export default function JournalScreen({ onOpenNode, onOpenView }: ModuleScreenProps) {
  const today = useToday();
  const tasksOn = useTasksEnabled();
  const { byDate, written, planned } = useDayMarks(tasksOn);
  const [selected, pickDay] = useShownDay(today, pickedDay, rememberPickedDay);
  const { writeDay, starting } = useWriteDay((date) => byDate.get(date), onOpenNode);

  return (
    <div className="journal-screen">
      <DayPage date={selected} today={today} written={written} planned={planned} onPick={pickDay} onOpenNode={onOpenNode}
        onWrite={(date) => void writeDay(date)} onOpenView={onOpenView} tasksOn={tasksOn} starting={starting} />
    </div>
  );
}
