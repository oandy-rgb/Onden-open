import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Two workers and shuffled order, as in the markdown package.
export default defineConfig({
  resolve: {
    // @onden/markdown is read from source (its dist exists only in the backend image).
    alias: {
      "@onden/markdown/block-id": fileURLToPath(new URL("../markdown/src/blockId.ts", import.meta.url)),
      "@onden/markdown": fileURLToPath(new URL("../markdown/src/index.ts", import.meta.url)),
    },
  },
  esbuild: { jsx: "automatic" },
  test: {
    maxWorkers: 2,
    sequence: { shuffle: { files: true, tests: true } },
  },
});
