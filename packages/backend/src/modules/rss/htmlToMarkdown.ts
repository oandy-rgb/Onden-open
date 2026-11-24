// Feed / article HTML → Markdown for a saved note — pure, DB-free.
//
// A saved article becomes an ordinary note that people edit in the Markdown
// editor, so its body has to be Markdown, not the reader's HTML. Feed bodies
// are already sanitized (sanitize.ts) and use a small, regular subset of
// HTML, so a tolerant tokenizer + tree walk covers them without a parser
// dependency. Anything unrecognised keeps its text and loses its markup.

import { isHttpUrl } from "@onden/markdown";
import { endWithoutUnfinishedTag } from "./sanitize.js";

type El = { tag: string; attrs: Record<string, string>; children: Node[] };
type Node = El | string;

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "source", "wbr", "col", "area"]);
const BLOCK = new Set([
  "p", "div", "section", "article", "main", "header", "footer", "figure", "figcaption",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "hr", "table",
  "thead", "tbody", "tfoot", "tr", "dl", "dt", "dd", "details", "summary", "aside", "nav",
]);
const DROP = new Set(["script", "style", "noscript", "template", "button", "svg", "head"]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s"'=<>\/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? "");
  return attrs;
}

/** "<!--" after the page's last "-->" (and "<![CDATA[", in any case as the parser reads it, after the last "]]>") can never end: written as text before parsing,
 *  so the parser does not search from each one to the end of the page (it read them as text already). */
function openersThatNeverEnd(html: string, open: RegExp, close: string): string {
  const last = html.lastIndexOf(close);
  const from = last < 0 ? 0 : last + close.length;
  return html.slice(0, from) + html.slice(from).replace(open, (opener) => `&lt;${opener.slice(1)}`);
}

function parse(page: string): El {
  // Linear on unfinished markup: sanitize.ts endWithoutUnfinishedTag, and the comments and CDATA that never end.
  const html = openersThatNeverEnd(openersThatNeverEnd(endWithoutUnfinishedTag(page), /<!--/g, "-->"), /<!\[CDATA\[/gi, "]]>");
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const stack: El[] = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!doctype[^>]*>|<\s*(\/)?\s*([a-zA-Z][\w:-]*)([^>]*?)(\/)?\s*>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  const top = () => stack[stack.length - 1];
  while ((m = re.exec(html))) {
    if (m.index > last) top().children.push(html.slice(last, m.index));
    last = re.lastIndex;
    if (!m[2]) continue; // comment, CDATA, doctype
    const tag = m[2].toLowerCase();
    if (m[1]) {
      // Close the nearest open element with this name; ignore strays.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const el: El = { tag, attrs: parseAttrs(m[3]), children: [] };
    // A new <li>/<p> closes an unclosed sibling of the same kind.
    if ((tag === "li" || tag === "p") && top().tag === tag) stack.pop();
    top().children.push(el);
    if (!VOID.has(tag) && !m[4]) stack.push(el);
  }
  if (last < html.length) top().children.push(html.slice(last));
  return root;
}

function textOf(node: Node): string {
  return typeof node === "string" ? decodeEntities(node) : node.children.map(textOf).join("");
}

function escapeInline(text: string): string {
  // Escape only what would become markup; the note is edited as source, so
  // every backslash shows. Intraword underscores (snake_case) are inert.
  return text
    .replace(/([*`])/g, "\\$1")
    .replace(/(^|[^\p{L}\p{N}])_|_(?=$|[^\p{L}\p{N}])/gu, (m) => m.replace("_", "\\_"))
    .replace(/\[\[/g, "\\[\\[");
}

/** A paragraph that starts like a heading, quote or list item stays text. */
function escapeLineStart(text: string): string {
  return text.replace(/^([#>+-]|\d+[.)])(\s)/, "\\$1$2");
}

/** `base`: the article's url — a relative link or image is the article's, not ours. */
type Ctx = { listDepth: number; base?: string };

function absolute(url: string, ctx: Ctx): string {
  if (!ctx.base || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return url;
  try { return new URL(url, ctx.base).href; } catch { return url; }
}

function inline(nodes: Node[], ctx: Ctx): string {
  return nodes.map((n) => inlineNode(n, ctx)).join("");
}

function inlineNode(node: Node, ctx: Ctx): string {
  if (typeof node === "string") return escapeInline(decodeEntities(node).replace(/\s+/g, " "));
  const { tag, attrs, children } = node;
  if (DROP.has(tag)) return "";
  if (BLOCK.has(tag)) return ` ${blocks(children, ctx).trim().replace(/\n+/g, " ")} `;
  switch (tag) {
    case "br": return "  \n";
    case "strong": case "b": return wrap("**", inline(children, ctx));
    case "em": case "i": case "cite": return wrap("*", inline(children, ctx));
    case "del": case "s": case "strike": return wrap("~~", inline(children, ctx));
    case "code": case "kbd": case "samp": {
      const code = textOf(node).replace(/\s+/g, " ");
      if (!code.trim()) return "";
      const fence = code.includes("`") ? "``" : "`";
      return `${fence}${code}${fence}`;
    }
    case "a": {
      const label = inline(children, ctx).trim();
      const href = absolute(attrs.href ?? "", ctx);
      if (!href || href.startsWith("#")) return label;
      if (!label) return `<${href}>`;
      return `[${label}](${href.replace(/\)/g, "%29").replace(/ /g, "%20")})`;
    }
    case "img": {
      const src = absolute(attrs.src ?? "", ctx);
      if (!src || src.startsWith("data:image/gif")) return "";
      return `![${(attrs.alt ?? "").replace(/[[\]]/g, "")}](${src.replace(/\)/g, "%29").replace(/ /g, "%20")})`;
    }
    case "sup": return `^${inline(children, ctx)}`;
    case "audio": case "video": return mediaTag(node, ctx);
    default: return inline(children, ctx);
  }
}

/** A podcast or clip stays playable in the saved note: the note's Markdown
 *  keeps <audio>/<video> (PUBLISHED_HTML_TAGS), with the file from `src` or
 *  the first <source>, made absolute. No file → nothing. */
function mediaTag(el: El, ctx: Ctx): string {
  const source = el.children.find((child): child is El => typeof child !== "string" && child.tag === "source" && !!child.attrs.src);
  const raw = (el.attrs.src || source?.attrs.src || "").trim();
  const src = raw ? absolute(raw, ctx) : "";
  if (!isHttpUrl(src)) return "";
  return `<${el.tag} controls src="${src.replace(/"/g, "%22")}"></${el.tag}>`;
}

function wrap(mark: string, text: string): string {
  const core = text.trim();
  if (!core) return text;
  const lead = text.match(/^\s*/)?.[0] ?? "";
  const tail = text.match(/\s*$/)?.[0] ?? "";
  return `${lead}${mark}${core}${mark}${tail}`;
}

function codeLanguage(el: El): string {
  const code = el.children.find((c): c is El => typeof c !== "string" && c.tag === "code");
  const sources = [el.attrs["data-lang"], code?.attrs["data-lang"], el.attrs.class, code?.attrs.class];
  for (const s of sources) {
    if (!s) continue;
    const lang = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(s)?.[1] ?? (/^[\w+#-]+$/.test(s) ? s : undefined);
    if (lang) return lang;
  }
  return "";
}

function table(el: El, ctx: Ctx): string {
  const rows: El[] = [];
  const collect = (n: El) => {
    for (const c of n.children) {
      if (typeof c === "string") continue;
      if (c.tag === "tr") rows.push(c); else if (["thead", "tbody", "tfoot"].includes(c.tag)) collect(c);
    }
  };
  collect(el);
  if (rows.length === 0) return "";
  const cells = rows.map((r) => r.children
    .filter((c): c is El => typeof c !== "string" && (c.tag === "td" || c.tag === "th"))
    .map((c) => inline(c.children, ctx).trim().replace(/\|/g, "\\|").replace(/\n+/g, " ")));
  const width = Math.max(...cells.map((r) => r.length));
  if (width === 0) return "";
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(cells[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...cells.slice(1).map(line)].join("\n");
}

function list(el: El, ctx: Ctx): string {
  const ordered = el.tag === "ol";
  let n = Number.parseInt(el.attrs.start ?? "1", 10) || 1;
  const indent = "   ".repeat(ctx.listDepth);
  const items: string[] = [];
  for (const c of el.children) {
    if (typeof c === "string" || c.tag !== "li") {
      // Text or stray elements directly inside a list: keep them as an item.
      const stray = typeof c === "string" ? textOf(c).trim() : blocks([c], ctx).trim();
      if (stray) items.push(`${indent}- ${stray}`);
      continue;
    }
    const marker = ordered ? `${n++}.` : "-";
    // A tight item (no <p>) keeps its nested list on the next line.
    const tight = !c.children.some((ch) => typeof ch !== "string" && ch.tag === "p");
    const body = blocks(c.children, { ...ctx, listDepth: ctx.listDepth + 1 }, tight ? "\n" : "\n\n").trim();
    const [first = "", ...rest] = body.split("\n");
    const pad = " ".repeat(marker.length + 1);
    const restLines = rest.map((l) => (l.startsWith(indent + "   ") || !l.trim() ? l : `${indent}${pad}${l}`));
    items.push([`${indent}${marker} ${first}`, ...restLines].join("\n"));
  }
  return items.join("\n");
}

function blocks(nodes: Node[], ctx: Ctx, separator = "\n\n"): string {
  const out: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    const text = escapeLineStart(inline(run, ctx).replace(/[ \t]+\n/g, "  \n").replace(/[ \t]{2,}(?=\S)/g, " ").trim());
    if (text) out.push(text);
    run = [];
  };
  for (const node of nodes) {
    if (typeof node === "string" || !BLOCK.has(node.tag) || DROP.has(node.tag)) {
      if (typeof node !== "string" && DROP.has(node.tag)) continue;
      run.push(node);
      continue;
    }
    flush();
    const block = blockNode(node, ctx);
    if (block.trim()) out.push(block);
  }
  flush();
  return out.join(separator);
}

function blockNode(el: El, ctx: Ctx): string {
  const { tag, children } = el;
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) {
    const text = inline(children, ctx).trim().replace(/\s+/g, " ");
    return text ? `${"#".repeat(Number(heading[1]))} ${text}` : "";
  }
  switch (tag) {
    case "ul": case "ol": return list(el, ctx);
    case "li": return list({ tag: "ul", attrs: {}, children: [el] }, ctx);
    case "blockquote": {
      const body = blocks(children, ctx).trim();
      return body ? body.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n") : "";
    }
    case "pre": {
      const code = textOf(el).replace(/\n$/, "");
      const fence = code.includes("```") ? "````" : "```";
      return `${fence}${codeLanguage(el)}\n${code}\n${fence}`;
    }
    case "hr": return "---";
    case "table": return table(el, ctx);
    case "figcaption": {
      const text = inline(children, ctx).trim();
      return text ? `*${text.replace(/^\*+|\*+$/g, "")}*` : "";
    }
    default: return blocks(children, ctx);
  }
}

/** Convert a (sanitized) HTML fragment into Markdown. Plain text passes through. */
export function htmlToMarkdown(html: string, baseUrl?: string | null): string {
  if (!/<[a-z!\/]/i.test(html)) return html.trim();
  return blocks(parse(html).children, { listDepth: 0, base: baseUrl ?? undefined })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
