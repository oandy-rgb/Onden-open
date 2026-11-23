// WebKit / iPhone / iPad scan: the specs in webkitScanSpecs.ts on the Safari engine at desktop, phone and tablet sizes.
// Run on the stack with `npm run e2e:webkit-scan` (packages/frontend), or daily in CI (ci.yml job scheduled-webkit, started by .github/workflows/scheduled.yml).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { devices } from "@playwright/test";
import base from "./playwright.config";
import { SCAN_PROJECTS, invalidScanSpecs, scanSpecsFor, unmatchedScanSpecs, webkitScanMatch, type ScanProject } from "./webkitScanSpecs";

// Playwright loads a .ts config as CommonJS: `import.meta` there fails at load ("exports is not defined in ES module scope").
const missing = unmatchedScanSpecs(readdirSync(join(__dirname, "fullstack")));
if (missing.length) throw new Error(`webkitScanSpecs.ts names specs that do not exist: ${missing.join(", ")}`);

const invalid = invalidScanSpecs();
if (invalid.length) throw new Error(`webkitScanSpecs.ts: every spec must name the projects it runs on (${SCAN_PROJECTS.join(", ")}): ${invalid.join("; ")}`);

const testMatch = (project: ScanProject) => webkitScanMatch(scanSpecsFor(project));
export default {
  ...base,
  projects: [
    { name: "webkit", testMatch: testMatch("webkit"), use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } } },
    { name: "mobile-safari", testMatch: testMatch("mobile-safari"), use: { ...devices["iPhone 13"] } },
    { name: "ipad", testMatch: testMatch("ipad"), use: { ...devices["iPad Pro 11"] } },
  ],
};
