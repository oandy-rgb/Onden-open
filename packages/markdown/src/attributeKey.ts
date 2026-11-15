// The one alphabet of an attribute key (D44), for every place a key is made
// or read: the attribute rail and schema editor, the REST routes, frontmatter
// (`key: value`) and inline attributes (`key:: value`, `[key:: value]`).
//
// Before D44 the UI made Unicode keys (`作者`) and the API took any string,
// while both text grammars read only ASCII, so a key set in the app was
// exported as a line the import no longer saw as an attribute, and an
// Obsidian vault's CJK properties came in without attributes.
//
// A key is letters, combining marks, digits, `_` and `-` (word.ts, D58),
// starting with a letter or `_`: a subset of what Obsidian and Dataview
// accept (no spaces or punctuation), so it is always a plain YAML key and
// never runs into the `:` / `::` after it. Keys are kept in NFC: the text
// grammars and the API normalise a key before it is checked or stored.
// `_` keys stay reserved to the server (backend systemAttributes.ts).

import { WORD_CHARS } from "./word.js";

/** One key, as a regex source fragment (use with the `u` flag). It can't
 *  contain `:`, a blank or `]`, so a scan for `key:` stops at the first. */
export const ATTRIBUTE_KEY = String.raw`[\p{L}_][${WORD_CHARS}_-]*`;

const WHOLE_KEY = new RegExp(`^${ATTRIBUTE_KEY}$`, "u");

/** The rule in words, for error messages. */
export const ATTRIBUTE_KEY_RULE = "letters, digits, _ and -, starting with a letter or _";

/** Whether `key` is an attribute key that every grammar reads back. */
export function isAttributeKey(key: string): boolean {
  return WHOLE_KEY.test(key);
}

/** The prefix of a parent's value that each new child copies under the rest
 *  of the key (backend services/childAttributes.ts). */
export const CHILD_KEY_PREFIX = "child:";

/** Whether a person may add `key` to a note: an attribute key, or
 *  `child:` + one. A `child:` key is Onden's own and stays out of text
 *  (frontmatter export leaves it out). */
export function isSettableAttributeKey(key: string): boolean {
  return isAttributeKey(key.startsWith(CHILD_KEY_PREFIX) ? key.slice(CHILD_KEY_PREFIX.length) : key);
}
