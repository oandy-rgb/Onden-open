/** The site's name for `<title>`, og:title and the page chrome: the owner's
 *  brand, else the title the site was published under, else "Onden". An empty
 *  brand counts as unset (`??` would keep "" and leave the tab title blank). */
export function siteName(brand: unknown, publishedTitle: unknown): string {
  for (const candidate of [brand, publishedTitle]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return "Onden";
}
