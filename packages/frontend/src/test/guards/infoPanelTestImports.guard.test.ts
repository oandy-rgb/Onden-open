// @vitest-environment node
// Guard: a test file that names the info panel loads its modules' files first.
// The panel (NodeInspector → useNoteFunctions) asks for those files with import() as it mounts. A test that ends before they arrive
// leaves the imports running; under load vitest has torn the environment down by then and reports "EnvironmentTeardownError: Cannot
// load … after the environment was torn down", which fails the whole run although every test passed (public CI, 2026-11-17,
// pinned on phoneAiPanel.test.tsx). The answer is one helper, test/helpers/noteFunctionModules.ts; this scan keeps every file on it.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TESTS = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Naming one of these in an import means the file can mount the panel or run its hook. */
const NAMES_THE_PANEL = /["'][^"']*\/(components\/NodeInspector|components\/workspace\/WorkspaceInspector|hooks\/useNoteFunctions)["']/;

describe("tests that mount the info panel", () => {
  it("load the panel's lazily imported files before their tests run", () => {
    const missing = readdirSync(TESTS)
      .filter((name) => /\.test\.tsx?$/.test(name))
      .filter((name) => {
        const text = readFileSync(join(TESTS, name), "utf8");
        return NAMES_THE_PANEL.test(text) && !/^await loadNoteFunctionModules\(\);/m.test(text);
      });
    expect(missing, "add `await loadNoteFunctionModules();` (test/helpers/noteFunctionModules.ts) after the imports").toEqual([]);
  });
});
