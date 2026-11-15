// Where a feed's own articles live (the RSS reader, backend modules/rss/sourcePrefix.ts): the longest path every article
// URL of the source shares, on the origin most of them use — `https://medium.com/@alice/` for a writer on a platform,
// `https://example.com/` for a site of their own. A link that starts with it is another article of the same source.
// Worked out from the articles, so no list of platforms is kept; a source with one article uses that article's directory.

/** The shared `origin + path/` of `urls`, or null when none is an http(s) URL. */
export function articlePrefix(urls: readonly string[]): string | null {
  const parsed = urls.flatMap((raw) => {
    try {
      const u = new URL(raw);
      return u.protocol === "http:" || u.protocol === "https:" ? [u] : [];
    } catch { return []; }
  });
  if (parsed.length === 0) return null;
  const byOrigin = new Map<string, URL[]>();
  for (const u of parsed) byOrigin.set(u.origin, [...(byOrigin.get(u.origin) ?? []), u]);
  const [origin, onIt] = [...byOrigin].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0]!;
  // Each URL's directories: the last segment is the article itself.
  const dirs = onIt.map((u) => u.pathname.split("/").filter(Boolean).slice(0, -1));
  const shared: string[] = [];
  for (let i = 0; dirs.every((d) => i < d.length && d[i] === dirs[0]![i]); i++) shared.push(dirs[0]![i]!);
  return `${origin}/${shared.map((s) => `${s}/`).join("")}`;
}

/** `url` is under `prefix` (articlePrefix), ignoring a fragment. */
export function withinPrefix(url: string, prefix: string | null): boolean {
  if (!prefix) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return `${u.origin}${u.pathname}`.startsWith(prefix);
  } catch { return false; }
}
