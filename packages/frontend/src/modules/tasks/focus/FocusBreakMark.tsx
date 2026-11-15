// The desktop's little mark during a break (FocusHost's FocusTopMark shows it): the break's name and what is
// left of it, or 「休息結束」 once it ran out. Loaded with the screens: the shell does not carry a break's rules.

import { Coffee } from "lucide-react";
import { Button } from "../../../components/ui";
import { useNowMs } from "../../../hooks/useNowMs";
import { useT } from "../../../lib/i18n";
import { formatFocusClock, setFocusExpanded, type FocusRun } from "../../../lib/focus";
import { breakInfo } from "./FocusCycle";
import "./focus.css";

export default function FocusBreakMark({ run }: { run: FocusRun }) {
  const t = useT();
  const now = useNowMs(1000);
  const rest = breakInfo(run, now);
  return (
    <div className="focus-mark-slot">
      <Button size="sm" variant="secondary" className="focus-mark focus-mark--break" aria-label={t("Back to the focus screen")} onClick={() => setFocusExpanded(true)}>
        <Coffee size={14} aria-hidden="true" /> {run.phase === "asking" ? t("Break is over") : `${rest.title} · ${t("{time} left", { time: formatFocusClock(Math.max(0, rest.leftMs), "up") })}`}
      </Button>
    </div>
  );
}
