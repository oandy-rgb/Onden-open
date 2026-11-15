// A note's part links `[[筆記/段落開頭]]` in a file that leaves Onden (block-anchors-2026-11-01.md §10, single-note export).
// The link's meaning is a binding the file cannot carry, so each link is written as something a reader can follow
// without Onden. Three ways, chosen by the person exporting:
//   text      (default) `[[筆記]]：段落文字` — the note link and the words of the paragraph
//   footnote  the link becomes its words plus a footnote marker; the footnote holds the note's name and the paragraph's words
//   obsidian  `[[筆記#^id]]`; a paragraph of THIS note that is linked gets ` ^id` at its line end (Obsidian reads those)
// The exported file is not the source of truth: nothing here is written back. Which part a link means (and its words)
// is the caller's `resolve`; this file only writes text.

import { wikilinkSpans } from "./blockChild.js";
import { hasLinkPath } from "./text.js";
import { writeLegacyIds } from "./legacyBlockIds.js";
import { plainInline, stripLineMarker } from "./plainText.js";
import { withoutLineTrailers } from "./blockId.js";
import { plainExcerpt } from "./graphemes.js";

export type PartLinkExportMode = "text" | "footnote" | "obsidian";
export const PART_LINK_EXPORT_MODES: readonly PartLinkExportMode[] = ["text", "footnote", "obsidian"];

/** What `resolve` says about a part link: the note that holds the part and its title, the part's words in full, the
 *  anchor id when the link is bound to one (null: a link typed by hand, found by its words), and — only when the part
 *  is in the exported note itself — where it is in that note's text (for the Obsidian mark). */
export type ExportedPart = {
  noteTitle: string; text: string; anchorId: string | null;
  here?: { from: number; to: number };
};

/** How many characters of a paragraph an exported link or footnote carries. */
export const EXPORTED_PART_MAX = 300;

/** A part's words as one line of plain text (formatting, `{tags}` and ids cut), cut at EXPORTED_PART_MAX. */
export function partPlainText(raw: string): string {
  const words = raw.split("\n").map((l) => plainInline(stripLineMarker(withoutLineTrailers(l)).trim())).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return plainExcerpt(words, EXPORTED_PART_MAX);
}

/** The targets of the links of `markdown` that can be part links (`note/words`, `/words`), each once, in order. */
export function partLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const link of wikilinkSpans(markdown).reverse()) {
    const target = linkTarget(link.body);
    if (hasLinkPath(target) && !targets.includes(target)) targets.push(target);
  }
  return targets;
}

const linkTarget = (body: string): string => {
  const bar = body.indexOf("|");
  return (bar === -1 ? body : body.slice(0, bar)).trim();
};
const linkAlias = (body: string): string | null => {
  const bar = body.indexOf("|");
  return bar === -1 ? null : body.slice(bar + 1);
};

/** `markdown` with every part link `resolve` knows written for `mode`. A link it does not know stays as it is. */
export function exportPartLinks(
  markdown: string, mode: PartLinkExportMode, resolve: (target: string) => ExportedPart | null,
): { markdown: string; count: number } {
  const known = new Map<string, ExportedPart | null>();
  const part = (target: string): ExportedPart | null => {
    if (!known.has(target)) known.set(target, hasLinkPath(target) ? resolve(target) : null);
    return known.get(target)!;
  };
  let text = markdown;
  // Obsidian: this note's own linked paragraphs get the mark first (offsets are those of `markdown`); a paragraph the
  // mark cannot be shown for is written like `text`, never as a link to an id that stands nowhere.
  const marked = new Set<string>();
  if (mode === "obsidian") {
    const own = new Map<string, { id: string; from: number; to: number }>();
    for (const link of wikilinkSpans(markdown)) {
      const p = part(linkTarget(link.body));
      if (p?.anchorId && p.here) own.set(p.anchorId, { id: p.anchorId, ...p.here });
    }
    if (own.size > 0) {
      const written = writeLegacyIds(markdown, [...own.values()]);
      text = written.markdown;
      for (const id of written.written) marked.add(id);
    }
  }
  const footnotes: Array<{ label: string; line: string }> = [];
  const labelOf = new Map<string, string>();
  let count = 0;
  for (const link of wikilinkSpans(text)) {
    const target = linkTarget(link.body);
    const p = part(target);
    if (!p) continue;
    const alias = linkAlias(link.body);
    const ofNote = (shown: string | null) => `[[${p.noteTitle}${shown ? `|${shown}` : ""}]]`;
    const here = p.here !== undefined;
    let out: string;
    if (mode === "obsidian" && p.anchorId && (!here || marked.has(p.anchorId))) {
      out = `${link.embed ? "!" : ""}[[${p.noteTitle}#^${p.anchorId}${alias ? `|${alias}` : ""}]]`;
    } else if (mode === "footnote") {
      const key = `${p.noteTitle}\0${p.text}`;
      let label = labelOf.get(key);
      if (!label) {
        label = `part-${labelOf.size + 1}`;
        labelOf.set(key, label);
        footnotes.push({ label, line: `[^${label}]: ${p.noteTitle}：${p.text}` });
      }
      out = `${alias ?? `${p.noteTitle} › ${plainExcerpt(p.text, 20)}`}[^${label}]`;
    } else {
      out = `${ofNote(alias)}：${p.text}`;
    }
    text = text.slice(0, link.start) + out + text.slice(link.end);
    count++;
  }
  if (footnotes.length > 0) text = `${text.replace(/\s+$/, "")}\n\n${footnotes.map((f) => f.line).join("\n")}\n`;
  return { markdown: text, count };
}
