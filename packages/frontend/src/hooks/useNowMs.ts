import { useEffect, useState } from "react";
import { onAppResume } from "../lib/appResume";

/** The current instant (ms), re-read every `everyMs` (default 30 s) and when the tab
 *  comes back, so a "now" line or a "40 min from now" label keeps moving. */
export function useNowMs(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const timer = setInterval(refresh, everyMs);
    const stop = onAppResume(refresh, ["visible"]);
    return () => { clearInterval(timer); stop(); };
  }, [everyMs]);
  return now;
}
