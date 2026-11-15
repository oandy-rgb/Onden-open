// A published handwriting note draws its pages as images after its text. A page
// is marked by the fragment of its address, `…/<file>.svg#ink-page-N`: the one
// stable mark the server writes (modules/website/publishing/handwritingPages.ts),
// the site's renderer reads to draw a sheet full width and give it an alt in the
// site's language (frontend MarkdownRenderer), and the feed reads to keep the
// first page only (frontend pages/site/_siteFeedBody). The alt is not written
// here: a word of a language would be wrong on a site of another one, and a
// user's own image whose alt happened to begin the same way would be mistaken
// for a page. (mediaRefs reads the file id and leaves the fragment in place.)
//
// A page is a reference-style image, `![][ink-page-N]` with its
// `[ink-page-N]: <address>#ink-page-N` block, not an inline one: the note's own
// picture (@onden/markdown firstImage: the article cover, a card image, the
// share image) is an inline or <img> image in its text, and a sheet of
// handwriting is its body, not its picture. Reading it as a cover would pull
// the sheet out of the body.

const MARK = "#ink-page-";

/** Page `number` at `address` (a media address): the image, then its address in
 *  a block of its own (a definition cannot continue a paragraph). */
export const handwritingPageMarkdown = (number: number, address: string): string =>
  `![][ink-page-${number}]\n\n[ink-page-${number}]: ${address}${MARK}${number}`;

/** The page number an image address marks as a handwriting page, else null. */
export function handwritingPageNumber(src: string | undefined): number | null {
  const at = src?.lastIndexOf(MARK) ?? -1;
  if (!src || at < 0) return null;
  const digits = src.slice(at + MARK.length);
  return /^\d{1,4}$/.test(digits) ? Number(digits) : null;
}

const PAGE_LINE = /^(?:[ \t]*!\[\]\[ink-page-(\d{1,4})\][ \t]*|\[ink-page-(\d{1,4})\]: \S+[ \t]*)$/gm;

/** `markdown` without the handwriting pages numbered above `keep` (default: all
 *  of them). The feed carries one picture per note (`keep` 1). */
export function withoutHandwritingPages(markdown: string, keep = 0): string {
  if (!markdown.includes("[ink-page-")) return markdown;
  return markdown
    .replace(PAGE_LINE, (line, image: string | undefined, definition: string | undefined) => (Number(image ?? definition) > keep ? "" : line))
    .replace(/\n{3,}/g, "\n\n").trimEnd();
}
