import { useEffect, useState } from "react";
import { activeHeadingIndex, outlineTargetFor, subscribeOutlineTarget, type NoteHeading } from "../lib/noteOutline";

/** Index of the heading the open note is scrolled to (-1: above the first or
 *  not measurable). Follows the text's scrolling and a switch between the
 *  editor and the reading view. */
export function useActiveHeading(nodeId: string, headings: readonly NoteHeading[]): number {
  const [active, setActive] = useState(-1);
  useEffect(() => {
    let frame = 0;
    let scroller: HTMLElement | null = null;
    const measure = () => {
      const outline = outlineTargetFor(nodeId);
      if (!outline || headings.length === 0) { setActive(-1); return; }
      const viewTop = outline.scroller()?.getBoundingClientRect().top ?? 0;
      setActive(activeHeadingIndex(outline.tops(headings).map((top) => Number.isNaN(top) ? Infinity : top), viewTop));
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const attach = () => {
      scroller?.removeEventListener("scroll", schedule);
      scroller = outlineTargetFor(nodeId)?.scroller() ?? null;
      scroller?.addEventListener("scroll", schedule, { passive: true });
      schedule();
    };
    attach();
    const unsubscribe = subscribeOutlineTarget(attach);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      scroller?.removeEventListener("scroll", schedule);
      unsubscribe();
      window.removeEventListener("resize", schedule);
    };
  }, [nodeId, headings]);
  return active;
}
