// A feed article is HTML, and the reader draws it through the Markdown
// renderer's html path. Markdown ends a block of HTML at the first blank line
// and reads the indented lines after it as a code block, so a page with blank
// lines between its tags showed its own markup as code. Given as one block of
// HTML with no blank line in it, none of it is read as Markdown.

/** `body` for the renderer: HTML becomes a single HTML block; text with no tag in it is left alone. */
export function readerHtmlAsOneBlock(body: string): string {
  if (!/<\/?[a-z][^>]*>/i.test(body)) return body;
  const flat = body
    .replace(/\r/g, "")
    // A blank line inside <pre> is content: keep every line break there as a character reference.
    .replace(/<pre\b[\s\S]*?<\/pre\s*>/gi, (pre) => pre.replace(/\n/g, "&#10;"))
    .replace(/\n[ \t]*(?=\n)/g, "")
    .trim();
  return `<div>\n${flat}\n</div>`;
}
