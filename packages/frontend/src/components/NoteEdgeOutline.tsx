import { useDeferredValue, useMemo, useState } from "react";
import { useActiveHeading } from "../hooks/useActiveHeading";
import { useIsMobile } from "../hooks/useIsMobile";
import { useT } from "../lib/i18n";
import { extractHeadings, scrollToNoteHeading, type NoteHeading } from "../lib/noteOutline";
import { classNames } from "../lib/utils";
import "./NoteEdgeOutline.css";
import { Pressable } from "./ui";

/** A note needs this many headings before it gets an outline. */
export const OUTLINE_MIN_HEADINGS = 3;

function Lines({ nodeId, headings }: { nodeId: string; headings: readonly NoteHeading[] }) {
  const t = useT();
  const scrolled = useActiveHeading(nodeId, headings);
  // A click marks its heading at once; scrolling takes over again.
  const [clicked, setClicked] = useState<{ nodeId: string; scrolled: number; index: number } | null>(null);
  const active = clicked && clicked.nodeId === nodeId && clicked.scrolled === scrolled ? clicked.index : scrolled;
  return (
    <div className="note-edge-outline-anchor">
      <nav className="note-edge-outline" aria-label={t("Headings")}>
        {headings.map((heading) => (
          <Pressable
            key={heading.index}
            type="button"
            className={classNames("note-edge-line", `note-edge-line--h${heading.level}`, active === heading.index && "is-active")}
            aria-label={heading.text}
            aria-current={active === heading.index ? "location" : undefined}
            onClick={() => { scrollToNoteHeading(nodeId, heading); setClicked({ nodeId, scrolled, index: heading.index }); }}
          >
            <span className="note-edge-bar" aria-hidden="true" />
            <span className="note-edge-label" aria-hidden="true">{heading.text}</span>
          </Pressable>
        ))}
      </nav>
    </div>
  );
}

/** The note's table of contents as a column of thin lines at the right edge of its text (it replaces the
 *  info panel's 「段落」 tab). One line per h1–h3 heading — longer for a higher level, darker for the one
 *  the text is scrolled to. Hovering or focusing a line shows the heading; a click scrolls the editor or
 *  the reading view there. Not on a phone (no room beside the text) and not for a short note. */
export default function NoteEdgeOutline({ nodeId, markdown }: { nodeId: string; markdown: string }) {
  const phone = useIsMobile();
  // The headings are re-read a moment after typing stops, not on every key.
  const settled = useDeferredValue(markdown);
  const headings = useMemo(() => extractHeadings(settled), [settled]);
  return phone || headings.length < OUTLINE_MIN_HEADINGS ? null : <Lines nodeId={nodeId} headings={headings} />;
}
