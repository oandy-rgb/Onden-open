import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@onden/pairing": fileURLToPath(new URL("../pairing/src/index.ts", import.meta.url)) } },
  test: { sequence: { shuffle: { files: true, tests: true } } },
});
