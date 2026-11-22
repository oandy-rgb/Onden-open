// WebKit / iPhone / iPad scan: the specs in webkitScanSpecs.ts on the Safari engine at desktop, phone and tablet sizes.
// Run on the stack with `npm run e2e:webkit-scan` (packages/frontend), or nightly (.github/workflows/nightly.yml).
import { readdirSync } from "node:fs";
import { devices } from "@playwright/test";
import base from "./playwright.config";
import { unmatchedScanSpecs, webkitScanMatch } from "./webkitScanSpecs";

const missing = unmatchedScanSpecs(readdirSync(new URL("./fullstack", import.meta.url).pathname));
if (missing.length) throw new Error(`webkitScanSpecs.ts names specs that do not exist: ${missing.join(", ")}`);

const testMatch = webkitScanMatch();
export default {
  ...base,
  projects: [
    { name: "webkit", testMatch, use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } } },
    { name: "mobile-safari", testMatch, use: { ...devices["iPhone 13"] } },
    { name: "ipad", testMatch, use: { ...devices["iPad Pro 11"] } },
  ],
};
