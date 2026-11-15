import { useEffect, useState } from "react";
import { isHistoryUnavailable } from "../../lib/history";

export type Load<T> = { status: "loading" } | { status: "error"; unavailable: boolean } | { status: "ready"; value: T };

/** Run `load` again whenever `deps` change, or when the returned function is called. An older
 *  backend's 404 is `unavailable`, which the screens show as their empty state. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    load().then(
      (value) => { if (live) setState({ status: "ready", value }); },
      (error) => { if (live) setState({ status: "error", unavailable: isHistoryUnavailable(error) }); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` is the caller's key list
  }, [...deps, attempt]);
  return [state, () => setAttempt((n) => n + 1)];
}

export const failed = (s: Load<unknown>): boolean => s.status === "error" && !s.unavailable;
