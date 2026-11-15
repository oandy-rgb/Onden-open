import { useRef, type CSSProperties } from "react";
import type { InkRegion } from "@onden/markdown/ink";
import { useDismiss } from "../../hooks/useEscapeKey";
import { useInkRegionFrame } from "../../hooks/useInkRegionFrame";
import type { RegionCorner } from "../../lib/inkRegionQuote";
import { useT } from "../../lib/i18n";
import { classNames } from "../../lib/utils";
import { Pressable, TextField } from "../ui";
import "./InkRegionLayer.css";

// The frame of the 「引用」 tool over one handwriting page: drag out an area, pull its corners or move
// it, then 「複製引用」. The region is in page units (@onden/markdown inkRegion.ts) and drawn in
// percentages of the page, so zoom needs no measuring; only a pointer's position is converted back.
// One frame at most, held by the shell (`region`), so it can be copied, cancelled (Esc, the button,
// pressing elsewhere) or — after a jump from a quoted embed — marked for a moment (`marked`).
//
// Input follows the page's input policy: the pen and the mouse always frame; a finger frames only
// when fingers draw (not "only scroll"), otherwise it scrolls and pinches the page as usual.

export type CopyNotice = { kind: "copied" } | { kind: "manual"; text: string };

type Props = {
  pageKey: string;
  pageSize: { width: number; height: number };
  /** The 「引用」 tool is selected: the layer takes the pointer. Off: only a mark is shown. */
  active: boolean;
  /** "Only scroll" for fingers (lib/ink/inputPolicy). */
  stylusOnly: boolean;
  region: InkRegion | null;
  onRegionChange: (region: InkRegion | null) => void;
  onCopy: () => void;
  notice: CopyNotice | null;
  /** A region to show for a moment (arriving from a quoted embed), whatever the tool. */
  marked: InkRegion | null;
  /** Changes with every request to show `marked`, so the mark starts again even for the same area. */
  markSerial?: number;
  /** The pen touched the screen. */
  onPenSeen?: () => void;
};

const CORNERS: RegionCorner[] = ["nw", "ne", "sw", "se"];
const pct = (n: number, of: number) => `${(n / of) * 100}%`;

export default function InkRegionLayer({ pageKey, pageSize, active, stylusOnly, region, onRegionChange, onCopy, notice, marked, markSerial = 0, onPenSeen }: Props) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mine = region && region.page === pageKey ? region : null;
  const { draft, onCaptureDown, startOn, forward, fingerFrames } = useInkRegionFrame({ pageKey, pageSize, rootRef, stylusOnly, region: mine, onRegionChange, onPenSeen });
  const shown = draft ?? mine;

  // Esc and Back put the frame away (the one dismiss stack; Esc not while an input method is composing).
  useDismiss(() => { onRegionChange(null); }, active && mine !== null);

  const nearBottom = mine ? mine.y + mine.h > pageSize.height * 0.9 : false;

  return (
    <div ref={rootRef} className={classNames("ink-region-layer", active && "ink-region-layer--active", !fingerFrames && "ink-region-layer--finger-scrolls")} data-ink-region-page={pageKey}>
      {active && (
        <div
          className={classNames("ink-region-capture", fingerFrames && "ink-region-capture--finger")}
          data-ink-region-capture=""
          onPointerDown={onCaptureDown}
          {...forward}
        />
      )}
      {shown && (
        <div className="ink-region-frame" style={{ "--rl": pct(shown.x, pageSize.width), "--rt": pct(shown.y, pageSize.height), "--rw": pct(shown.w, pageSize.width), "--rh": pct(shown.h, pageSize.height) } as CSSProperties} role="group" aria-label={t("Quoted area")}
          onPointerDown={active && !draft ? startOn("move") : undefined} {...forward}>
          {active && !draft && CORNERS.map((corner) => (
            <span key={corner} className={`ink-region-handle ink-region-handle--${corner}`} data-ink-region-handle={corner}
              aria-label={t("Resize the frame")} onPointerDown={startOn("resize", corner)} {...forward} />
          ))}
        </div>
      )}
      {marked && marked.page === pageKey && <div key={markSerial} className="ink-region-mark" style={{ "--rl": pct(marked.x, pageSize.width), "--rt": pct(marked.y, pageSize.height), "--rw": pct(marked.w, pageSize.width), "--rh": pct(marked.h, pageSize.height) } as CSSProperties} data-ink-region-mark="" aria-hidden="true" />}
      {active && mine && !draft && (
        <div className={classNames("ink-region-bar", nearBottom && "ink-region-bar--above")} role="toolbar" aria-label={t("Quote")} style={{ "--rl": pct(mine.x, pageSize.width), "--rt": pct(mine.y + mine.h, pageSize.height), "--rb": pct(pageSize.height - mine.y, pageSize.height) } as CSSProperties} onPointerDown={(e) => e.stopPropagation()}>
          <Pressable type="button" className="ink-region-copy" onClick={onCopy}>{t("Copy reference")}</Pressable>
          <Pressable type="button" className="ink-region-cancel" onClick={() => onRegionChange(null)}>{t("Cancel")}</Pressable>
          {notice?.kind === "copied" && <span className="ink-region-note" role="status">{t("Copied. Paste it into any note.")}</span>}
          {notice?.kind === "manual" && (
            <span className="ink-region-manual">
              <span role="status">{t("Copy this text yourself and paste it into a note.")}</span>
              <TextField className="ink-region-text" readOnly value={notice.text} onFocus={(e) => e.currentTarget.select()} aria-label={t("Reference")} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}
