import node from "@astrojs/node";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import bootReportPlugin from "./scripts/bootReportPlugin.mjs";
import hoverWithPointer from "./scripts/hoverWithPointer.mjs";

// One id per build: lib/lazyWithReload.ts keys its one-reload-per-build guard
// on it. A deploy may pass ONDEN_BUILD_ID (e.g. the git sha); otherwise the
// build time is unique enough.
const BUILD_ID = process.env.ONDEN_BUILD_ID || Date.now().toString(36);

export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [tailwindcss(), bootReportPlugin()],
    // A hover tint only with a pointer that hovers; on a touch screen it would stick to the last tap.
    css: { postcss: { plugins: [hoverWithPointer()] } },
    define: { __ONDEN_BUILD_ID__: JSON.stringify(BUILD_ID) },
    // @onden/markdown is read from source (the backend image alone builds its dist).
    resolve: { alias: [
    // The subpath entries first: an alias matches by prefix, and the local-DB
    // worker may import only slug/ink/snippet (test/workerImports.test.ts).
    { find: "@onden/markdown/slug", replacement: fileURLToPath(new URL("../markdown/src/slug.ts", import.meta.url)) },
    { find: "@onden/markdown/ink", replacement: fileURLToPath(new URL("../markdown/src/ink.ts", import.meta.url)) },
    { find: "@onden/markdown/page-text", replacement: fileURLToPath(new URL("../markdown/src/pageText.ts", import.meta.url)) },
    { find: "@onden/markdown/page-images", replacement: fileURLToPath(new URL("../markdown/src/pageImages.ts", import.meta.url)) },
    { find: "@onden/markdown/note-pages", replacement: fileURLToPath(new URL("../markdown/src/notePages.ts", import.meta.url)) },
    { find: "@onden/markdown/snippet", replacement: fileURLToPath(new URL("../markdown/src/snippet.ts", import.meta.url)) },
    { find: "@onden/markdown/contract", replacement: fileURLToPath(new URL("../markdown/src/sharedContract.ts", import.meta.url)) },
    { find: "@onden/markdown/media-enhance", replacement: fileURLToPath(new URL("../markdown/src/mediaEnhance.ts", import.meta.url)) },
    { find: "@onden/markdown/steps-enhance", replacement: fileURLToPath(new URL("../markdown/src/stepsEnhance.ts", import.meta.url)) },
    { find: "@onden/markdown/block-id", replacement: fileURLToPath(new URL("../markdown/src/blockId.ts", import.meta.url)) },
    { find: "@onden/markdown/task-parse", replacement: fileURLToPath(new URL("../markdown/src/taskParse.ts", import.meta.url)) },
    { find: "@onden/markdown", replacement: fileURLToPath(new URL("../markdown/src/index.ts", import.meta.url)) },
    // @onden/site's root entry is dist/ in its package.json; the frontend reads
    // it from source too. Exact match only: "@onden/site/react" resolves by the
    // package's own exports (also source).
    { find: /^@onden\/site$/, replacement: fileURLToPath(new URL("../site/src/index.ts", import.meta.url)) },
  ] },
  },
  output: "static",
  adapter: node({ mode: "standalone" }),
});
