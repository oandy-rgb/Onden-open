import { useCallback, useEffect, useState } from "react";
import { reads } from "../../lib/data";
import { useLiveRefetch } from "../../lib/liveInvalidation";

/** A small read-filtered GET kept current: fetched on mount, on every
 *  "changed" tick (grading emits domain events) and reopened stream
 *  (lib/liveInvalidation.ts), and every `pollMs` regardless of the stream —
 *  review counts depend on the clock (a card falling due emits no event), so
 *  a connected stream alone would freeze them. A failed read keeps the last
 *  value. `refresh` re-pulls on demand (after a session). */
export function useLiveResource<Raw, T>(path: string, select: (raw: Raw) => T, initial: T, pollMs = 60_000): { value: T; refresh: () => Promise<void> } {
  const [value, setValue] = useState<T>(initial);
  const refresh = useCallback(async () => {
    try { setValue(select(await reads.modules.review.resource<Raw>(path))); } catch { /* offline / not ready — keep the last value */ }
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps -- select is a pure projection
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);
  useLiveRefetch("changed", refresh);
  return { value, refresh };
}
