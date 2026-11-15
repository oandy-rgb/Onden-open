// A small HTML5 tokenizer for tests that must judge cleaned HTML the way a browser reads it,
// not the way the cleaner's own regular expressions do. It is the first stage of the HTML
// parsing algorithm and nothing more: start and end tags (names lower-cased, attribute values
// with character references decoded), comments, and text. `<script>` and `<style>` are read
// as raw text up to their end tag, as a browser does, so an UNCLOSED `<script>` swallows the
// rest of the document. No tree building, no implied tags.

import { decodeHtmlEntities } from "@onden/markdown";

export type HtmlToken =
  | { type: "start"; name: string; attrs: Array<{ name: string; value: string }>; selfClosing: boolean }
  | { type: "end"; name: string }
  | { type: "text"; text: string; raw: boolean }
  | { type: "comment" };

const isSpace = (ch: string | undefined) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
const isLetter = (ch: string | undefined) => ch !== undefined && /[A-Za-z]/.test(ch);
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"]);

export function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let i = 0;
  let text = "";
  const flush = () => { if (text) { tokens.push({ type: "text", text: decodeHtmlEntities(text), raw: false }); text = ""; } };
  while (i < html.length) {
    const ch = html[i]!;
    if (ch !== "<") { text += ch; i++; continue; }
    const next = html[i + 1];
    if (html.startsWith("<!--", i)) {
      flush();
      const end = html.indexOf("-->", i + 4);
      tokens.push({ type: "comment" });
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (next === "!" || next === "?") {
      flush();
      const end = html.indexOf(">", i);
      tokens.push({ type: "comment" });
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (next === "/" && isLetter(html[i + 2])) {
      flush();
      let j = i + 2;
      let name = "";
      while (j < html.length && !isSpace(html[j]) && html[j] !== "/" && html[j] !== ">") name += html[j++];
      const end = html.indexOf(">", j);
      tokens.push({ type: "end", name: name.toLowerCase() });
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (!isLetter(next)) { text += ch; i++; continue; }
    flush();
    let j = i + 1;
    let name = "";
    while (j < html.length && !isSpace(html[j]) && html[j] !== "/" && html[j] !== ">") name += html[j++];
    const attrs: Array<{ name: string; value: string }> = [];
    let selfClosing = false;
    for (;;) {
      while (j < html.length && (isSpace(html[j]) || html[j] === "/")) { selfClosing = html[j] === "/" && html[j + 1] === ">"; j++; }
      if (j >= html.length) break;
      if (html[j] === ">") { j++; break; }
      let attr = html[j++]!;
      while (j < html.length && !isSpace(html[j]) && html[j] !== "/" && html[j] !== ">" && html[j] !== "=") attr += html[j++];
      while (isSpace(html[j])) j++;
      let value = "";
      if (html[j] === "=") {
        j++;
        while (isSpace(html[j])) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, j + 1);
          value = html.slice(j + 1, end < 0 ? html.length : end);
          j = end < 0 ? html.length : end + 1;
        } else {
          const from = j;
          while (j < html.length && !isSpace(html[j]) && html[j] !== ">") j++;
          value = html.slice(from, j);
        }
      }
      attrs.push({ name: attr.toLowerCase(), value: decodeHtmlEntities(value) });
    }
    const lower = name.toLowerCase();
    tokens.push({ type: "start", name: lower, attrs, selfClosing });
    i = j;
    if (RAW_TEXT.has(lower) && !selfClosing) {
      const close = new RegExp(`</${lower}[\\s/>]`, "i").exec(html.slice(i));
      const end = close ? i + close.index : html.length;
      if (end > i) tokens.push({ type: "text", text: html.slice(i, end), raw: true });
      i = end;
    }
  }
  flush();
  return tokens;
}

/** What a reader sees: text outside raw-text elements and comments, whitespace collapsed. */
export function visibleText(html: string): string {
  return tokenizeHtml(html).flatMap((t) => (t.type === "text" && !t.raw ? [t.text] : [])).join("").replace(/\s+/g, " ").trim();
}

/** A URL attribute value as a browser reads its scheme: tabs and line breaks anywhere, and leading controls and spaces, are dropped. */
export function urlSchemeOf(value: string): string {
  const cleaned = value.replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+/, "").toLowerCase();
  const colon = cleaned.indexOf(":");
  return colon > 0 && /^[a-z][a-z0-9+.-]*$/.test(cleaned.slice(0, colon)) ? cleaned.slice(0, colon) : "";
}
