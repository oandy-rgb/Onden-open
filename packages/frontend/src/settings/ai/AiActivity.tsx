import { useEffect, useState } from "react";

import { reads } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { dateLabel } from "../../lib/timeLabels";

type Stats = { last_active: string | null; tool_calls: number; changes: Array<{ event_type: string; count: number }> };

/** What an AI did in the last 30 days, in one sentence. */
export default function AiActivity({ ai, enabled }: { ai: { id: string; name: string }; enabled: boolean }) {
  const t = useT();
  const [stats, setStats] = useState<Stats | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    reads.people.actorStats<Stats>(ai.id).then((s) => { if (!cancelled) setStats(s); }).catch(() => { if (!cancelled) setStats(null); });
    return () => { cancelled = true; };
  }, [ai.id, enabled]);
  if (!enabled) return null;
  return (
    <section className="ai-role-block" aria-label={t("Recent activity of {name}", { name: ai.name })}>
      <h5>{t("What it did lately")}</h5>
      <p className="member-hint">
        {stats === undefined ? t("Loading…")
          : stats === null || (!stats.last_active && stats.tool_calls === 0) ? t("Nothing in the last 30 days.")
          : t("Last 30 days: {n} requests. Last active {date}.", { n: stats.tool_calls, date: stats.last_active ? dateLabel(stats.last_active, "shortDateTime") : "—" })}
      </p>
    </section>
  );
}
