import { useEffect, useRef, type MouseEvent } from "react";
import { NotePreview } from "./markdownSurfaces";
import type { ContentNode } from "../lib/api";
import type { WikilinkSource } from "../lib/wikilinks";
import { sourceOffsetFromPreviewText } from "../lib/viewSwitch";
import { citationCount, groupCitations } from "../lib/blockSafety";
import "./ObsidianImport.css";
import { caretFromPoint, currentSelection } from "../lib/documentAccess";
import type { BlockCitationRow } from "@onden/contract";

type Props = {
  draft: string;
  nodes: ContentNode[];
  /** The note being previewed: its [[links]] resolve within its space. */
  from?: WikilinkSource | null;
  /** A clicked [[link]]: its label, and the target's id when it resolved. */
  /** `blockId`: the link was `[[note#^id]]` (the target may not hold it any more: useOverviewMode.openWikilink). */
  onOpenWikilink: (label: string, targetId: string | null, blockId?: string) => void;
  /** Present when the viewer can edit: a task box in the preview flips its source line. */
  onToggleTask?: (checkboxIndex: number) => void;
  /** Present when the viewer can edit: a click on blank space or a double-click on
   *  text asks to go back to editing, with the source offset when it can be told. */
  onRequestEdit?: (sourceOffset: number | null) => void;
  /** Who cites the paragraphs of this note: the cited ones get a number at the right edge. */
  citations?: readonly BlockCitationRow[];
  /** A tap on that number: the paragraph's `^id` and the element the list opens beside. */
  onOpenCitations?: (blockId: string, anchor: HTMLElement) => void;
};

/** The width of the number's tap target, from the paragraph's right edge. */
const CITED_TAP_PX = 44;

// Anything a click already means something on: links, task boxes, embeds, media.
const INTERACTIVE = "a, button, input, textarea, select, summary, label, iframe, video, audio, img, svg, [role='button'], [contenteditable='true'], .embed-block, .wikilink-embed, [data-embed]";

function textUnderPoint(x: number, y: number): { text: string; offset: number } | null {
  const caret = caretFromPoint(x, y);
  return caret && caret.node.nodeType === Node.TEXT_NODE ? { text: caret.node.textContent ?? "", offset: caret.offset } : null;
}

export default function OverviewPreview({ draft, nodes, from, onOpenWikilink, onToggleTask, onRequestEdit, citations, onOpenCitations }: Props) {
  const article = useRef<HTMLElement>(null);
  // The number is drawn by the stylesheet from `data-cited`, so the rendered text is not touched.
  useEffect(() => {
    const root = article.current;
    if (!root) return;
    const marked: HTMLElement[] = [];
    const byBlock = groupCitations(citations ?? []);
    for (const el of root.querySelectorAll<HTMLElement>("[data-block-id]")) {
      const count = citationCount(byBlock.get(el.dataset.blockId ?? ""));
      if (count > 0) { el.dataset.cited = String(count); marked.push(el); }
    }
    return () => { for (const el of marked) delete el.dataset.cited; };
  }, [citations, draft]);
  const openCited = (e: MouseEvent) => {
    const el = (e.target as Element).closest<HTMLElement>("[data-cited]");
    if (!el || !onOpenCitations || e.clientX < el.getBoundingClientRect().right - CITED_TAP_PX) return false;
    onOpenCitations(el.dataset.blockId ?? "", el);
    return true;
  };
  const requestEdit = (e: MouseEvent, onlyBlank: boolean) => {
    if (!onRequestEdit || (e.target as Element).closest(INTERACTIVE)) return;
    // Selecting text to copy ends in a click too; leave that alone.
    if (!currentSelection()?.isCollapsed && onlyBlank) return;
    const hit = e.target === e.currentTarget ? null : textUnderPoint(e.clientX, e.clientY);
    onRequestEdit(hit ? sourceOffsetFromPreviewText(draft, hit.text, hit.offset) : null);
  };
  return (
    <article ref={article} className="obsidian-preview obsidian-preview--md"
      onClick={(e) => { if (openCited(e)) return; if (e.target === e.currentTarget) requestEdit(e, true); }}
      onDoubleClick={(e) => requestEdit(e, false)}>
      {/* The app profile: the same pipeline as the published site
          (@onden/markdown), except that inline HTML renders here and shows
          as text there. mermaid lazy-loads on the first diagram. */}
      <NotePreview nodes={nodes} from={from} onNavigate={(label, nodeId, blockId) => onOpenWikilink(label, nodeId, blockId)} onToggleTask={onToggleTask}>
        {draft}
      </NotePreview>
    </article>
  );
}
