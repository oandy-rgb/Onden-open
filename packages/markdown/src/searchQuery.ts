// Search query parser.
//
// Input is the raw user-typed string from /api/nodes/search?q=...
// Tokens:
//   #tagname          → require the node to carry the class-tag named "tagname"
//   key:value         → require node_attributes(key) to equal "value" (case-insensitive);
//                        the key is in the one attribute key grammar (D44,
//                        @onden/markdown attributeKey.ts), so `作者:王` filters too
//   "quoted phrase"   → preserved as a single phrase in the text portion
//   anything else     → text body fed to pgroonga
//
// Quoting only matters for the text portion; tag/attribute tokens are
// space-delimited identifiers and can't contain spaces.
//
// Pure / no DB access — keeps the route handler thin and the parser testable.

export type ParsedSearchQuery = {
  text: string;             // pgroonga payload (joined, possibly empty)
  tags: string[];           // tag names — joined with AND
  attrs: Array<{ key: string; value: string }>; // joined with AND, multiple values for the same key are OR'd
};

import { ATTRIBUTE_KEY } from "./attributeKey.js";
import { TAG_NAME_CHAR } from "./text.js";
import { normalizeText } from "./word.js";

const TAG_RE = new RegExp(String.raw`^#(${TAG_NAME_CHAR}+)$`, "u");
// A key starts with a letter or `_`, so a time (`12:30`) stays text; a key
// can't hold `:`, so the first `:` splits. `//` right after it is a URL
// (`http://…`, `作者://…`), also text.
const ATTR_RE = new RegExp(String.raw`^(${ATTRIBUTE_KEY}):(?!//)(.+)$`, "u");

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const out: ParsedSearchQuery = { text: "", tags: [], attrs: [] };
  if (!raw) return out;
  // Names are compared in NFC (D58): a decomposed `#हिंदी` is the same tag.
  const query = normalizeText(raw);

  // Split honouring "double quoted" segments.
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (!inQuote && /\s/.test(ch)) {
      if (current.length > 0) { tokens.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);

  const textParts: string[] = [];
  for (const tok of tokens) {
    const tagMatch = TAG_RE.exec(tok);
    if (tagMatch) {
      out.tags.push(tagMatch[1].toLowerCase());
      continue;
    }
    const attrMatch = ATTR_RE.exec(tok);
    if (attrMatch) {
      out.attrs.push({
        key: attrMatch[1],
        value: attrMatch[2].replace(/^"|"$/g, ""), // strip surrounding quotes if present
      });
      continue;
    }
    // Anything else is text — preserve quoting for pgroonga phrase matching.
    textParts.push(tok);
  }
  out.text = textParts.join(" ").trim();
  return out;
}
