// 「全部的事」: the rest of the Tasks page, opened over the 今天 page's left (and journal) column while the
// timeline stays. It has the Tasks page's own lists — 接下來 (the agenda), 隨時 and 某天 — drawn with its
// rows (TaskRow) and agenda (UpcomingAgenda). 「‹ 回到今天的清單」 or Esc closes it.

import { useMemo, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { Button, Tab, TabList, TabPanel } from "../../../components/ui";
import EmptyState from "../../../components/EmptyState";
import { useDismiss } from "../../../hooks/useEscapeKey";
import { useT } from "../../../lib/i18n";
import { requestFocus } from "../../../lib/focus";
import { bucketTasks, isOpen, type TaskItem } from "../../../lib/tasks";
import { classNames } from "../../../lib/utils";
import { TAB_EMPTY, TAB_LABEL, TaskRow, UpcomingAgenda, agendaTasksOf, type TaskBoard } from "../../taskParts";

type TabId = "upcoming" | "anytime" | "someday";
const TABS: readonly TabId[] = ["upcoming", "anytime", "someday"];

type Props = { today: string; board: TaskBoard; onClose: () => void };

export default function AllTasksPanel({ today, board, onClose }: Props) {
  const t = useT();
  const [tab, setTab] = useState<TabId>("upcoming");
  // Esc and Back close the panel; the task sheet over it (a dialog) closes first.
  useDismiss(() => { onClose(); }, !board.sheetTask);
  const buckets = useMemo(() => bucketTasks(board.items, today, board.justDone), [board.items, today, board.justDone]);
  const agenda = useMemo(() => agendaTasksOf(buckets, today), [buckets, today]);
  const lists: Record<TabId, TaskItem[]> = { upcoming: agenda, anytime: buckets.anytime, someday: buckets.someday };
  const count = (id: TabId) => lists[id].filter((task) => isOpen(task.status)).length;
  const row = (task: TaskItem) => (
    <TaskRow key={task.id} task={task} today={today} showWhen={tab !== "upcoming" && task.whenDate !== today} justDone={board.justDone.has(task.id)}
      onToggle={board.toggle} onOpen={(item) => board.setSheetId(item.id)} onFocus={(item) => requestFocus(item.id)} planDrag />
  );

  return (
    <section className="today-all-panel" aria-label={t("All tasks")}>
      <header className="today-col-head">
        <Button variant="ghost" size="sm" onClick={onClose}><ChevronLeft size={16} aria-hidden="true" /> {t("Back to today's list")}</Button>
      </header>
      <TabList label={t("All tasks")} className="tasks-tabs">
        {TABS.map((id) => (
          <Tab key={id} id={`today-all-tab-${id}`} selected={tab === id} controls="today-all-panel" className={classNames("tasks-tab", tab === id && "tasks-tab--on")} onClick={() => setTab(id)}>
            {t(TAB_LABEL[id])}<span className="tasks-tab-count">{count(id)}</span>
          </Tab>
        ))}
      </TabList>
      <TabPanel className="today-all-body" id="today-all-panel" labelledBy={`today-all-tab-${tab}`}>
        {count(tab) === 0 && <EmptyState size="inline" title={t(TAB_EMPTY[tab])} />}
        {tab === "upcoming" && <UpcomingAgenda tasks={agenda} today={today} renderRow={row} />}
        {tab !== "upcoming" && lists[tab].length > 0 && <ul className="tasks-list">{lists[tab].map(row)}</ul>}
      </TabPanel>
    </section>
  );
}
