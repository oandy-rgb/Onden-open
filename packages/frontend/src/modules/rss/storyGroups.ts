import { paragraphSimilarity } from "@onden/markdown";

// 同一則故事合併成一行: the same news reported by different feeds is one row
// with 「另有 N 個來源」. Display only — nothing is stored or deleted, and the
// list still moves article by article.
//
// Conservative on purpose: a missed merge costs one more row, a wrong merge
// hides an article behind another. So two articles merge only when they come
// from DIFFERENT feeds, within two days of each other, with titles that are
// the same headline, i.e.
//   * character-bigram similarity (the one the change summaries use, so a
//     Chinese headline with no spaces is compared as well as an English one)
//     of at least SAME_STORY, after dropping punctuation, case and a trailing
//     「 - 站名」, and
//   * the same numbers in the same order ("iPhone 16" is not "iPhone 17"), and
//   * enough text to say anything (a one-word title never merges).

export const SAME_STORY = 0.78;
export const SAME_STORY_WITHIN_MS = 48 * 3_600_000;
/** How much text a title needs left to be compared, in UTF-8 bytes: that is 14 Latin letters or 5 CJK characters (one carries about a word), without a script table. */
const MIN_TITLE_BYTES = 14;
const bytesOf = (key: string): number => new TextEncoder().encode(key).length;

type StoryItem = { id: string; title: string; source_id: string; published_at: string | null; fetched_at: string };

/** A title reduced to its headline: no outlet suffix, punctuation or case. */
export function storyKey(title: string): string {
  const headline = title.replace(/(\s+[-–—·]\s+|\s*[|｜]\s*)[^-–—|｜·]{1,24}$/, "");
  return headline.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const numbersOf = (key: string): string => (key.match(/\p{N}+/gu) ?? []).join(",");

export function sameStory(a: StoryItem, b: StoryItem): boolean {
  if (a.source_id === b.source_id) return false;
  const ta = Date.parse(a.published_at ?? a.fetched_at);
  const tb = Date.parse(b.published_at ?? b.fetched_at);
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || Math.abs(ta - tb) > SAME_STORY_WITHIN_MS) return false;
  const ka = storyKey(a.title);
  const kb = storyKey(b.title);
  if (bytesOf(ka) < MIN_TITLE_BYTES || bytesOf(kb) < MIN_TITLE_BYTES) return false;
  if (numbersOf(ka) !== numbersOf(kb)) return false;
  return paragraphSimilarity(ka, kb) >= SAME_STORY;
}

export type Story<T> = { lead: T; others: T[] };

/** The list as stories, in the list's order (a story sits where its first article does). */
export function groupStories<T extends StoryItem>(items: readonly T[]): Array<Story<T>> {
  const stories: Array<Story<T>> = [];
  for (const item of items) {
    // An article joins the first story whose lead it matches and whose feeds it does not already have.
    const home = stories.find((s) => sameStory(s.lead, item) && ![s.lead, ...s.others].some((x) => x.source_id === item.source_id));
    if (home) home.others.push(item);
    else stories.push({ lead: item, others: [] });
  }
  return stories;
}
