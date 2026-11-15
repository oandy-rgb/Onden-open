// The grammar of inline attributes in a note body, read the same way by the
// server's index (backend utils.ts extractAttributes) and by the renderer
// that hides the standalone form (remarkInlineAttrs). Before D34 each side had
// its own rule: the server knew only ``` fences, so a `key:: value` inside a
// ~~~ block was indexed; the renderer dropped any paragraph whose first text
// began with `key:: `, and CommonMark joins adjacent lines into one paragraph,
// so the prose line under an attribute line vanished with it.
//
// Three forms, all read line by line and never inside a fenced code block:
//   1. `#key=value`     — Onden's compact hashtag form (stays visible);
//   2. `key:: value`    — Obsidian/Dataview standalone line (hidden when rendered);
//   3. `[key:: value]`  — Obsidian/Dataview bracketed form, anywhere in a line
//                         (stays visible: it sits in prose).
//
// The space after `::` is required, so `foo::bar` namespaces never match.
// Values are not unquoted or unescaped; a bracketed value stops at the first `]`.

import { fenceScanner } from "./fences.js";
import { ATTRIBUTE_KEY } from "./attributeKey.js";
import { normalizeText, WORD_CHARS } from "./word.js";

export type AttributeForm = "hashtag" | "line" | "bracket";

/** One attribute written in a note: the 1-based source line it is on (as in
 *  unist positions), its form, key and trimmed value. */
export type AttributeLine = { line: number; form: AttributeForm; key: string; value: string };

/** The standalone form: the whole line, from its first column. */
// Keys follow the one attribute key grammar (attributeKey.ts, D44): a key the
// app writes is read here, and an Obsidian `作者:: 王` line is an attribute.
const ATTRIBUTE_LINE_RE = new RegExp(String.raw`^(${ATTRIBUTE_KEY})::[ \t]+(.+)$`, "u");
const BRACKET_KEY_RE = new RegExp(String.raw`(${ATTRIBUTE_KEY})::[ \t]`, "uy");
// `#key=value` too (D44b): a tag name may start with a digit or `-`, a key
// may not, so `#2024=x` gives no attribute. Read as key `2024` it was one
// the API refuses and the attribute panel can't edit, and its frontmatter
// export (`2024: x`) is a number key in YAML.
const HASHTAG_ATTR_RE = new RegExp(String.raw`(^|\s)#(${ATTRIBUTE_KEY})=([${WORD_CHARS}_.-]*)`, "gu");

/** The lines of `markdown` split at CommonMark line endings (`\r\n`, `\r`, `\n`). */
function splitLines(markdown: string): string[] {
  return markdown.split(/\r\n?|\n/);
}

/** Every attribute in `markdown`, in document order (line, then position in
 *  the line); fenced code blocks (``` and ~~~) are skipped. Keys come back in
 *  NFC (word.ts), so a decomposed `कीमत::` line names the same attribute as
 *  a composed one. */
export function attributeLines(markdown: string): AttributeLine[] {
  const out: AttributeLine[] = [];
  const fence = fenceScanner({ container: true }); // fences inside list items and quotes count
  const lines = splitLines(markdown);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    if (fence(text) !== "outside") continue;
    const line = i + 1;
    const found: Array<AttributeLine & { at: number }> = [];
    for (const m of text.matchAll(HASHTAG_ATTR_RE)) {
      found.push({ line, at: m.index! + m[1]!.length, form: "hashtag", key: m[2]!, value: m[3]! });
    }
    const standalone = ATTRIBUTE_LINE_RE.exec(text);
    if (standalone) found.push({ line, at: 0, form: "line", key: standalone[1]!, value: standalone[2]!.trim() });
    for (const b of bracketed(text)) found.push({ line, form: "bracket", ...b });
    found.sort((a, b) => a.at - b.at);
    for (const { form, key, value } of found) out.push({ line, form, key: normalizeText(key), value });
  }
  return out;
}

/** `[key:: value]` in one line, as /\[(ATTRIBUTE_KEY)::[ \t]+([^\]]+)\]/gu
 *  finds them, in linear time: that regex re-reads to the end of the line from
 *  every `[`, so a pasted run of `[k:: v [k:: v …` without `]` took seconds.
 *  The value runs to the first `]`, shared by the starts before it. */
function bracketed(text: string): Array<{ at: number; key: string; value: string }> {
  const out: Array<{ at: number; key: string; value: string }> = [];
  let close = -1;
  let i = text.indexOf("[");
  while (i !== -1) {
    BRACKET_KEY_RE.lastIndex = i + 1;
    const key = BRACKET_KEY_RE.exec(text);
    if (key) {
      const bodyStart = BRACKET_KEY_RE.lastIndex - 1; // at the first space/tab
      if (close < bodyStart) close = text.indexOf("]", bodyStart);
      if (close === -1) break; // no "]" after: no further match
      // `[ \t]+([^\]]+)`: at least one blank, then at least one more character.
      if (close - bodyStart >= 2) {
        out.push({ at: i, key: key[1]!, value: text.slice(bodyStart, close).trim() });
        i = text.indexOf("[", close + 1);
        continue;
      }
    }
    i = text.indexOf("[", i + 1);
  }
  return out;
}

/** The 1-based numbers of the standalone `key:: value` lines — the lines the
 *  renderer hides. */
export function standaloneAttributeLines(markdown: string): Set<number> {
  return new Set(attributeLines(markdown).filter((a) => a.form === "line").map((a) => a.line));
}
