// The few ways the app draws a note's Markdown, each with its props fixed in
// one place. MarkdownRenderer's own props (which links resolve, whether math
// and diagrams draw, which profile) are what a surface decides, and each caller
// used to pick them again by hand; a screen now names the surface it is, so a
// change to how a surface reads (say, resolving a [[link]] that names no note)
// is one edit here. Only this file and the published pages (siteFrame/
// siteMarkdown) may import MarkdownRenderer (test/guards/dup-b2-text.guard).

import type { ReactNode } from "react";
import { drawnWikilinks, wikilinkLabel, type FrozenQueryBlock } from "@onden/markdown";
import MarkdownRenderer from "./MarkdownRenderer";
import { readerHtmlAsOneBlock } from "../lib/readerHtml";
import type { WikilinkNode, WikilinkSource } from "../lib/wikilinks";

type OpenLink = (slug: string, nodeId: string | null, blockId?: string, heading?: string) => void;

/** A note's text, read in the app: its [[links]] and ![[embeds]] resolve among
 *  `nodes` (a link to no note is dimmed) from the note `from`, a click goes to
 *  `onNavigate`. The note preview, the daily page, a slide, an embed's body. */
export function NotePreview({ children, nodes, from, onNavigate, onToggleTask }: {
  children: string;
  nodes: WikilinkNode[];
  from?: WikilinkSource | null;
  onNavigate?: OpenLink;
  /** Makes the task checkboxes tickable; omit for a read-only view. */
  onToggleTask?: (checkboxIndex: number) => void;
}) {
  return <MarkdownRenderer nodes={nodes} from={from} onNavigate={onNavigate} onToggleTask={onToggleTask}>{children}</MarkdownRenderer>;
}

/** An AI's answer: text the AI wrote, so it is untrusted. Drawn with the published reading (`profile="published"`):
 *  inline HTML such as `<img onerror>` or `<script>` is shown as text and never becomes an element. [[links]]
 *  still resolve among `nodes` and go to `onNavigate`. */
export function AiAnswer({ children, nodes, onNavigate }: { children: string; nodes: WikilinkNode[]; onNavigate?: OpenLink }) {
  return <MarkdownRenderer nodes={nodes} onNavigate={onNavigate} profile="published" linkStyle="editor">{children}</MarkdownRenderer>;
}

/** A review card's back: the whole note drawn as text, math, diagrams and
 *  callouts included. It has no notes to resolve against, so a [[link]] shows
 *  its note name without the brackets (not clickable) and an ![[embed]] is not drawn. */
export function ReviewCard({ children }: { children: string }) {
  return <MarkdownRenderer>{linksAsNames(children)}</MarkdownRenderer>;
}

/** A note name drawn as plain words: its `*`, `_`, `$`… are not formatting. */
const escapeMarkdown = (text: string) => text.replace(/[\\`*_~$[\]<>|]/g, "\\$&");

/** `[[Note|alias]]` → the words a reader would see; the stored text is untouched. */
function linksAsNames(markdown: string): string {
  let out = markdown;
  for (const link of drawnWikilinks(markdown).reverse()) {
    if (markdown[link.start - 1] === "!") continue;
    out = out.slice(0, link.start) + escapeMarkdown(wikilinkLabel(link.body)) + out.slice(link.end);
  }
  return out;
}

/** A feed article: text not written in Onden, where `$5 to $10` is prices, not
 *  math. `resolveImage` makes its relative picture addresses absolute. */
export function ReaderArticle({ children, resolveImage }: { children: string; resolveImage: (src: string) => string }) {
  return <MarkdownRenderer math={false} resolveImage={resolveImage}>{readerHtmlAsOneBlock(children)}</MarkdownRenderer>;
}

/** A render function (markdown, fromId) → ReactNode for the website studio's
 *  previews, drawn as the published pages draw them; the pages themselves use
 *  siteFrame/siteMarkdown. */
export function makeMarkdownRenderer(
  nodes: Array<WikilinkNode & { query_blocks?: readonly FrozenQueryBlock[] }>,
  navigateTo: (id: string, blockId?: string, heading?: string) => void,
  resolveImage?: (src: string) => string,
): (markdown: string, fromId?: string | null) => ReactNode {
  // A body that names no page finds a block's frozen result on any page that
  // has that block.
  const everyBlock = nodes.flatMap((n) => n.query_blocks ?? []);
  // Not a component — a render callback (markdown string → ReactNode);
  // display-name doesn't apply.
  // eslint-disable-next-line react/display-name
  return (markdown: string, fromId?: string | null) => (
    <MarkdownRenderer
      nodes={nodes}
      // The page's own frozen query results (D113).
      queryBlocks={fromId ? nodes.find((n) => n.id === fromId)?.query_blocks ?? [] : everyBlock}
      // Forward the optional `^block-id` (W2 P2) / heading so the host can
      // scroll to it.
      onNavigate={(slug, nodeId, blockId, heading) => { if (nodeId) navigateTo(nodeId, blockId, heading); }}
      resolveImage={resolveImage}
      profile="published"
      linkStyle="published"
    >
      {markdown}
    </MarkdownRenderer>
  );
}
