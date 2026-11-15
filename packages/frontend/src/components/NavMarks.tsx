import type { ComponentType } from "react";
import type { NavIndicatorProps } from "../modules";

/** The modules' marks after a nav entry's label (FrontendModule.NavIndicator,
 *  carried by hooks/shellNavigation). `dotOnly` is for a container that
 *  folds entries (更多 ▾, the phone's 更多 button): each mark renders as a
 *  plain dot and CSS shows the first one only, so the container gets one dot
 *  when any entry inside has something new. */
export default function NavMarks({ indicators, dotOnly = false }: { indicators: readonly ComponentType<NavIndicatorProps>[]; dotOnly?: boolean }) {
  if (indicators.length === 0) return null;
  return (
    <span className="nav-marks" data-dot-only={dotOnly ? "1" : undefined}>
      {indicators.map((Indicator, i) => <Indicator key={i} dotOnly={dotOnly} />)}
    </span>
  );
}
