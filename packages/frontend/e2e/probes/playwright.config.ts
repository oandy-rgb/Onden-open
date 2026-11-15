import { devices } from "@playwright/test";
import base from "../playwright.config";

// The probes (zz*.spec.ts here) run against the same stack, storage state and global setup as fullstack/, in one
// Chromium project and serially. They are NOT part of the fullstack suite: see README.md in this folder.
export default {
  ...base,
  testDir: ".",
  testMatch: /zz.*\.spec\.ts/,
  testIgnore: undefined,
  projects: [{ name: "probes", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } }],
};
