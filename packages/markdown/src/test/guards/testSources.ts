// Every test file and e2e script of the packages, for the guards that read how tests are written
// (seedRandom, knownCases). Paths are relative to packages/.
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGES = fileURLToPath(new URL("../../../../", import.meta.url));

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist", "fixtures", "__snapshots__", "playwright-report", "test-results"].includes(entry.name) ? [] : testFiles(path);
    return /\.(ts|tsx|mjs)$/.test(entry.name) ? [path] : [];
  });
}

const rel = (file: string) => relative(PACKAGES, file).split(sep).join("/");
const isTest = (path: string) => /\.(test|spec)\.tsx?$/.test(path) || /\/test\/(helpers|properties)\//.test(path) || /^frontend\/e2e\//.test(path) || /\/src\/test\//.test(path);

export const TEST_FILES = ["markdown", "site", "backend", "frontend", "contract"]
  .flatMap((pkg) => testFiles(join(PACKAGES, pkg)))
  .map(rel)
  .filter(isTest);
