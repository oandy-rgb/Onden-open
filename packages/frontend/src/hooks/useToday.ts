import { useEffect, useState } from "react";
import { onAppResume } from "../lib/appResume";
import { todayId } from "../lib/localDate";

/** The workspace's today, re-read every minute and when the tab comes back, so a
 *  page left open rolls over at midnight (or at the workspace's day start hour).
 *  The one "today" hook: pages that show a day (tasks, journal) take it from here
 *  instead of calling todayId() once per render. */
export function useToday(): string {
  const [today, setToday] = useState(() => todayId());
  useEffect(() => {
    const refresh = () => setToday(todayId());
    const timer = setInterval(refresh, 60_000);
    const stop = onAppResume(refresh, ["visible"]);
    return () => { clearInterval(timer); stop(); };
  }, []);
  return today;
}
