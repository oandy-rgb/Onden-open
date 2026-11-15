// The focus timer's two mounts in the shell. They stay tiny: the screens
// (FocusScreens) load the first time a focus is running or asked for.
//
//   FocusHost     the end of the shell: the bar above the phone's navigation, the sheets and the full screen
//   FocusTopMark  the top of the shell: on a desktop, the little mark that brings the full screen back

import { Suspense, useEffect } from "react";
import { Timer } from "lucide-react";
import { lazyWithReload } from "../../../lib/lazyWithReload";
import { onAppResume } from "../../../lib/appResume";
import { useTasksEnabled } from "../../../hooks/useShellFeature";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { useNowMs } from "../../../hooks/useNowMs";
import { useT } from "../../../lib/i18n";
import { Button } from "../../../components/ui";
import { focusClockText, focusMinutesPref, refreshFocus, setFocusExpanded, useFocusMinutes, useFocusState } from "../../../lib/focus";
import "./focus.css";

const FocusScreens = lazyWithReload(() => import("./FocusScreens"));
// A break's words and rules come with the screens, not with the shell.
const FocusBreakMark = lazyWithReload(() => import("./FocusBreakMark"));

export default function FocusHost({ onOpenNote }: { onOpenNote: (id: string) => void }) {
  const tasksOn = useTasksEnabled();
  const { running, request } = useFocusState();
  focusMinutesPref.useKeepInSync();
  // The server's running record is the truth: read it at load and whenever the app comes back.
  // With tasks switched off nothing of the timer shows (the record itself is kept).
  useEffect(() => {
    if (!tasksOn) return;
    void refreshFocus();
    return onAppResume(() => { void refreshFocus(); });
  }, [tasksOn]);
  return tasksOn && (running || request) ? <Suspense fallback={null}><FocusScreens onOpenNote={onOpenNote} /></Suspense> : null;
}

export function FocusTopMark() {
  const t = useT();
  const tasksOn = useTasksEnabled();
  const { running, expanded, ending, run: storedRun } = useFocusState();
  const phone = useIsMobile();
  if (!tasksOn || !running || phone || expanded || ending) return null;
  // A run belongs to the record it waits on (as in FocusScreens): its round length counts, and its break shows as a break.
  const run = storedRun && storedRun.recordId === running.id ? storedRun : null;
  if (run && run.phase !== "focus") return <Suspense fallback={null}><FocusBreakMark run={run} /></Suspense>;
  return <FocusMarkButton label={t("Back to the focus screen")} startedAt={running.started_at} runMinutes={run?.minutes} />;
}

function FocusMarkButton({ label, startedAt, runMinutes }: { label: string; startedAt: string; runMinutes?: number }) {
  const pref = useFocusMinutes();
  const minutes = runMinutes ?? pref;
  const now = useNowMs(1000);
  return (
    <div className="focus-mark-slot">
      <Button size="sm" variant="secondary" className="focus-mark" aria-label={label} onClick={() => setFocusExpanded(true)}>
        <Timer size={14} aria-hidden="true" /> {focusClockText(startedAt, minutes, now)}
      </Button>
    </div>
  );
}
