import { fileURLToPath } from "node:url";
import { getViteConfig } from "astro/config";

// Tests that render .astro components (Astro's container API) need Astro's own
// Vite plugins, which the main vitest.config.ts (React + jsdom) doesn't load.
// Run with `npm run test:astro` (CI runs it after the unit tests).
export default getViteConfig({
  // @onden/markdown is read from source (the backend image alone builds its dist).
  resolve: { alias: [
    // The subpath entries first: an alias matches by prefix, and the local-DB
    // worker may import only slug/ink/snippet (test/workerImports.test.ts).
    { find: "@onden/markdown/ink", replacement: fileURLToPath(new URL("../markdown/src/ink.ts", import.meta.url)) },
    { find: "@onden/markdown/page-text", replacement: fileURLToPath(new URL("../markdown/src/pageText.ts", import.meta.url)) },
    { find: "@onden/markdown/page-images", replacement: fileURLToPath(new URL("../markdown/src/pageImages.ts", import.meta.url)) },
    { find: "@onden/markdown/snippet", replacement: fileURLToPath(new URL("../markdown/src/snippet.ts", import.meta.url)) },
    { find: "@onden/markdown/contract", replacement: fileURLToPath(new URL("../markdown/src/sharedContract.ts", import.meta.url)) },
    { find: "@onden/markdown/media-enhance", replacement: fileURLToPath(new URL("../markdown/src/mediaEnhance.ts", import.meta.url)) },
    { find: "@onden/markdown/steps-enhance", replacement: fileURLToPath(new URL("../markdown/src/stepsEnhance.ts", import.meta.url)) },
    { find: "@onden/markdown/block-id", replacement: fileURLToPath(new URL("../markdown/src/blockId.ts", import.meta.url)) },
    { find: "@onden/markdown", replacement: fileURLToPath(new URL("../markdown/src/index.ts", import.meta.url)) },
    // @onden/site's root entry is dist/ in its package.json; the frontend reads
    // it from source too. Exact match only: "@onden/site/react" resolves by the
    // package's own exports (also source).
    { find: /^@onden\/site$/, replacement: fileURLToPath(new URL("../site/src/index.ts", import.meta.url)) },
  ] },
  test: {
    environment: "node",
    include: ["test-astro/**/*.test.ts"],
    // Two workers, as in vitest.config.ts (7 GB RAM, 16 cores).
    maxWorkers: 2,
  },
});
