// Daily notes module (日記, frontend) — the module library's switch for day
// notes: today's note (the Today entries, ⌘⇧D), quick capture's and the
// agenda's fallback note, the home mood picker and streak, the "Daily note"
// template and the day lens. Those surfaces are core code that ask
// `dailyNotesEnabled()` / `useDailyNotesEnabled()` (the day-notes shell feature),
// and lib/data/dayNotes.ts openToday refuses to start a day note while the
// module is off. Turning it off keeps every day note as an ordinary
// note. On by default like every built-in function; the journal shows in the
// navigation once a day note exists.

import { CalendarDays, NotebookPen } from "lucide-react";
import { dayNoteDate } from "@onden/markdown";
import type { FrontendModule } from "../types";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { captureDayItems } from "./dayItems";
import { isNote } from "@onden/markdown/contract";

const DayNoteParentSetting = lazyWithReload(() => import("./DayNoteParentSetting"));
const WeekPreview = lazyWithReload(() => import("./WeekPreview"));
/** The timeline with 規劃今天 / 收工: the Tasks page's 今天 plan, and this module's right column. */
export const DayPlanner = lazyWithReload(() => import("./day/DayPane"));

export const dailyModule: FrontendModule = {
  id: "daily",
  shellFeature: "day-notes",
  noteFunctionRows: () => import("./noteFunctionRows"),
  dayItems: captureDayItems,
  // The 日記 page: today's note, then earlier days, and a month calendar.
  // Listed among the module destinations (hooks/shellNavigation): the
  // desktop bar (folding into 更多 ▾) and the phone's 更多 › 功能.
  screen: { label: "Journal", Icon: NotebookPen, Component: lazyWithReload(() => import("./JournalScreen")) },
  library: {
    navGroup: { id: "time", order: 1 },
    // A day note exists.
    inUse: ({ nodes }) => nodes.some((n) => isNote(n) && dayNoteDate(n) !== null),
    title: "Daily notes",
    description: "A note for each day, on the Journal page with a month calendar. Quick captures and agenda tasks with no other place land on it.",
    Icon: CalendarDays,
    group: { id: "time", order: 1 },
    blurb: "One note a day, with a timeline",
    manifest: {
      adds: [
        { kind: "page", text: "The Journal page: a note for each day, with a month calendar." },
        { kind: "command", text: "Quick captures and agenda tasks with no other place land on the day's note." },
      ],
      notes: "Makes one note per day, when you open or write to that day.",
      network: null,
    },
  },
  SettingsPreview: WeekPreview,
  // On the module's page: where new day notes go. (When a day starts is Settings › Date and time.)
  settings: [{
    id: "daily.parent_note",
    tab: "modules",
    label: "Where new day notes go",
    keywords: ["daily", "journal", "parent", "日記", "上層"],
    type: "custom",
    component: DayNoteParentSetting,
  }],
};
