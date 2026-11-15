import { useCallback, useEffect, useRef, useState } from "react";

/** How long "Copied" and similar acknowledgements stay visible. */
export const COPIED_FLASH_MS = 1500;

/** Calls `reset` once `ms` has passed since `key` last changed to a non-null,
 *  non-false value. A new `key` restarts the clock, a falsy `key` or unmount
 *  cancels it, so an older timer can never clear a newer value. */
export function useAutoReset(key: unknown, reset: () => void, ms: number): void {
  const resetRef = useRef(reset);
  resetRef.current = reset;
  useEffect(() => {
    if (key === null || key === undefined || key === false) return;
    const timer = setTimeout(() => resetRef.current(), ms);
    return () => clearTimeout(timer);
  }, [key, ms]);
}

/** A flag that turns itself off `ms` after the last `flash()` ("Copied"). */
export function useTransientFlag(ms: number = COPIED_FLASH_MS): [on: boolean, flash: () => void] {
  const [stamp, setStamp] = useState(0);
  useAutoReset(stamp > 0 && stamp, () => setStamp(0), ms);
  const flash = useCallback(() => setStamp((n) => n + 1), []);
  return [stamp > 0, flash];
}
