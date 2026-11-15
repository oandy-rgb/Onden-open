// Search a Pagefind index the way a browser does — pagefind.js from the index
// folder, its files fetched by URL — but in Node, with `read` standing in for
// the host: the stored copy's folder (what a static host serves) or the live
// route's reader (what GET /api/site/search.idx/* serves).
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const ORIGIN = "http://search.test/site/search.idx/";

export type SearchHit = { url: string; title: string };

export async function searchIndex(
  scriptDir: string,
  read: (name: string) => Promise<Buffer | null>,
  query: string,
): Promise<SearchHit[]> {
  const realFetch = globalThis.fetch;
  // pagefind.js starts loading from where it was imported (a file: URL here) as
  // soon as it is imported, before the base path below is set.
  const FILE_ORIGIN = `${pathToFileURL(scriptDir).href}/`;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input).replace(/[?#].*$/, ""); // pagefind adds ?ts=… to its entry file
    const prefix = url.startsWith(ORIGIN) ? ORIGIN : url.startsWith(FILE_ORIGIN) ? FILE_ORIGIN : null;
    const bytes = prefix ? await read(decodeURIComponent(url.slice(prefix.length))) : null;
    return bytes ? new Response(new Uint8Array(bytes)) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const api = await import(/* @vite-ignore */ `${pathToFileURL(join(scriptDir, "pagefind.js")).href}?${Date.now()}${Math.random()}`);
    await api.options({ basePath: ORIGIN });
    const { results } = await api.search(query);
    const hits: SearchHit[] = [];
    for (const result of results) {
      const data = await result.data();
      hits.push({ url: data.url, title: data.meta.title });
    }
    await api.destroy?.();
    return hits;
  } finally {
    globalThis.fetch = realFetch;
  }
}
