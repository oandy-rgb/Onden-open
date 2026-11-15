// The YAML frontmatter of a Markdown note — the one codec for rendering,
// indexing, export, import and the attribute rail, so a value reads back
// exactly as it was written and every reader agrees where the block ends.
//
// The block is kept as entries of verbatim lines: a top-level `key:` line plus
// its continuation lines (indented lines, list items). Nothing is re-written
// unless a caller replaces a whole entry, so YAML this codec doesn't model
// (nested maps, `|` / `>` multi-line strings, lists of maps, empty keys)
// survives byte for byte. entryValue reads the simple shapes: plain,
// "double-quoted" (JSON escapes) or 'single-quoted' ('' for a quote) scalars,
// inline lists `[a, "b"]` and block lists of scalars.
//
// Rendering hides the block (stripFrontmatter, as Obsidian does); remark
// would otherwise read `---\ntext` as a setext heading.

import { ATTRIBUTE_KEY, isAttributeKey } from "./attributeKey.js";
import { WORD_CHARS } from "./word.js";

export type FrontmatterValue = string | string[];
export type FrontmatterEntry = { key: string | null; lines: string[] };

// The closing fence is a line of its own: `---` inside a value never ends it.
// The empty block (`---` then `---`) is tried first (`??`): `---\n---\n\nA\n\n---` is an empty block, not one holding A.
const FENCE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??---[ \t]*(?:\r?\n|$)/;
// A key line: the attribute key grammar (attributeKey.ts), or a "double-quoted"
// JSON key for one outside it ("Due Date", a CSV column); so a key the app
// writes reads back here. Any other line is kept verbatim with key null.
const KEY_LINE = new RegExp(String.raw`^(?:(${ATTRIBUTE_KEY})|("(?:[^"\\]|\\.)*")):(?:[ \t]+(.*)|[ \t]*)$`, "u");

/** A key line's key and the text after its colon, or null for any other line. */
function parseKeyLine(line: string): { key: string; rest: string } | null {
  const m = line.match(KEY_LINE);
  if (!m) return null;
  let key = m[1];
  if (key === undefined) {
    try { key = JSON.parse(m[2]!) as string; } catch { return null; }
    if (!key) return null;
  }
  return { key, rest: m[3] ?? "" };
}
const MAP_ITEM = new RegExp(String.raw`^${ATTRIBUTE_KEY}:(\s|$)`, "u");

const CLOSED_FENCE_LINE = /^---[ \t]*$/;

/** The 1-based line holding the closing fence of the frontmatter block that
 *  opens on line 1, or null when line 1 opens none or nothing closes it. The
 *  same fences as readFrontmatter, found line by line for callers that hold
 *  lines, not one string (an editor document), so a typing step in a long note
 *  doesn't copy the whole text. */
export function frontmatterEndLine(lineCount: number, lineAt: (lineNo: number) => string): number | null {
  if (lineCount < 2 || !CLOSED_FENCE_LINE.test(lineAt(1))) return null;
  for (let n = 2; n <= lineCount; n++) if (CLOSED_FENCE_LINE.test(lineAt(n))) return n;
  return null;
}

/** The frontmatter entries and the body after the closing fence, or null
 *  when the text doesn't start with a frontmatter block. */
export function readFrontmatter(markdown: string): { entries: FrontmatterEntry[]; body: string } | null {
  const match = markdown.match(FENCE);
  if (!match) return null;
  const entries: FrontmatterEntry[] = [];
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const key = parseKeyLine(line)?.key;
    const last = entries[entries.length - 1];
    if (key) entries.push({ key, lines: [line] });
    else if (last?.key && /^[ \t]/.test(line)) last.lines.push(line);
    else if (line.trim() || entries.length) entries.push({ key: null, lines: [line] });
  }
  return { entries, body: markdown.slice(match[0].length) };
}

/** The block (with fences and a trailing newline) for these entries, or "". */
export function writeFrontmatter(entries: FrontmatterEntry[]): string {
  return entries.length ? `---\n${entries.flatMap((e) => e.lines).join("\n")}\n---\n` : "";
}

function unquote(text: string): string {
  const v = text.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v) as string; } catch { return v.slice(1, -1); }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function splitInlineList(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < inner.length) { current += inner[++i]; continue; }
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") { quote = ch; current += ch; }
    else if (ch === ",") { items.push(current); current = ""; }
    else current += ch;
  }
  if (current.trim()) items.push(current);
  return items.map(unquote).filter((item) => item !== "");
}

/** The value of a simple entry: a scalar, or a list of scalars. undefined for
 *  shapes this codec doesn't model (nested map, multi-line string, list of
 *  maps) and for an empty key. */
export function entryValue(entry: FrontmatterEntry): FrontmatterValue | undefined {
  if (!entry.key) return undefined;
  const rest = (parseKeyLine(entry.lines[0]!)?.rest ?? "").trim();
  const continuation = entry.lines.slice(1).filter((l) => l.trim());
  if (rest) {
    if (continuation.length || /^[|>]/.test(rest)) return undefined;
    const inline = rest.match(/^\[(.*)\]$/);
    return inline ? splitInlineList(inline[1]!) : unquote(rest);
  }
  if (!continuation.length) return undefined;
  const items: string[] = [];
  for (const line of continuation) {
    const item = line.match(/^[ \t]+-(?:[ \t]+(.*))?$/);
    if (!item) return undefined;                       // a nested map
    const text = (item[1] ?? "").trim();
    if (MAP_ITEM.test(text)) return undefined;         // a list of maps
    if (text) items.push(unquote(text));
  }
  return items;
}

// A scalar YAML reads back as itself: starts with a letter or digit, then
// word characters (marks too, D58: `हिंदी` stays plain), blanks and `_./-`.
const PLAIN_SCALAR = new RegExp(String.raw`^[\p{L}\p{N}][${WORD_CHARS} _./-]*$`, "u");

/** A scalar as YAML: plain when that reads back the same, else double-quoted. */
function scalar(v: string): string {
  return PLAIN_SCALAR.test(v) && !/^(true|false|null|yes|no|~)$/i.test(v) && !/ $/.test(v)
    ? v : JSON.stringify(v);
}

/** A freshly written entry for `key` (a list as a block list). A key outside
 *  the attribute key grammar (a space, `:` or `#` would change what YAML and
 *  readFrontmatter see) is written "double-quoted", which reads back as the
 *  same key; only an empty key throws. A multi-line value is one quoted line
 *  with `\n` escapes. */
export function entryFor(key: string, value: FrontmatterValue): FrontmatterEntry {
  if (!key) throw new Error("frontmatter key must not be empty");
  const written = isAttributeKey(key) ? key : JSON.stringify(key);
  if (Array.isArray(value)) return { key, lines: [`${written}:`, ...value.map((item) => `  - ${scalar(item)}`)] };
  return { key, lines: [`${written}: ${scalar(value)}`] };
}

/** The scalar of `key` (a list gives its first item), or undefined. */
export function fieldValue(entries: FrontmatterEntry[], key: string): string | undefined {
  const entry = entries.find((e) => e.key === key);
  const value = entry && entryValue(entry);
  return Array.isArray(value) ? value[0] : value;
}

/** The frontmatter key a note kept off the published site travels as (`publish: false`,
 *  Obsidian Publish's own switch): the Markdown export writes it, the import reads it back. */
export const PUBLISH_OFF_KEY = "publish";
/** The key it travels as when the author already has a `publish` field of their own: that one is left as written
 *  (the export never overwrites an author's value), and the import reads either key. */
export const PUBLISH_OFF_FALLBACK_KEY = "onden_publish";

/** The line the export writes for a note kept off the site: a plain `publish: false` (a boolean to Obsidian, not the
 *  quoted string entryFor would write for the text "false"), under `key` (PUBLISH_OFF_FALLBACK_KEY when the author's
 *  own `publish` is in the way). */
export const publishOffEntry = (key: string = PUBLISH_OFF_KEY): FrontmatterEntry => ({ key, lines: [`${key}: false`] });

/** Whether the frontmatter says the note stays off the site (`publish: false` or the fallback key, any case). */
export function keepsOffSite(entries: FrontmatterEntry[]): boolean {
  return [PUBLISH_OFF_KEY, PUBLISH_OFF_FALLBACK_KEY].some((key) => fieldValue(entries, key)?.trim().toLowerCase() === "false");
}

/** The list of `key` (a scalar may be comma-separated), or []. */
export function fieldList(entries: FrontmatterEntry[], key: string): string[] {
  const entry = entries.find((e) => e.key === key);
  const value = entry && entryValue(entry);
  if (value === undefined) return [];
  return Array.isArray(value) ? value : value.split(",").map((v) => v.trim()).filter(Boolean);
}

/** How many characters the frontmatter block (fences included) takes at the
 *  start of `markdown`; 0 when there is none. */
export function frontmatterLength(markdown: string): number {
  const front = readFrontmatter(markdown);
  return front ? markdown.length - front.body.length : 0;
}

/** The text without its frontmatter block. */
export function stripFrontmatter(markdown: string): string {
  return readFrontmatter(markdown)?.body ?? markdown;
}

// A YAML mapping key as people write it (`date created: …`, `my.key: v`, "quoted: key": v): no leading space, `#` or `-`.
const SETTINGS_KEY_LINE = /^[^\s#:-][^:]*:(?:\s|$)/;

/** The text without its frontmatter block, but only when the block reads as settings: empty, or made of
 *  `key: value` lines (a key may hold spaces and dots), their indented lines, `- ` list items and blank lines, with at
 *  least one key. A `#` line is a YAML comment when the block has no blank line, a heading (content) when it has one.
 *  Any other plain line (a paragraph) makes the block content: a deck that opens with a rule keeps its first page.
 *  For the slides view only: the reading view, the editor and the published site still hide every `---` block, so such
 *  a first page shows in slides and nowhere else. Known limits: `---\n# T\nAgenda: x\n---` (no blank line) and
 *  `---\nAgenda:\n- a\n---` are valid settings, so they are read as settings. */
export function stripSettingsFrontmatter(markdown: string): string {
  const fm = readFrontmatter(markdown);
  if (!fm) return markdown;
  const lines = markdown.slice(0, markdown.length - fm.body.length).replace(/\r?\n$/, "").split(/\r?\n/).slice(1, -1);
  if (lines.every((line) => !line.trim())) return fm.body; // empty block
  const hasBlank = lines.some((line) => !line.trim());
  const plain = (line: string) => line.trim() && !/^[ \t]/.test(line) && !/^-(\s|$)/.test(line) && !SETTINGS_KEY_LINE.test(line) && !(!hasBlank && line.startsWith("#"));
  return lines.some((line) => SETTINGS_KEY_LINE.test(line)) && !lines.some(plain) ? fm.body : markdown;
}

/** The frontmatter as a flat map of lower-cased keys to strings (a list is
 *  joined with ", "; shapes entryValue doesn't model are left out). The
 *  published page reads it to let a note override its SEO meta (e.g.
 *  `description:`). */
export function parseFrontmatter(markdown: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readFrontmatter(markdown)?.entries ?? []) {
    const value = entryValue(entry);
    if (entry.key && value !== undefined) out[entry.key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}
