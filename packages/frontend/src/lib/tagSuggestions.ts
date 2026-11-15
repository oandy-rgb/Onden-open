import type { Tag } from "./api";
import { tagName } from "./hashtags";
import { isAppliedByAppTag, isNoteSwitchTag, isTagShown, tagKind } from "./nodeTags";

/** Whether `tag` is offered for the typed `query` (lowercased, no `#`): a
 *  shown tag whose name contains it, or a hidden tag (lib/nodeTags.ts
 *  isTagShown) only when its full name is typed — hidden tags still resolve,
 *  they are just never suggested. `match` is how a shown tag's name must
 *  meet the query (contains, or starts with for `#` in the editor). */
export function offersTag(
  tag: Pick<Tag, "name" | "hidden" | "schema_module"> & Partial<Pick<Tag, "reserved_key" | "view_module">>, query: string, match: "contains" | "prefix" = "contains",
): boolean {
  // A system tag, a note switch's inside tag and a tag only the app applies are never offered, not even by their full name.
  if (isNoteSwitchTag(tag) || isAppliedByAppTag(tag) || tagKind(tag) === "system") return false;
  const name = tag.name.toLowerCase();
  if (!isTagShown(tag)) return query !== "" && name === query;
  if (!query) return true;
  return match === "prefix" ? name.startsWith(query) : name.includes(query);
}

/** Tags offered while typing: not yet on the note, name contains the query
 *  (a hidden tag only for its exact name, offersTag).
 *  Names that start with the query first, then alphabetical. Pure, in lib/ so
 *  module code (the RSS 「存到」 fields) can use it without importing
 *  components/TitleTagRow, which imports the module registry (a cycle:
 *  modules/index → rss → RssDestinationFields → TitleTagRow → modules/index). */
export function tagSuggestions(available: Tag[], query: string, limit = 8): Tag[] {
  const q = tagName(query).toLowerCase();
  const hits = available.filter((tag) => offersTag(tag, q));
  return [...hits]
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, limit);
}
