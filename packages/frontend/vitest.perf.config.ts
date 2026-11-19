import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `npm run bench` (frontend part): real app code in plain Node, no jsdom, no
// shuffling, one file at a time. Kept apart from vitest.config.ts so the
// regular suite never picks the benchmark up.
export default defineConfig({
  resolve: { alias: {
    "@onden/markdown/slug": fileURLToPath(new URL("../markdown/src/slug.ts", import.meta.url)),
    "@onden/markdown/task-parse": fileURLToPath(new URL("../markdown/src/taskParse.ts", import.meta.url)),
    "@onden/markdown/ink": fileURLToPath(new URL("../markdown/src/ink.ts", import.meta.url)),
    "@onden/markdown/page-text": fileURLToPath(new URL("../markdown/src/pageText.ts", import.meta.url)),
    "@onden/markdown/page-images": fileURLToPath(new URL("../markdown/src/pageImages.ts", import.meta.url)),
    "@onden/markdown/note-pages": fileURLToPath(new URL("../markdown/src/notePages.ts", import.meta.url)),
    "@onden/markdown/full": fileURLToPath(new URL("../markdown/src/full.ts", import.meta.url)),
    "@onden/markdown/snippet": fileURLToPath(new URL("../markdown/src/snippet.ts", import.meta.url)),
    "@onden/markdown/contract": fileURLToPath(new URL("../markdown/src/sharedContract.ts", import.meta.url)),
    "@onden/markdown": fileURLToPath(new URL("../markdown/src/index.ts", import.meta.url)),
  } },
  test: {
    environment: "node",
    include: ["scripts/bench/*.perf.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 600_000,
  },
});
