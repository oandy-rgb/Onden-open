import type { ReactNode } from "react";
import type { Snippet } from "@onden/markdown";

/**
 * A search snippet (@onden/markdown snippet.ts: plain text + highlight
 * ranges, from the server and from every local search alike). The ranges
 * become <mark> elements; the text is only ever text nodes, never parsed as
 * HTML, so a note containing `&`, `<` or markup (RSS, agents, imports) shows
 * exactly what it says.
 */
export function SnippetText({ snippet, markClassName }: { snippet: Snippet; markClassName?: string }) {
  const { text, ranges } = snippet;
  const out: ReactNode[] = [];
  let last = 0;
  for (const [start, end] of ranges) {
    // Ranges are sorted and disjoint by contract; a bad one is skipped rather
    // than repeating or reordering text.
    if (start < last || end <= start || end > text.length) continue;
    if (start > last) out.push(text.slice(last, start));
    out.push(<mark key={start} className={markClassName}>{text.slice(start, end)}</mark>);
    last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
