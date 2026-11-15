// The focus running now, as one bar under a page's header (the 今天 page): what, which round, how much
// is left, 「全螢幕」 and 「結束專注」. It reads the same store and says the same words as the phone's bar
// above the navigation (FocusScreens); the starting, the breaks and the end step stay with FocusScreens,
// which the shell mounts. A page that draws this marks itself `data-focus-stays` (lib/focus requestFocus reads it), so
// starting a focus there does not cover it with the full screen.

import { Coffee, Maximize2, Timer } from "lucide-react";
import { Button } from "../../../components/ui";
import { useNowMs } from "../../../hooks/useNowMs";
import { useTasksEnabled } from "../../../hooks/useShellFeature";
import { useT } from "../../../lib/i18n";
import { setFocusExpanded, useFocusMinutes, useFocusState } from "../../../lib/focus";
import { classNames } from "../../../lib/utils";
import { focusBarParts } from "./focusBarParts";
import FocusEndButton from "./FocusEndButton";
import { useFocusTask } from "./useFocusTask";
import "./focus.css";

export default function FocusPageBar() {
  const t = useT();
  const tasksOn = useTasksEnabled();
  const { running, run: storedRun } = useFocusState();
  const pref = useFocusMinutes();
  const now = useNowMs(1000);
  const task = useFocusTask(running?.task_id);
  if (!tasksOn || !running) return null;
  const run = storedRun && storedRun.recordId === running.id ? storedRun : null;
  const minutes = run?.minutes ?? pref;
  const { rest, title, time } = focusBarParts({ startedAt: running.started_at, minutes, now, run, taskTitle: task?.title });
  const Icon = rest ? Coffee : Timer;
  return (
    <div className={classNames("focus-page-bar", rest && "focus-page-bar--break")} role="region" aria-label={t("Focus timer")}>
      <Icon size={16} aria-hidden="true" />
      <span className="focus-page-bar-title">{title}</span>
      {run && !rest && <span className="focus-page-bar-round">{t("Round {n}", { n: run.round })}</span>}
      <span className="focus-page-bar-time" aria-live="off">{time}</span>
      <Button size="sm" variant="ghost" onClick={() => setFocusExpanded(true)}><Maximize2 size={14} aria-hidden="true" /> {t("Full screen")}</Button>
      <FocusEndButton onBreak={!!rest} />
    </div>
  );
}
