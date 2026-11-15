import { mergeConfig } from "vitest/config";
import base from "../../../../../../../packages/backend/vitest.config.js";
import { fileURLToPath } from "node:url";

export default mergeConfig(base, {
  root: fileURLToPath(new URL("../../../../../../../packages/backend", import.meta.url)),
  test: { setupFiles: [fileURLToPath(new URL("./recordSetup.ts", import.meta.url))], maxWorkers: 1 },
});
