// The focus records of one day from the server (the person's own; offline there are none to show).
// A focus begun or ended on this device reads them again.

import { useEffect, useState } from "react";
import type { FocusSession } from "@onden/contract";
import { reads } from "../../../lib/data";
import { useFocusState } from "../../../lib/focus";

type FocusOfDay = { date: string; sessions: FocusSession[]; running: FocusSession | null };

export function useFocusOfDay(date: string, enabled: boolean): FocusOfDay | null {
  const runningId = useFocusState().running?.id ?? null;
  const [answer, setAnswer] = useState<FocusOfDay | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    reads.workspace.focusOfDay(date)
      .then((reply) => { if (!cancelled) setAnswer({ date, sessions: reply.sessions ?? [], running: reply.running ?? null }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [date, enabled, runningId]);
  return enabled && answer?.date === date ? answer : null;
}
