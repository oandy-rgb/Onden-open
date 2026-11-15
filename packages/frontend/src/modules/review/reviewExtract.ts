// 抓題 (⑥ composite learning flow): extract Q/A blocks from a lecture note
// into review-card payloads. Pure so the carve rule is unit-testable apart
// from the API orchestration.
//
// The convention is TEXT, not schema — agent-emits-text friendly: an agent
// (or a human) writes ordinary `Q:` / `A:` lines into the 講義 and extraction
// is mechanical from there. Rule:
//   • a line starting `Q:` (or full-width `Q：`, case-insensitive) opens a
//     question; following lines up to the `A:` line continue the question;
//   • the matching `A:`/`A：` line opens the answer, which runs until the
//     next Q-line, a markdown heading, a thematic break (---), or EOF;
//   • a Q with no A is skipped (a card with no back is not a card);
//   • fenced code blocks are opaque — `Q:` inside ``` is content, not a card.
// The lecture body is NOT rewritten (unlike split): the 講義 keeps its prose;
// cards are derived children that link back to it.

import { fenceScanner } from "@onden/markdown";

export type ExtractedCard = { question: string; answer: string };

const Q_RE = /^[Qq][:：]\s*(.*)$/;
const A_RE = /^[Aa][:：]\s*(.*)$/;
const HEADING_RE = /^#{1,6}\s/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})\s*$/;

export function extractReviewCards(markdown: string): ExtractedCard[] {
  const lines = markdown.split("\n");
  const cards: ExtractedCard[] = [];
  const fence = fenceScanner();
  let question: string[] | null = null;
  let answer: string[] | null = null;

  const flush = () => {
    if (question && answer) {
      const q = question.join(" ").replace(/\s+/g, " ").trim();
      const a = answer.join("\n").trim();
      if (q && a) cards.push({ question: q, answer: a });
    }
    question = null;
    answer = null;
  };

  for (const raw of lines) {
    const line = raw;
    if (fence(line) !== "outside") {
      if (answer) answer.push(line); // fences inside an answer stay verbatim
      continue;
    }
    const qm = line.match(Q_RE);
    if (qm) {
      flush();
      question = [qm[1]];
      continue;
    }
    if (HEADING_RE.test(line) || HR_RE.test(line)) {
      flush();
      continue;
    }
    const am = line.match(A_RE);
    if (am && question && !answer) {
      answer = [am[1]];
      continue;
    }
    if (answer) {
      answer.push(line);
    } else if (question && line.trim()) {
      question.push(line.trim()); // multi-line question, up to its A:
    }
    // blank lines between Q and A are neutral; an orphan Q (no A before the
    // next terminator) is dropped by flush()
  }
  flush();
  return cards;
}

/** The card's body: the answer plus a wikilink back to the lecture it came
 *  from — review in the panel, click through to the source context. */
export function cardBody(card: ExtractedCard, lectureTitle: string): string {
  return lectureTitle ? `${card.answer}\n\n— [[${lectureTitle}]]\n` : `${card.answer}\n`;
}

// 立體化: when the lecture sits on a board, its cards land NEXT TO it — a
// two-column grid to the right of the anchor card. Pure layout planning so
// the geometry is testable apart from the GET→PATCH orchestration.

export type PlacementEntry = { nodeId: string; x: number; y: number; width?: number };

const CARD_W = 240;
const GRID_DX = 280; // column pitch (card width + gutter)
const GRID_DY = 150;
const ANCHOR_GAP = 80;

export function planCardPlacements(
  existing: PlacementEntry[],
  anchorId: string,
  cardIds: string[],
): PlacementEntry[] {
  const placed = new Set(existing.map((e) => e.nodeId));
  const fresh = cardIds.filter((id) => !placed.has(id));
  const anchor = existing.find((e) => e.nodeId === anchorId);
  const baseX = (anchor?.x ?? 80) + (anchor?.width ?? CARD_W) + ANCHOR_GAP;
  const baseY = anchor?.y ?? 80;
  return fresh.map((nodeId, i) => ({
    nodeId,
    x: baseX + (i % 2) * GRID_DX,
    y: baseY + Math.floor(i / 2) * GRID_DY,
    width: CARD_W,
  }));
}
