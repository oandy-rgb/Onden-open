import { useCallback, useState } from "react";

/** The pages whose ink engine is up (PageInkSurface `onLiveChange`): their drawing is on the engine's
 *  canvases, so the picture of it (PageInkSvg) hides there. */
export function useLivePages(): { live: ReadonlySet<string>; onLiveChange: (pageKey: string, live: boolean) => void } {
  const [live, setLive] = useState<ReadonlySet<string>>(() => new Set());
  const onLiveChange = useCallback((pageKey: string, isLive: boolean) => {
    setLive((cur) => {
      if (cur.has(pageKey) === isLive) return cur;
      const next = new Set(cur);
      if (isLive) next.add(pageKey); else next.delete(pageKey);
      return next;
    });
  }, []);
  return { live, onLiveChange };
}
