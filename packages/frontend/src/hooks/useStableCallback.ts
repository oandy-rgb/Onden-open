// Identity-stable event-handler wrappers (H4 re-render hygiene).
//
// React.memo on big children (sidebar / topbar / inspector / canvas shell)
// only pays if their callback props keep ONE identity across parent renders.
// Most of BuilderApp's handlers come from per-render hook factories, so we
// wrap them: the wrapper's identity never changes, the body always calls the
// LATEST closure. Handlers are invoked from events (never during render), so
// reading the render-time ref is safe.

import { useCallback, useMemo, useRef } from "react";

export function useStableCallback<Args extends unknown[], R>(
  fn: (...args: Args) => R,
): (...args: Args) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: Args) => ref.current(...args), []);
}

type AnyFn = (...args: never[]) => unknown;

/** Stabilize a whole hook-returned bag of handlers at once. The key set must
 *  be the same on every render (it is — hooks return fixed shapes). */
export function useStableHandlers<T extends Record<string, AnyFn>>(handlers: T): T {
  const ref = useRef(handlers);
  ref.current = handlers;
  const keys = Object.keys(handlers).join("\0");
  return useMemo(() => {
    const out: Record<string, AnyFn> = {};
    for (const key of Object.keys(ref.current)) {
      out[key] = (...args: never[]) => ref.current[key](...args);
    }
    return out as T;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuild only if the key set changes
  }, [keys]);
}
