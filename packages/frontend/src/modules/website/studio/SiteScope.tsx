// The frame every drawing of the home page sits in: `.site-scope` with the
// design's style variables and its scoped CSS. The studio canvas, the preview
// of a suggestion and the publish dialog's "see the site" all use it, so what
// the owner sees in each is what the published page does.
import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { scopedCss, styleVars, type PuckData, type SchemeMode, type SiteScheme, type SiteStyle } from "@onden/site";
import "@onden/site/react/siteParts.css";
import "./SiteScope.css";
// The 「class 名稱」 vocabulary a part may carry; the app itself never loads it.
import "../../../styles/site-utilities.css";
import { useAppSchemeMode } from "../../../hooks/useAppSchemeMode";

/** The scheme a site shows by default: its own when it fixes one, else Onden's. */
export function useDefaultSchemeMode(scheme: SiteScheme): SchemeMode {
  const app = useAppSchemeMode();
  return scheme === "system" ? app : scheme;
}

/** `mode` is the preview's light/dark switch (never stored in the design);
 *  without it the site's own 配色 setting decides. `viewport` draws the type at
 *  that width (the phone preview inside a wider window). */
export function SiteScope({ design, mode, viewport, className, children }: {
  /** The style and CSS to draw with; `home` is the Puck home page whose per-part CSS applies (the old studio's, or the design's `legacy_home` while it is drawn). */
  design: { style: SiteStyle; css: string; home?: PuckData | null };
  mode?: SchemeMode;
  viewport?: number;
  className?: string;
  children: ReactNode;
}) {
  const css = useMemo(() => scopedCss(design.css, design.home ?? null), [design.css, design.home]);
  const ref = useRef<HTMLDivElement>(null);
  const fallback = useDefaultSchemeMode(design.style.scheme);
  const shown = mode ?? fallback;
  // The --s-* variables are the design's style, computed: set as properties of the frame.
  useLayoutEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    for (const [name, value] of Object.entries(styleVars(design.style, { mode: shown, viewport }))) frame.style.setProperty(name, value);
    frame.style.colorScheme = shown;
  }, [design.style, shown, viewport]);
  return (
    <div ref={ref} className={["site-scope", "hs-paper", className].filter(Boolean).join(" ")} data-scheme={shown}>
      <style>{css}</style>
      {children}
    </div>
  );
}
