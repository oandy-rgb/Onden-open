import { extname, posix } from "node:path";
import { MEDIA_TYPES, hasLoneSurrogate, entryFor, entryValue, readFrontmatter, writeFrontmatter, scanWikilinks, soleWikilink, frontmatterLength, parseGfmTree } from "@onden/markdown";
import { visit } from "unist-util-visit";
import type { Image, Definition, Link, LinkReference } from "mdast";

/** A PDF is linked, not shown inline: `![[paper.pdf]]` → `[paper](/api/media/…)`. */
const isPdf = (target: string) => /\.pdf(?:[?#].*)?$/i.test(target);

/** Whether an imported file is media, stored and linked rather than read as
 *  a note: any extension on the one media table (@onden/markdown
 *  mediaTypes.ts) — images, PDFs, audio, video and documents — so a file the
 *  app can upload is one a vault import keeps. */
export const isImportedMediaPath = (path: string) => Object.hasOwn(MEDIA_TYPES, extname(path).toLowerCase());

/** An upload path is relative to its selected root. Reject traversal/absolute
 * paths (a leading `/`, a drive `C:`, a URL `https://`), while retaining case
 * and Unicode: case-folding can merge real files. A `:` later in a name
 * (`Note: draft.md`, a folder macOS lists with `/`) is an ordinary character. */
export function importPath(path: string): string | null {
  if (!path || hasLoneSurrogate(path) || path.includes("\\") || /[\u0000-\u001f]/.test(path) || path.startsWith("/") || /^(?:[a-z]:|[a-z][a-z0-9+.-]*:\/\/)/i.test(path)) return null;
  const normalized = posix.normalize(path);
  return normalized === "." || normalized === ".." || normalized.startsWith("../") ? null : normalized;
}

/** Private upload-scoped reference resolver. Null URLs reserve failed or
 * ambiguous paths so they cannot silently fall back to another file.
 * Every reference whose target is an uploaded media file is rewritten to its
 * stored URL: image syntax, links (`[paper](paper.pdf)`), wiki embeds and
 * wikilinks (`![[song.mp3]]`, `[[paper.pdf]]`) in prose, and frontmatter
 * values that name one (`pdf_url: ./attachments/x.pdf`, `cover: "[[a.png]]"`
 * — how an Onden export carries a PDF note and media fields, D91). Source
 * code and every other link or value retain their original bytes. */
export function importedImageLinks(urls: Map<string, string | null>) {
  const byName = new Map<string, string[]>();
  for (const path of urls.keys()) {
    const name = posix.basename(path).toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), path]);
  }
  let unresolved = 0;

  function resolve(target: string, notePath: string, wiki: boolean): string | null {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) return null;
    const suffixAt = target.search(/[?#]/);
    const encoded = suffixAt < 0 ? target : target.slice(0, suffixAt);
    const suffix = suffixAt < 0 ? "" : target.slice(suffixAt);
    let path: string;
    try { path = decodeURIComponent(encoded); } catch { unresolved++; return null; }
    if (!isImportedMediaPath(path)) return null;
    const relative = importPath(posix.join(posix.dirname(notePath), path));
    const rooted = importPath(path);
    // Explicit ./ or ../ is always note-relative. Onden resolves other wiki
    // paths from the vault root first, then tries the note-relative path.
    const explicitlyRelative = path.startsWith("./") || path.startsWith("../");
    const candidates = explicitlyRelative ? [relative] : wiki ? [rooted, relative] : [relative, rooted];
    for (const candidate of candidates) {
      if (candidate && urls.has(candidate)) {
        const url = urls.get(candidate);
        if (!url) unresolved++;
        return url ? url + suffix : null;
      }
    }
    if (!path.includes("/")) {
      const matches = byName.get(path.toLowerCase()) ?? [];
      if (matches.length === 1 && urls.get(matches[0]!)) return urls.get(matches[0]!)! + suffix;
    }
    unresolved++;
    return null;
  }
  const escape = (text: string) => text.replace(/[\\[\]"]/g, "\\$&");
  const titleText = (title?: string | null) => (title ? ` "${escape(title)}"` : "");
  const imageText = (alt: string, url: string, title?: string | null, target = url) =>
    `${isPdf(target) ? "" : "!"}[${escape(alt)}](${url}${titleText(title)})`;

  /** A frontmatter value naming an uploaded file: a path, or a wiki embed or
   *  link (`"[[a.png]]"`) as Obsidian properties write one. */
  function frontmatterTarget(value: string, notePath: string): string | null {
    const wiki = soleWikilink(value.trim().replace(/^!/, ""));
    return wiki?.target ? resolve(wiki.target.trim(), notePath, true) : resolve(value.trim(), notePath, false);
  }

  /** The frontmatter block with each value naming an uploaded file pointed at
   *  its URL (a list item by item); other entries keep their lines. */
  function rewriteFrontmatter(block: string, notePath: string): string {
    const front = readFrontmatter(block);
    if (!front) return block;
    let changed = false;
    const entries = front.entries.map((entry) => {
      const value = entryValue(entry);
      if (!entry.key || value === undefined) return entry;
      const items = Array.isArray(value) ? value : [value];
      const resolved = items.map((item) => frontmatterTarget(item, notePath));
      if (resolved.every((url) => url === null)) return entry;
      changed = true;
      const next = items.map((item, i) => resolved[i] ?? item);
      return entryFor(entry.key, Array.isArray(value) ? next : next[0]!);
    });
    return changed ? writeFrontmatter(entries) + front.body : block;
  }

  return {
    get unresolved() { return unresolved; },
    rewrite(body: string, notePath: string): string {
      const prefix = frontmatterLength(body);
      const content = body.slice(prefix);
      const tree = parseGfmTree(content);
      const edits: Array<{ start: number; end: number; text: string }> = [];
      const definitions = new Map<string, Definition>();
      visit(tree, "definition", node => { if (!definitions.has(node.identifier)) definitions.set(node.identifier, node); });
      visit(tree, node => {
        const start = node.position?.start.offset, end = node.position?.end.offset;
        if (start === undefined || end === undefined) return;
        if (node.type === "image" || node.type === "imageReference") {
          const source = node.type === "image" ? node : definitions.get(node.identifier);
          if (!source) return;
          const url = resolve(source.url, notePath, false);
          if (url) edits.push({ start, end, text: imageText((node as Image).alt ?? "", url, source.title, source.url) });
        } else if (node.type === "link" || node.type === "linkReference") {
          const link = node as Link | LinkReference;
          const source = link.type === "link" ? link : definitions.get(link.identifier);
          if (!source) return;
          const url = resolve(source.url, notePath, false);
          // Only the destination is replaced: the label keeps its bytes (and
          // any image inside it is rewritten on its own).
          const labelEnd = link.children.length ? link.children[link.children.length - 1]!.position?.end.offset : start + 1;
          if (url && labelEnd !== undefined) edits.push({ start: labelEnd, end, text: `](${url}${titleText(source.title)})` });
        } else if (node.type === "text") {
          const raw = content.slice(start, end);
          // [[file|alt]] / ![[file|alt]] not escaped (linearly: utils.scanWikilinks);
          // only those naming an uploaded file are rewritten (resolve).
          const links = scanWikilinks(raw, (body, at) =>
            raw[at - 1] !== "\\" && !(raw[at - 1] === "!" && raw[at - 2] === "\\") && body.length > 0 && body[0] !== "|");
          for (const wikilink of links) {
            const embed = raw[wikilink.start - 1] === "!";
            const bar = wikilink.body.indexOf("|");
            const target = bar === -1 ? wikilink.body : wikilink.body.slice(0, bar);
            const alt = bar === -1 ? "" : wikilink.body.slice(bar + 1);
            const url = resolve(target.trim(), notePath, true);
            if (!url) continue;
            const label = alt || posix.basename(target).replace(/\.[^.]+$/, "");
            edits.push({ start: start + wikilink.start - (embed ? 1 : 0), end: start + wikilink.end,
              text: embed ? imageText(label, url, null, target) : `[${escape(label)}](${url})` });
          }
        }
      });
      let out = content;
      for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
      return rewriteFrontmatter(body.slice(0, prefix), notePath) + out;
    },
  };
}
