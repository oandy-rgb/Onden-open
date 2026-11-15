// Hand-rolled list virtualization for CollectionView layouts.
//
// Mirrors the OverviewSidebar windower (no new dependency — the project
// hand-rolls these): past a row-count threshold a flat row array is rendered
// through a scroll window — top/bottom spacers keep the scrollbar honest and
// only the visible slice is mounted. The row PITCH (height + gap) is measured
// live from the DOM on scroll, so a design-system restyle can't drift the
// spacers and strand the tail of the list (the bug the sidebar comment warns
// about). Below the threshold nothing is windowed and the list renders exactly
// as it would unvirtualized.
//
// Unlike the sidebar (whose list owns its scroll), the CollectionView sits in a
// page-flow center pane with no fixed-height scroll ancestor, so the caller
// attaches `scrollRef` + `onScroll` to its OWN scroll container — which the
// layout only introduces when windowing is active, leaving small collections
// untouched.

import { useCallback, useRef, useState } from "react";

/** Past this many rows a section switches to windowed rendering. Matches the
 *  sidebar (~300) so small collections are byte-for-byte unchanged. */
export const ROW_WINDOW_THRESHOLD = 300;

/** Rows rendered above/below the viewport so a fast scroll doesn't flash blank
 *  before the next onScroll lands. Matches the sidebar's overscan. */
const OVERSCAN = 12;

/** Boot fallback pitch (px) until the first windowed render gives real rows to
 *  measure. Sidebar uses 35; table/list rows are a similar order. */
const FALLBACK_PITCH = 37;

export interface RowWindow {
  /** True when the row count is past the threshold and windowing is active. */
  active: boolean;
  /** First row index to mount (inclusive). */
  start: number;
  /** One past the last row index to mount (exclusive). */
  end: number;
  /** Height (px) of the top spacer that stands in for rows [0, start). */
  topSpacer: number;
  /** Height (px) of the bottom spacer that stands in for rows [end, total). */
  bottomSpacer: number;
  /** Attach to the scroll container — re-measures pitch + records scroll pos. */
  onScroll: (e: React.UIEvent<HTMLElement>) => void;
  /** Attach to the scroll container so the first measurement has a viewport. */
  scrollRef: (el: HTMLElement | null) => void;
}

/**
 * @param total       number of rows in the (already sorted/filtered/grouped)
 *                    section — windowing never changes which rows exist or their
 *                    order, only which are mounted.
 * @param rowSelector CSS selector matching the contiguous rendered rows inside
 *                    the scroll container (e.g. "[data-cv-row]"). Used to
 *                    measure the live pitch from two real rows.
 */
export function useRowWindow(total: number, rowSelector: string): RowWindow {
  const [pitch, setPitch] = useState(FALLBACK_PITCH);
  const [scroll, setScroll] = useState({ top: 0, viewport: 600 });
  const elRef = useRef<HTMLElement | null>(null);

  const active = total > ROW_WINDOW_THRESHOLD;

  const measure = useCallback(
    (el: HTMLElement) => {
      // Re-measure the real row pitch from the contiguous rendered slice. Two
      // rows are enough: their top-to-top distance / gap count = pitch. A
      // hardcoded estimate drifts when rows are restyled and strands the tail.
      const rows = el.querySelectorAll<HTMLElement>(rowSelector);
      if (rows.length >= 2) {
        const span =
          rows[rows.length - 1].getBoundingClientRect().top -
          rows[0].getBoundingClientRect().top;
        const next = span / (rows.length - 1);
        if (next > 8 && Math.abs(next - pitch) > 0.5) setPitch(next);
      }
    },
    [rowSelector, pitch],
  );

  const onScroll = useCallback(
    (e: React.UIEvent<HTMLElement>) => {
      const el = e.currentTarget;
      measure(el);
      setScroll({ top: el.scrollTop, viewport: el.clientHeight });
    },
    [measure],
  );

  const scrollRef = useCallback(
    (el: HTMLElement | null) => {
      elRef.current = el;
      if (el) {
        // Seed the viewport from the live element so the first render windows to
        // the real container height rather than the 600px fallback.
        measure(el);
        if (el.clientHeight > 0 && el.clientHeight !== scroll.viewport) {
          setScroll((s) => ({ ...s, viewport: el.clientHeight }));
        }
      }
    },
    [measure, scroll.viewport],
  );

  if (!active) {
    return {
      active: false,
      start: 0,
      end: total,
      topSpacer: 0,
      bottomSpacer: 0,
      onScroll,
      scrollRef,
    };
  }

  const start = Math.max(0, Math.floor(scroll.top / pitch) - OVERSCAN);
  const end = Math.min(
    total,
    start + Math.ceil(scroll.viewport / pitch) + 2 * OVERSCAN,
  );
  return {
    active: true,
    start,
    end,
    topSpacer: start * pitch,
    bottomSpacer: Math.max(0, total - end) * pitch,
    onScroll,
    scrollRef,
  };
}
