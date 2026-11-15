// The words of the running-focus bar (the phone's bar above the navigation, the 今天 page's bar): what is being
// done, how much is left, or the break's title and time. One place, so both bars say the same thing.

import { t } from "../../../lib/i18n";
import { formatFocusClock, focusClockText, type FocusRun } from "../../../lib/focus";
import { displayTitle } from "../../../lib/noteLabel";
import { breakInfo } from "./FocusCycle";

export function focusBarParts(args: { startedAt: string; minutes: number; now: number; run: FocusRun | null; taskTitle: string | undefined }) {
  const { startedAt, minutes, now, run, taskTitle } = args;
  const rest = run && run.phase !== "focus" ? breakInfo(run, now) : null;
  const what = taskTitle ? displayTitle(taskTitle) : t("Focusing");
  const asking = run?.phase === "asking";
  return {
    rest,
    what,
    title: rest ? (asking ? t("Break is over") : rest.title) : what,
    time: rest ? (asking ? "" : t("{time} left", { time: formatFocusClock(Math.max(0, rest.leftMs), "up") })) : focusClockText(startedAt, minutes, now),
  };
}
