// Whether a feed item's text is only a summary, so the reader loads the full
// article by itself (載入全文, POST /api/rss/items/:id/fulltext). A feed that
// gives only a description sends a short teaser, often ending in "…" or a
// "read more" link; a feed that carries the article sends much more.

/** Below this many characters of text an item reads as a summary. */
const SUMMARY_MAX_CHARS = 600;

const TEASER_END = /(…|\.\.\.|\[…\]|\[\.\.\.\]|read more|continue reading|繼續閱讀|閱讀全文|閱讀更多|更多內容)\s*[»›→]?\s*$/i;

/** The item's HTML as plain text (tags dropped, entities left as they are —
 *  only the length and the ending matter here). */
function plainText(html: string): string {
  return html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** True when `html` looks like a feed's summary rather than the article:
 *  short, or ending in a "…" / "read more" teaser. Empty counts as a summary. */
export function looksLikeSummary(html: string): boolean {
  const text = plainText(html);
  return text.length < SUMMARY_MAX_CHARS || TEASER_END.test(text);
}
