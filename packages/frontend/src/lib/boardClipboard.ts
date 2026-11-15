// 白板的剪貼簿：複製的是「卡片（筆記）＋它們之間的連線＋筆跡」，純資料與純函式，沒有畫面。
// 流程（hooks/useBoardClipboard）：複製時取一份 BoardClip 存在記憶體，並把卡片的標題與內文
// 以純文字寫進系統剪貼簿；貼上時若系統剪貼簿裡還是我們寫的那份就貼 BoardClip，
// 否則當成從別處複製來的純文字（建一張新卡片）。不把自訂格式寫進系統剪貼簿。

import { ellipsize, stripLineMarker } from "@onden/markdown";
import type { CanvasNodeEntry, ContentNode, NodeEdge } from "./api";
import { edgeRole } from "./edgeKinds";
import { t } from "./i18n";
import { inkClipBounds, isEmptyInkClip, type InkClip } from "./ink";
import { displayTitle } from "./noteLabel";

export type ClipCard = { nodeId: string; x: number; y: number; width?: number; title: string; markdown: string };
export type BoardClip = {
  cards: ClipCard[];
  /** Hand-drawn arrows with BOTH ends among `cards` (by their original note ids). */
  links: Array<{ source: string; target: string }>;
  ink: InkClip | null;
};

/** 複製一份：貼回原位偏移這麼多（board 單位）。 */
export const DUPLICATE_OFFSET = 32;

export const isEmptyBoardClip = (clip: BoardClip): boolean => clip.cards.length === 0 && isEmptyInkClip(clip.ink);

/** The clip for `cardIds` (cards on the board, in board order) plus the selected ink. */
export function buildBoardClip(input: {
  cardIds: readonly string[];
  cards: readonly CanvasNodeEntry[];
  notes: readonly ContentNode[];
  edges: readonly NodeEdge[];
  ink: InkClip | null;
}): BoardClip {
  const wanted = new Set(input.cardIds);
  const cards: ClipCard[] = [];
  for (const card of input.cards) {
    const note = wanted.has(card.nodeId) ? input.notes.find((n) => n.id === card.nodeId) : undefined;
    if (!note) continue;
    cards.push({ nodeId: card.nodeId, x: card.x, y: card.y, ...(card.width ? { width: card.width } : {}), title: note.title, markdown: note.markdown ?? "" });
  }
  const copied = new Set(cards.map((c) => c.nodeId));
  const seen = new Set<string>();
  const links: BoardClip["links"] = [];
  for (const edge of input.edges) {
    if (edge.edge_type !== "knowledge_link" || edgeRole(edge) !== "manual") continue;
    if (!copied.has(edge.source_node_id) || !copied.has(edge.target_node_id)) continue;
    const key = `${edge.source_node_id}>${edge.target_node_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: edge.source_node_id, target: edge.target_node_id });
  }
  return { cards, links, ink: isEmptyInkClip(input.ink) ? null : input.ink };
}

/** Where the clip's top-left corner is now: the cards' and the ink's together. */
export function clipOrigin(clip: BoardClip): { x: number; y: number } {
  const xs = clip.cards.map((c) => c.x), ys = clip.cards.map((c) => c.y);
  const ink = clip.ink && inkClipBounds(clip.ink);
  if (ink) { xs.push(ink.x1); ys.push(ink.y1); }
  return { x: Math.min(...xs), y: Math.min(...ys) };
}

/** How far to move the clip so its top-left corner lands on `anchor`; relative positions stay. */
export function shiftToAnchor(clip: BoardClip, anchor: { x: number; y: number }): { dx: number; dy: number } {
  const origin = clipOrigin(clip);
  return { dx: Math.round(anchor.x - origin.x), dy: Math.round(anchor.y - origin.y) };
}

/** The plain text a copy puts on the system clipboard: each card as a Markdown section. */
export function clipText(clip: BoardClip): string {
  if (clip.cards.length === 0) return t("Handwriting");
  return clip.cards
    .map((card) => {
      const body = card.markdown.trim();
      return `# ${displayTitle(card.title)}${body ? `\n\n${body}` : ""}`;
    })
    .join("\n\n");
}

const normalize = (text: string) => text.replace(/\r\n?/g, "\n").trim();

// 目前這個分頁複製的那份。記憶體而已：重新整理就沒了，貼上會退回系統剪貼簿的文字。
let held: { clip: BoardClip; text: string } | null = null;

/** Keep `clip` as this tab's board clipboard; returns the text to put on the system clipboard. */
export function holdBoardClip(clip: BoardClip): string {
  const text = clipText(clip);
  held = { clip, text };
  return text;
}

/** The held clip, only while the system clipboard still holds what we wrote there. */
export function heldBoardClip(systemText: string): BoardClip | null {
  return held && normalize(held.text) === normalize(systemText) ? held.clip : null;
}

/** A first line longer than this (UTF-16 units) is a pasted paragraph, not a title. */
const PASTED_TITLE_MAX = 80;

/** Text copied elsewhere → a card: the first line is the title, the rest the body. A first line too
 *  long to be a title (a paragraph without a line break) gives a short title and stays whole in the
 *  body, so none of the pasted text is lost. */
export function cardFromText(text: string): { title: string; markdown: string } | null {
  const lines = normalize(text).split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first < 0) return null;
  // A heading hash or list bullet in front of the first line is not part of the title.
  const title = stripLineMarker(lines[first]!.trim()).trim();
  if (!title) return null;
  if (title.length > PASTED_TITLE_MAX) {
    return { title: ellipsize(title, PASTED_TITLE_MAX), markdown: lines.slice(first).join("\n").trim() };
  }
  return { title, markdown: lines.slice(first + 1).join("\n").trim() };
}

// 手機的「複製一份」在選取列的 ⋯ 選單（ContextMenu），選單不在白板元件樹裡：
// 白板登記自己怎麼複製一張卡片，選單用 duplicateCardOnBoard 呼叫；沒有白板開著就是沒有選項。
let duplicateOnBoard: ((nodeId: string) => void) | null = null;
export function registerBoardDuplicate(handler: ((nodeId: string) => void) | null): () => void {
  duplicateOnBoard = handler;
  return () => { if (duplicateOnBoard === handler) duplicateOnBoard = null; };
}
export const canDuplicateOnBoard = (): boolean => duplicateOnBoard !== null;
export function duplicateCardOnBoard(nodeId: string): void { duplicateOnBoard?.(nodeId); }
