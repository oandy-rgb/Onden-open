import { useEffect, useState } from "react";
import { MOBILE_QUERY, matchesMedia, mediaQueryList } from "../lib/mediaQuery";

// The widths, queries and one-off checks live in lib/mediaQuery (lib/ may not import hooks/); re-exported so
// components keep asking here.
export { BREAKPOINT_PX, MOBILE_QUERY, COARSE_POINTER_QUERY, isMobileLayout, isCoarsePointer } from "../lib/mediaQuery";

/** Live media-query state; false where matchMedia is missing (jsdom). */
export function useMediaQuery(query: string): boolean {
  const [state, setState] = useState(() => matchesMedia(query));
  useEffect(() => {
    const mq = mediaQueryList(query);
    if (!mq) return;
    const apply = () => setState(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [query]);
  return state;
}

/** True while the app is in its phone layout (≤900px wide). */
export function useIsMobile(): boolean { return useMediaQuery(MOBILE_QUERY); }
