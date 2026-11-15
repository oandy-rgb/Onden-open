import { useEffect, useMemo, useState } from "react";
import { reads } from "../lib/data";
import { keepExternalEvents, readCachedExternalEvents, type ExternalEvent } from "../lib/externalCalendars";
import { useShellFeature } from "./useShellFeature";

/** The subscribed-calendar events touching `from`..`to` (workspace days). Empty while the feature is off,
 *  while loading, and when neither the server nor the copy kept on this device can answer. */
export function useExternalEvents(from: string, to: string): readonly ExternalEvent[] {
  const on = useShellFeature("ext-calendars");
  const [answer, setAnswer] = useState<{ from: string; to: string; events: ExternalEvent[] } | null>(null);
  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    reads.workspace.externalCalendars<{ events: ExternalEvent[] }>(`/events?from=${from}&to=${to}`).then(
      (reply) => {
        // A server that does not know the feature answers something else: no events, nothing kept.
        const events = Array.isArray(reply?.events) ? reply.events : [];
        if (cancelled) return;
        setAnswer({ from, to, events });
        keepExternalEvents({ from, to, events });
      },
      () => {
        const kept = readCachedExternalEvents();
        if (!cancelled && kept) setAnswer(kept);
      },
    );
    return () => { cancelled = true; };
  }, [on, from, to]);
  return useMemo(() => (on && answer ? answer.events.filter((e) => e.start_day <= to && e.end_day >= from) : []), [on, answer, from, to]);
}

