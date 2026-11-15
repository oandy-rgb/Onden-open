// A static file server for dist-browser (smoke.mjs and measure.mjs). The browser app needs nothing from its host
// but files with the right types (.wasm as application/wasm).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

/** Serve `root` on a free port; resolves { base, close }.
 *  `prefix` ("/onden/"): serve it from a sub-path like GitHub Pages does, and answer 404 outside it.
 *  `buildId`: what /build.json says (the published folder's build; the page compares it with its own).
 *  `handle(request, response, path)`: answered first; return true when it took the request (parity/hosts/browser.mjs
 *  hands big files in and out of the page this way, so no byte array goes through page.evaluate). */
export async function serve(root, { prefix = "/", buildId = null, handle = null } = {}) {
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(request.url.split("?")[0]);
    if (handle && (await handle(request, response, path))) return;
    if (!path.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
    const inside = `/${path.slice(prefix.length)}`;
    if (buildId && inside === "/build.json") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ build: buildId }));
      return;
    }
    let file = join(root, inside);
    if (file.endsWith("/")) file += "index.html";
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { base: `http://localhost:${server.address().port}${prefix}`, close: () => server.close() };
}
