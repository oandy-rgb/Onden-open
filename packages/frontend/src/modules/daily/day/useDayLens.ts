// What the server knows about one date (GET /api/day/:date/lens, read-policy
// filtered there): the timeline's items plus the notes created and saved that
// day. Fetched on the date and again every few minutes while the page stays
// open. `failed` is true while the first answer for this date is missing
// (offline, not permitted): the local copy then stands alone.

import { useEffect, useState } from "react";
import type { DayLens } from "@onden/markdown";
import { reads } from "../../../lib/data";

const REFRESH_MS = 120_000;

// The response type is shared with the server (@onden/markdown DayLens): the
// notes of the day sit under `buckets`, next to the timeline's `items`.
export type { DayLens, DayLensNote as LensNote } from "@onden/markdown";

export function useDayLens(date: string): { lens: DayLens | null; failed: boolean } {
  const [remote, setRemote] = useState<{ date: string; lens: DayLens } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    reads.workspace.dayLens<DayLens>(date)
      .then((lens) => { if (!cancelled) { setRemote({ date, lens }); setFailed(null); } })
      .catch(() => { if (!cancelled) setFailed(date); });
    return () => { cancelled = true; };
  }, [date, tick]);

  const lens = remote?.date === date ? remote.lens : null;
  return { lens, failed: failed === date && lens === null };
}
