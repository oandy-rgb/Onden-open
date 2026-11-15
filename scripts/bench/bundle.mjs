// Bundle sizes from a production build (packages/frontend/dist/client).
//
// The login path is what a signed-out visitor downloads before the first
// paint of the app: the island's entry chunk (index.html `component-url`),
// the React renderer (`renderer-url`) and everything they import statically.
// `import()` is not followed; those chunks load later (BuilderWorkspace and
// the heavy libraries), which is the point of the number.
import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const STATIC_IMPORT = [/\bfrom\s*["'](\.{1,2}\/[^"']+\.js)["']/g, /(?:^|[;}])\s*import\s*["'](\.{1,2}\/[^"']+\.js)["']/g];

/** @param {string} distClient */
export function measureBundle(distClient) {
  const html = readFileSync(resolve(distClient, "index.html"), "utf8");
  const attr = (name) => html.match(new RegExp(`${name}="([^"]+)"`))?.[1];
  const entryUrl = attr("component-url");
  const rendererUrl = attr("renderer-url");
  if (!entryUrl || !rendererUrl) throw new Error("index.html has no astro-island component-url / renderer-url; the app shell changed");

  /** @type {Map<string, { raw: number, gzip: number }>} */
  const closure = new Map();
  const visit = (url) => {
    if (closure.has(url)) return;
    const code = readFileSync(resolve(distClient, `.${url}`));
    closure.set(url, { raw: code.length, gzip: gzipSync(code).length });
    const text = code.toString("utf8");
    for (const pattern of STATIC_IMPORT) {
      for (const match of text.matchAll(pattern)) visit(posix.normalize(posix.join(dirname(url), match[1])));
    }
  };
  visit(entryUrl);
  visit(rendererUrl);

  // Astro's island entry is a few-byte wrapper that re-exports the real AppRoot
  // chunk; the entry chunk is that chunk, not the wrapper.
  const wrapper = readFileSync(resolve(distClient, `.${entryUrl}`), "utf8");
  const reexported = wrapper.length < 1024 ? wrapper.match(/import\{[^}]*\}from"(\.\/[^"]+\.js)"/)?.[1] : undefined;
  const entryChunk = reexported ? posix.join(dirname(entryUrl), reexported) : entryUrl;

  const sum = (key) => [...closure.values()].reduce((total, file) => total + file[key], 0);
  return {
    bytes: {
      "bundle.entry_chunk_gzip": closure.get(entryChunk).gzip,
      "bundle.login_path_gzip": sum("gzip"),
    },
    detail: {
      entry: entryUrl, entryChunk, renderer: rendererUrl, files: closure.size,
      loginPathRawBytes: sum("raw"),
      largest: [...closure.entries()].sort((a, b) => b[1].gzip - a[1].gzip).slice(0, 5).map(([url, size]) => ({ url, ...size })),
    },
  };
}
