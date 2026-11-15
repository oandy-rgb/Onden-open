import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // @onden/markdown is read from source (its dist exists only in the backend image).
  resolve: { alias: { "@onden/markdown": fileURLToPath(new URL("../markdown/src/index.ts", import.meta.url)) } },
  test: { sequence: { shuffle: { files: true, tests: true } } },
});
