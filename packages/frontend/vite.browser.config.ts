import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { appHeadPlugin } from "./src/appShell/vitePlugin";

// The browser app's page (npm run build:browser, scripts/build-browser.mjs): the same React app as the web build,
// as a standalone static page. Separate from Astro and from vite.capacitor.config.ts, so the web build's boot
// budget (scripts/check-boot-bundle.mjs) never sees it.
const outDir = process.env.ONDEN_BROWSER_OUT ?? fileURLToPath(new URL("./dist-browser", import.meta.url));

// public/ holds the web build's offline machinery too (the PDF viewer's worker, the service worker). The browser app
// has no uploaded PDFs and nothing to cache for offline (the page and its backend are the same files). It takes the
// icons, the manifest, the faces the styles ask for, and sql.js for the local copy (src/lib/localDb.ts).
const publicDir = fileURLToPath(new URL("./public", import.meta.url));
const FROM_PUBLIC = ["favicon.svg", "icon-192.png", "icon-512.png", "manifest.webmanifest", ...readdirSync(`${publicDir}/fonts`).map((f) => `fonts/${f}`), ...readdirSync(`${publicDir}/sql.js`).map((f) => `sql.js/${f}`)];
// The Service Worker that shows uploaded files (browser-sw/media-sw.js): a plain file at the page's own level, so its
// registration folder is wherever the page is served from.
const mediaServiceWorker = fileURLToPath(new URL("./browser-sw/media-sw.js", import.meta.url));
const takeFromPublic = {
  name: "take-from-public",
  generateBundle(this: { emitFile(file: { type: "asset"; fileName: string; source: Uint8Array }): void }) {
    for (const file of FROM_PUBLIC) this.emitFile({ type: "asset", fileName: file, source: readFileSync(`${publicDir}/${file}`) });
    this.emitFile({ type: "asset", fileName: "media-sw.js", source: readFileSync(mediaServiceWorker) });
  },
};

export default defineConfig({
  plugins: [appHeadPlugin("browser"), react(), tailwindcss(), takeFromPublic],
  publicDir: false,
  // Relative addresses: the folder can be served from any path (a preview address per pull request).
  base: "./",
  // The same aliases as astro.config.mjs: the packages are read from source. Subpath entries first (matched by prefix).
  resolve: { alias: [
    ...["slug", "ink", "page-text", "page-images", "cite", "snippet", "media-enhance", "steps-enhance", "block-id", "task-parse", "contract"].map((sub) => ({
      find: `@onden/markdown/${sub}`,
      replacement: fileURLToPath(new URL(`../markdown/src/${{ "page-text": "pageText", "page-images": "pageImages", "media-enhance": "mediaEnhance", "steps-enhance": "stepsEnhance", "block-id": "blockId", "task-parse": "taskParse", contract: "sharedContract" }[sub] ?? sub}.ts`, import.meta.url)),
    })),
    { find: "@onden/markdown", replacement: fileURLToPath(new URL("../markdown/src/index.ts", import.meta.url)) },
    { find: /^@onden\/site$/, replacement: fileURLToPath(new URL("../site/src/index.ts", import.meta.url)) },
  ] },
  envPrefix: ["VITE_", "PUBLIC_"],
  define: {
    "import.meta.env.VITE_BROWSER_APP": JSON.stringify("true"),
    // One id per build: lib/lazyWithReload.ts reloads at most once per build when a stale chunk is asked for.
    __ONDEN_BUILD_ID__: JSON.stringify(process.env.ONDEN_BUILD_ID || Date.now().toString(36)),
    // When it was made: lib/buildTime. ONDEN_BUILT_AT_MS only for e2e/layout-audit, which builds a "future" build so
    // that its fresh accounts count as older than it and the 「這次更新」 card appears (screen whats-new-card).
    __ONDEN_BUILT_AT__: Number(process.env.ONDEN_BUILT_AT_MS) || Date.now(),
  },
  build: {
    outDir,
    emptyOutDir: false, // scripts/build-browser.mjs empties the folder once, before it adds the worker files
    rollupOptions: { input: fileURLToPath(new URL("./browser.html", import.meta.url)) },
  },
});
