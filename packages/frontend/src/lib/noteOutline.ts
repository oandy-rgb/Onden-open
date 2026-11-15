import { headingAnchorLines } from "@onden/markdown";

// The headings of the note being read (the info panel's 「段落」 tab) and the
// bridge from that list to the text on screen. What a heading is comes from
// @onden/markdown (headingAnchors), the same rule the renderer and the TOC use.
//
// Headings are numbered in document order (`index`). The editor finds one by
// its `line`; the reading view by the index-th h1–h3 it drew.

export type NoteHeading = { index: number; level: 1 | 2 | 3; text: string; /** 0-based line of the heading in the body. */ line: number };

/** The h1–h3 headings of `markdown`, in order, as the page shows them: the shared
 *  rule (@onden/markdown headingAnchors) decides what a heading is, so code fences,
 *  math blocks and hidden `key:: value` lines never produce one. */
export function extractHeadings(markdown: string): NoteHeading[] {
  const headings: NoteHeading[] = [];
  for (const { anchor, line } of headingAnchorLines(markdown)) {
    if (anchor.depth > 3 || !anchor.text) continue;
    headings.push({ index: headings.length, level: anchor.depth as 1 | 2 | 3, text: anchor.text, line });
  }
  return headings;
}

/** Which heading the reader is in: the last one whose top is at or above
 *  `viewTop + slack`. -1 before the first heading. */
export function activeHeadingIndex(tops: readonly number[], viewTop: number, slack = 80): number {
  let active = -1;
  tops.forEach((top, i) => { if (top <= viewTop + slack) active = i; });
  return active;
}

// ── The bridge: the open note's editor or reading view ─────────────────────

export type OutlineTarget = {
  /** Scroll the heading to the top of the page. */
  scrollTo: (heading: NoteHeading) => void;
  /** Each heading's top edge in viewport pixels (NaN: not measurable). */
  tops: (headings: readonly NoteHeading[]) => number[];
  /** The element whose scrolling moves the text. */
  scroller: () => HTMLElement | null;
};

let target: { nodeId: string; outline: OutlineTarget } | null = null;
const listeners = new Set<() => void>();

/** Called by the open note (editor or reading view); returns the unregister. */
export function registerOutlineTarget(nodeId: string, outline: OutlineTarget): () => void {
  const entry = { nodeId, outline };
  target = entry;
  listeners.forEach((listener) => listener());
  return () => {
    if (target !== entry) return;
    target = null;
    listeners.forEach((listener) => listener());
  };
}

/** The open note's target for `nodeId`; null when that note is not open. */
export function outlineTargetFor(nodeId: string): OutlineTarget | null {
  return target && target.nodeId === nodeId ? target.outline : null;
}

export function subscribeOutlineTarget(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Scroll `nodeId`'s open text to `heading`. False when that note is not open. */
export function scrollToNoteHeading(nodeId: string, heading: NoteHeading): boolean {
  const outline = outlineTargetFor(nodeId);
  if (!outline) return false;
  outline.scrollTo(heading);
  return true;
}

/** The reading view's target: the index-th h1–h3 inside `root`. */
export function previewOutline(root: () => HTMLElement | null, scroller: () => HTMLElement | null): OutlineTarget {
  const elements = () => Array.from(root()?.querySelectorAll<HTMLElement>(".obsidian-preview h1, .obsidian-preview h2, .obsidian-preview h3") ?? []);
  return {
    scrollTo: (heading) => elements()[heading.index]?.scrollIntoView({ block: "start", behavior: "smooth" }),
    tops: (headings) => { const found = elements(); return headings.map((h) => found[h.index]?.getBoundingClientRect().top ?? NaN); },
    scroller,
  };
}
