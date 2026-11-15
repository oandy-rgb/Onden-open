// The task page: four tabs (今天 / 接下來 / 隨時 / 某天), one shared row, one
// settings sheet. The tabs read the local task list, so a change moves the
// task to its tab at once, online or not; the writer queues it for the server.
// The sorting rules are lib/tasks/taskModel (pure, tested); this file wires
// them to the store, the writer and the sheet.
// 今天 is the day timeline with, above it, 「可以排進今天的」 (late and due-soon tasks, each row
// with its own 排到今天／某天) and the tasks of today that have no time yet. 接下來 is the
// agenda: one section per day (UpcomingAgenda).

import { Suspense, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useToday } from "../../hooks/useToday";
import { useTasksEnabled } from "../../hooks/useShellFeature";
import { Pressable, Tab, TabList, TabPanel } from "../../components/ui";
import { SpaceFilterButton, SpaceFilterNote, usePhoneSpaceFilter } from "../../components/SpaceFilter";
import { useSpaces } from "../../lib/spaces";
import { classNames } from "../../lib/utils";
import { TASK_TABS, bucketTasks, isOpen, tabCounts, todayCandidates, type TaskItem, type TaskTab } from "../../lib/tasks";
import type { NotifyPermission } from "../../hooks/useDueSoonNotifications";
import { DayPlanner } from "../index";
import ReminderToggle, { reminderAction } from "./ReminderToggle";
import { useIsMobile } from "../../hooks/useIsMobile";
import { usePhoneTopbarActions } from "../../lib/phoneTopbarActions";
import TaskRow from "./TaskRow";
import { TAB_EMPTY, TAB_LABEL, TaskSection, agendaTasksOf } from "./taskTabs";
import UnscheduledStrip from "./UnscheduledStrip";
import UpcomingAgenda from "./UpcomingAgenda";
import { requestFocus } from "../../lib/focus";
import TaskSheet from "./TaskSheet";
import { useTaskBoard } from "./useTaskBoard";
import { openQuickAddTask } from "./openQuickAddTask";
import "../../components/TagsPanel.css";
import "./TasksMode.css";

type Props = {
  online: boolean;
  onSelectNode: (id: string) => void;
  onRefresh: () => void;
  /** Surface a write failure (toast) — wired to BuilderApp's addToast. */
  onError: (message: string) => void;
  /** Browser permission for due-soon OS reminders. */
  reminderPermission: NotifyPermission;
  /** Ask the browser to allow reminders. No-op if already decided. */
  onEnableReminders: () => void;
};

const ANYTIME_SHOWN = 5;
const TAB_HINT: Partial<Record<TaskTab, string>> = {
  upcoming: "Planned for a later day; they move to Today by themselves on that day",
  anytime: "Can be done now, no day planned",
  someday: "Not urgent, and not yet decided whether to do",
};
export default function TasksMode({ online, onSelectNode, onRefresh, onError, reminderPermission, onEnableReminders }: Props) {
  const t = useT();
  const today = useToday();
  const tasksOn = useTasksEnabled();
  const [tab, setTab] = useState<TaskTab>("today");
  // The board (useTaskBoard) owns the list and what a row's buttons do.
  const { spaces: allSpaces } = useSpaces(online);
  const spaces = useMemo(() => allSpaces.filter((sp) => sp.kind !== "system"), [allSpaces]);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const filterSpace = spaces.length >= 2 ? spaceId : null;
  const { items, justDone, clearJustDone, sheetTask, setSheetId, notes, actions, toggle, planToday, parkSomeday } =
    useTaskBoard({ online, onSelectNode, onRefresh, onError, spaceId: filterSpace });
  const buckets = useMemo(() => bucketTasks(items, today, justDone), [items, today, justDone]);
  const counts = tabCounts(buckets);

  const selectTab = (next: TaskTab) => { setTab(next); clearJustDone(); };
  const rowFor = (task: TaskItem, candidate = false) => (
    <TaskRow
      key={task.id}
      task={task}
      today={today}
      showWhen={tab !== "upcoming" && task.whenDate !== today}
      justDone={justDone.has(task.id)}
      onToggle={toggle}
      onOpen={(row) => setSheetId(row.id)}
      onFocus={(row) => requestFocus(row.id)}
      planDrag={tab === "today"}
      onPlanToday={candidate ? (row) => { void planToday(row); } : undefined}
      onSomeday={candidate ? parkSomeday : undefined}
    />
  );

  const todayPage = buckets.today;
  // On the timeline once: a task of today with a time. What could go on today (late, or due by
  // tomorrow) is the card's; the rest of 今天 with no time is the strip's one-line list.
  const candidates = useMemo(() => todayCandidates(items, today, justDone), [items, today, justDone]);
  const unscheduled = useMemo(() => {
    const card = new Set(candidates.map((task) => task.id));
    return [...todayPage.today, ...todayPage.evening, ...todayPage.dueSoon].filter((task) => !card.has(task.id) && !(task.whenDate === today && task.time));
  }, [todayPage, candidates, today]);
  // 接下來 lists today's own tasks too (the agenda starts on today), so it is empty only when it has none.
  const agendaTasks = useMemo(() => agendaTasksOf(buckets, today), [buckets, today]);
  // The tab's number is what its agenda lists (which starts on today), not the later-days count.
  const shown: Record<TaskTab, number> = { ...counts, upcoming: agendaTasks.filter((task) => isOpen(task.status)).length };
  const empty = shown[tab] === 0;
  // Today with nothing in it: what can be done any time is the next thing to offer (no new rule, just shown).
  const anytimeOpen = buckets.anytime.filter((task) => isOpen(task.status));
  const emptyToday = empty && tab === "today" && candidates.length === 0 && unscheduled.length === 0 ? {
    text: t(TAB_EMPTY.today),
    anytime: anytimeOpen.filter((_, index) => index < ANYTIME_SHOWN).map((task) => rowFor(task, true)),
    anytimeCount: anytimeOpen.length,
    onSeeAnytime: () => selectTab("anytime"),
    onAdd: () => openQuickAddTask(),
  } : undefined;

  // A phone has no title row: the bar above names the page and holds its buttons.
  const phone = useIsMobile();
  const bell = reminderAction(reminderPermission, onEnableReminders, t);
  const spaceFilter = { spaces, value: filterSpace, onChange: setSpaceId, menuLabel: t("Show tasks from one space") };
  const phoneSpace = usePhoneSpaceFilter(spaceFilter);
  usePhoneTopbarActions(phone ? [
    ...(phoneSpace.action ? [phoneSpace.action] : []),
    ...(bell ? [bell] : []),
    { id: "add-task", label: t("Add task"), Icon: Plus, onSelect: () => openQuickAddTask() },
  ] : []);

  return (
    <section className="tasks-mode tasks-page">
      {/* A phone has no header row: the space button is in the top bar, and the note below shows only while narrowed.
          A computer keeps it in the title row it already shares (no extra height). */}
      {phone ? (
        <>{phoneSpace.menu}<SpaceFilterNote {...spaceFilter} /></>
      ) : (
        <header className="tasks-mode-header">
          <h2 className="tasks-mode-title">{t("Tasks")}</h2>
          {spaces.length >= 2 && <SpaceFilterButton {...spaceFilter} />}
          <ReminderToggle permission={reminderPermission} onEnable={onEnableReminders} />
          <Pressable type="button" className="tasks-add" onClick={() => openQuickAddTask()} aria-label={t("Add task")} title={t("Add task")}>
            <Plus size={22} />
          </Pressable>
        </header>
      )}

      <TabList label={t("Tasks")} className="tasks-tabs">
        {TASK_TABS.map((id) => (
          <Tab
            key={id}
            id={`tasks-tab-${id}`}
            selected={tab === id}
            controls="tasks-panel"
            className={classNames("tasks-tab", tab === id && "tasks-tab--on")}
            onClick={() => selectTab(id)}
          >
            {t(TAB_LABEL[id])}<span className="tasks-tab-count">{shown[id]}</span>
          </Tab>
        ))}
      </TabList>

      <TabPanel className="tasks-mode-body" id="tasks-panel" labelledBy={`tasks-tab-${tab}`}>
        {TAB_HINT[tab] && <p className="tasks-tab-hint">{t(TAB_HINT[tab]!)}</p>}
        {empty && !(tab === "today" && tasksOn) && <p className="tags-mode-empty">{t(TAB_EMPTY[tab])}</p>}

        {tab === "today" && (tasksOn ? (
          // One timeline; what could go on today and what has no slot on it wait above it.
          <Suspense fallback={null}>
            <DayPlanner onOpenNode={onSelectNode} unscheduled={<UnscheduledStrip candidates={candidates.map((task) => rowFor(task, true))} rest={unscheduled.map((task) => rowFor(task))} empty={emptyToday} />} />
          </Suspense>
        ) : (
          <>
            {todayPage.today.length > 0 && <TaskSection title={t("Today")}><ul className="tasks-list">{todayPage.today.map((task) => rowFor(task))}</ul></TaskSection>}
            {todayPage.evening.length > 0 && <TaskSection title={t("Tonight")}><ul className="tasks-list">{todayPage.evening.map((task) => rowFor(task))}</ul></TaskSection>}
            {todayPage.dueSoon.length > 0 && <TaskSection title={t("Due soon")} tone="soon"><ul className="tasks-list">{todayPage.dueSoon.map((task) => rowFor(task))}</ul></TaskSection>}
          </>
        ))}
        {tab === "upcoming" && <UpcomingAgenda tasks={agendaTasks} today={today} renderRow={(task) => rowFor(task)} />}
        {tab === "anytime" && buckets.anytime.length > 0 && <ul className="tasks-list">{buckets.anytime.map((task) => rowFor(task))}</ul>}
        {tab === "someday" && buckets.someday.length > 0 && <ul className="tasks-list">{buckets.someday.map((task) => rowFor(task))}</ul>}
      </TabPanel>

      {sheetTask && (
        <TaskSheet key={sheetTask.id} task={sheetTask} today={today} notes={notes} actions={actions} onClose={() => setSheetId(null)} />
      )}
    </section>
  );
}
