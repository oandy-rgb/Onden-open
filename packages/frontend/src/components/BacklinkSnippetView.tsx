// The prose around a link, with the link itself marked: the line a backlink
// card shows under the note's title (the note's relations, the journal's 「提到這天的」).

import { plainAroundSpan, wikilinkLabel } from "@onden/markdown";
import type { BacklinkSnippet } from "../lib/backlinks";
import { useAllNodes } from "../lib/appStore";
import { usePartLinks } from "../lib/partLinkModule";
import { SnippetText } from "./SnippetText";

export function BacklinkSnippetView({ snippet }: { snippet: BacklinkSnippet }) {
  const nodes = useAllNodes();
  const partLinks = usePartLinks(snippet.text);
  // The excerpt is raw Markdown around the link; a reader sees its words, not `## ` / `{task}` / `[[`.
  // A link to a paragraph reads 「筆記 › 開頭」, as it does in the editor and the reading view (lib/blockLinks).
  const reading = { nodes, from: snippet.source ?? null };
  const labelOf = (body: string) => (partLinks && (partLinks.partLinkWords(body, reading) ?? partLinks.legacyBlockWords(body, reading))) || wikilinkLabel(body);
  const plain = plainAroundSpan(snippet.text, snippet.linkStart, snippet.linkEnd, !snippet.truncatedStart, labelOf);
  return (
    <span className="backlink-card-snippet">
      {snippet.truncatedStart && <span className="backlink-card-ellipsis">…</span>}
      <SnippetText snippet={{ text: plain.text, ranges: [plain.range] }} markClassName="backlink-card-match" />
      {snippet.truncatedEnd && <span className="backlink-card-ellipsis">…</span>}
    </span>
  );
}
