// The Markdown body of a bookmark note. The title, description and image
// address come from a remote page, so none of them may add structure to the
// user's note: text is one line with Markdown punctuation escaped, and an
// address must be http(s) with its parentheses encoded.

/** One line, whitespace collapsed (an og:description may carry line breaks). */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** `text` as plain inline Markdown text: nothing in it can start a link,
 *  image, wikilink, emphasis, HTML or math. */
export function escapeMarkdownText(text: string): string {
  return oneLine(text).replace(/[\\`*_{}[\]()<>#+!|~$&]/g, "\\$&");
}

/** A link destination that cannot end early or carry spaces; null unless it is http(s). */
export function safeHttpDestination(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  } catch {
    return null;
  }
}

export function bookmarkMarkdown({ title, description, imageUrl, url }: {
  title: string; description: string; imageUrl: string | null; url: string;
}): string {
  const image = imageUrl ? safeHttpDestination(imageUrl) : null;
  const target = safeHttpDestination(url) ?? "#";
  const summary = escapeMarkdownText(description);
  return [
    image ? `![](${image})` : "",
    summary ? `> ${summary}` : "",
    `[${escapeMarkdownText(title) || "link"}](${target})`,
  ].filter(Boolean).join("\n\n") + "\n";
}
