// 聲音: is a feed a person writing, or a publication? Guessed once when a feed
// is subscribed (the form can change it, and so can the feed's settings
// afterwards); the reader's 「聲音」 tag shows only the people.
//
// The guess is deliberately modest — wrong in the "media" direction costs
// nothing (the person still sees it under 全部), wrong in the "person"
// direction mislabels a publication. So "person" needs a reason:
//   * the feed lives on a place for personal writing (a blog platform's
//     subdomain, a github.io page, a Medium/Substack author), or
//   * every one of at least three articles names the same author, and that
//     name is a person's, not "Editor" or "Staff".

import type { SourceVoice } from "./sources.js";

const PERSONAL_HOST = /(^|\.)(substack\.com|github\.io|gitlab\.io|bearblog\.dev|ghost\.io|wordpress\.com|blogspot\.com|hashnode\.dev|write\.as|micro\.blog|medium\.com|dev\.to|neocities\.org|netlify\.app)$/;
const GENERIC_AUTHOR = /^(admin|administrator|editor|editors|staff|team|redaction|newsroom|news desk|webmaster|站長|編輯部|編輯|小編|管理員)$/i;
/** The fewest articles that say anything about "always the same author". */
const MIN_ITEMS_FOR_AUTHOR = 3;

export function guessVoice(feedUrl: string, items: ReadonlyArray<{ author?: string | null }>): SourceVoice {
  let host = "";
  try { host = new URL(feedUrl).hostname.toLowerCase(); } catch { return "media"; }
  if (PERSONAL_HOST.test(host)) return "person";
  const authors = items.map((item) => item.author?.replace(/\s+/g, " ").trim().toLowerCase() ?? "");
  if (authors.length >= MIN_ITEMS_FOR_AUTHOR && authors[0] && authors.every((a) => a === authors[0]) && !GENERIC_AUTHOR.test(authors[0])) return "person";
  return "media";
}
