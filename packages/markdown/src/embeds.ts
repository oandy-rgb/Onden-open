// `![[…]]` embeds: the grammar every surface reads them with. Obsidian writes
// `![[name]]` to show a note, a block (`![[name#^id]]`), an image or a
// drawing in place. Onden renders drawings (handwriting notes, Obsidian
// Excalidraw imports) and shows notes, headings and blocks in place (the app
// only: the published site links them).
//
// Who does what:
//   - here: finding embeds in text (the editor's widgets, the server's
//     publish pass) and, in the Markdown pipeline (`embeds: true`), turning
//     each into an image node whose src is the `#embed:` sentinel, which the
//     app's renderer swaps for the embed (react-markdown `img`);
//   - the app (frontend lib/embeds.ts): which note an embed names and what
//     kind it is — one resolver, a renderer per kind;
//   - the server (backend modules/website/publishing/drawingEmbeds.ts): on the
//     published site an embedded drawing becomes a picture, an embed of a
//     note that isn't published an inert placeholder.
//
// The `!` is outside the link: CommonMark reads `![` as the start of an image,
// so `![[x]]` never reaches remark-wiki-link and stays text until this runs.

import { INK_REGION_PLAIN_NAME, scanWikilinks } from "./text.js";
import { BLOCK_ID_PATTERN } from "./blockId.js";
import { parseInkRegion, type InkRegion } from "./inkRegion.js";
import { nodeRefId } from "./nodeRef.js";

/** What an embed shows. The app draws "drawing", and "note" / "block" as the
 *  source's text (embedExtract.ts cuts it; a `#Heading` is a note embed with a
 *  heading); the published site links them. "image" (an unconverted
 *  `![[file.png]]`) is the kind the resolver can still grow into. */
export type EmbedKind = "drawing" | "image" | "note" | "block";

/** One `![[body]]` as written: the note part, the `#^block` id or the
 *  `#Heading` (never both), and the `|label` the author gave (null when none). `inkRegion`: the `|` part named a region of a
 *  handwriting page (inkRegion.ts) instead of a label. */
export type EmbedRef = { body: string; target: string; blockId: string | null; heading: string | null; label: string | null; inkRegion: InkRegion | null };

/** One embed in a text: the span from `!` to `]]` and what it names. */
export type EmbedMatch = EmbedRef & { start: number; end: number };

// The one `^id` grammar (blockId.ts); which block an embed shows is its anchor's (embedExtract.ts).
const BLOCK_ID = new RegExp(`#\\^(${BLOCK_ID_PATTERN})$`);

/** Read an embed body (the text between `![[` and `]]`). */
export function parseEmbed(body: string): EmbedRef {
  const bar = body.indexOf("|");
  const link = bar === -1 ? body : body.slice(0, bar);
  const written = bar === -1 ? null : body.slice(bar + 1).trim() || null;
  const inkRegion = written === null ? null : parseInkRegion(written);
  const label = inkRegion ? null : written;
  const block = BLOCK_ID.exec(link);
  const [name = "", ...anchor] = (block ? link.slice(0, block.index) : link).split("#");
  const heading = block ? null : anchor.join("#").trim() || null;
  return { body, target: name.trim(), blockId: block ? block[1]! : null, heading, label, inkRegion };
}

/** Every `![[…]]` in `text`, in order (linear: scanWikilinks). */
export function embedMatches(text: string): EmbedMatch[] {
  if (!text.includes("![[")) return [];
  return scanWikilinks(text, (_body, start) => start > 0 && text[start - 1] === "!")
    .map((m) => ({ ...parseEmbed(m.body), start: m.start - 1, end: m.end }));
}

/** `text` with the `!` and the `|ink=…` part of every quoted-area embed turned into spaces (offsets stay): what a
 *  plain-text reading of an embed that was not drawn as a link sees is then the note's name alone. Linear: the spans
 *  come from embedMatches (scanWikilinks), nothing here looks back. */
export function blankInkRegionSyntax(text: string): string {
  if (!text.includes("|ink=")) return text;
  let out = "", last = 0;
  for (const m of embedMatches(text)) {
    if (!m.inkRegion) continue;
    const bar = text.indexOf("|", m.start + 3);
    if (bar === -1 || bar >= m.end - 2) continue;
    out += text.slice(last, m.start) + " " + text.slice(m.start + 1, bar) + " ".repeat(m.end - 2 - bar);
    last = m.end - 2;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** The embed a line consists of (surrounding spaces allowed), or null. The
 *  editor shows such a line as the embed itself. */
export function embedLine(line: string): EmbedRef | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("![[") || !trimmed.endsWith("]]")) return null;
  const [only] = embedMatches(trimmed);
  return only && only.start === 0 && only.end === trimmed.length ? parseEmbed(only.body) : null;
}

/** The text an embed shows when it isn't rendered: its label, else the name
 *  without Obsidian's `.excalidraw` suffix. */
export function embedLabel(ref: EmbedRef): string {
  // A quoted area of a note named by id has no words of its own to show (the app uses the note's title).
  if (ref.inkRegion && !ref.label && nodeRefId(ref.target)) return INK_REGION_PLAIN_NAME;
  return ref.label ?? (ref.target.replace(/\.excalidraw$/i, "") || ref.body);
}

/** The src sentinel an embed's image node carries through sanitize. */
export const EMBED_SRC_PREFIX = "#embed:";

/** The embed body an `#embed:` src names, or null for any other src. */
export function embedBodyOfSrc(src: string | null | undefined): string | null {
  if (!src?.startsWith(EMBED_SRC_PREFIX)) return null;
  try { return decodeURIComponent(src.slice(EMBED_SRC_PREFIX.length)); } catch { return null; }
}
