import { blockCardSides, ellipsize, parseBlocks } from "@onden/markdown";
import { reviewSeam } from "../reviewSeam.js";

// When an agent marks a paragraph as a review card through the text-writing tools (createNode, updateNode, suggestEdit),
// the result says so if that card has no back by the card rules (packages/markdown blockCard.ts), so the agent can
// rewrite it in the same turn. Only agent tools call this; a person marking a paragraph in the editor is not told.
// Only the cards this text adds are named: a one-line card that was already in the note is not the agent's to fix.

const LABEL_MAX = 40;

/** The marked paragraphs of text that is not saved yet (so no anchors exist) that have no back, as what they read as.
 *  Each block gets a made-up anchor at its start, which is all blockCardSides needs to cut its two sides. */
function cardsWithoutBack(markdown: string, words: readonly string[]): string[] {
  const blocks = parseBlocks(markdown).filter((b) => b.tags.some((tag) => words.includes(tag.toLowerCase())));
  const anchors = blocks.map((b, i) => ({ id: `new${i}`, from: b.start }));
  return blocks.filter((_, i) => !blockCardSides(markdown, `new${i}`, anchors)?.back).map((b) => b.label);
}

/** One plain sentence for each card the text `after` has without a back and `before` did not. Empty when the review
 *  function is off, or every new card has its answer. */
export async function cardAdvice(workspaceId: string, before: string, after: string): Promise<string[]> {
  const words = (await reviewSeam()?.cardWords(workspaceId)) ?? [];
  if (!words.length) return [];
  const already = cardsWithoutBack(before, words);
  return cardsWithoutBack(after, words).filter((label) => {
    const at = already.indexOf(label);
    if (at === -1) return true;
    already.splice(at, 1);
    return false;
  }).map((label) =>
    `這張卡沒有答案：「${ellipsize(label, LABEL_MAX)}」。把答案縮排寫在問題下面，或用 ==挖空== 只標關鍵詞；寫成一行「問題 → 答案」不行。`);
}
