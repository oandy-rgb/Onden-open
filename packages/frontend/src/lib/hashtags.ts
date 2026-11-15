// The app's hashtag helpers, on @onden/markdown's one hashtag grammar.
//
// A hashtag is `#` + one or more letters (any script), digits, `_` or `-`,
// at the start of a line or after whitespace — so `#研究` and `#todo` match
// and the `#frag` in `https://x.test#frag` does not. The grammar itself
// (TAG_NAME_CHAR, HASHTAG_RE) is @onden/markdown's text.ts.
//
// A `#word` written in a note's body or title — or in Quick capture or the
// Tasks quick-add line — is TEXT, not a tag (T10, user decision 2026-10-16):
// nothing in the app turns text into tag membership. Tags are stored
// memberships (node_tags), applied with "+ Tag", import frontmatter, template
// default tags or the API. What is left here is presentation and input help:
// the tag-name cleaner and the published site's excerpt / hashtag-only-line
// handling. The editor offers no list for a body `#` (it is Markdown, and
// `{name}` tags a paragraph); the one-time `#word` → `{word}` note is
// lib/hashtagScopeHint.

import { HASHTAG_RE, TAG_NAME_CHAR } from "@onden/markdown";

const HASHTAG_ONLY_LINE = new RegExp(String.raw`^(\s*#${TAG_NAME_CHAR}+)+\s*$`, "u");

/** Drop the `#` marks but keep the words: "read #研究 now" → "read 研究 now". */
export function stripHashtagMarks(text: string): string {
  return text.replace(HASHTAG_RE, "$1$2");
}

/** True when a line holds nothing but hashtags ("#garden #notes"). */
export function isHashtagOnlyLine(line: string): boolean {
  return HASHTAG_ONLY_LINE.test(line);
}

/** A typed or displayed tag name: no leading `#`, no surrounding space. */
export function tagName(raw: string): string {
  return raw.trim().replace(/^#+/, "").trim();
}

/** A typed tag search: the name being looked for, lowercased. */
export function tagQuery(raw: string): string {
  return tagName(raw).toLowerCase();
}
