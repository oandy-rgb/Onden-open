import { defineConfig, devices } from "@playwright/test";

// Full-stack e2e config. Runs against the isolated stack on :5099 (compose.e2e
// .yaml). global-setup signs up once + dismisses onboarding + saves storageState
// (cookie auth, which is valid in any engine), so every spec starts
// authenticated. The first-run storage picker isn't carried in storageState on
// non-chromium engines, so cross-engine specs dismiss it defensively (see
// fullstack/helpers.ts).
const BASE = process.env.E2E_BASE || "http://localhost:5099";

// Specs worth running on every browser engine + mobile viewport: pure UI /
// interaction surface (rendering, responsiveness, CodeMirror, capture). The
// API/perf/back-end specs (perf, usecases, smoke, interactions, soak) are
// engine-agnostic and stay on chromium only — running them ×5 would just be
// slow without testing anything new.
// inkTouch: touch / pen input on the handwriting page (T1-1) — the WebKit
// projects are the closest we get to iPad Safari without a device.
// editorLinkFollow: Ctrl/Cmd+click on desktop, tap / chip on the phone projects.
const CROSS_ENGINE = /(crossbrowser|inkTouch|editorLinkFollow)\.spec\.ts/;
const DESKTOP = { viewport: { width: 1280, height: 800 } };

// Fault-injection group (fullstack/faults/, tagged @faults): blocks requests,
// kills workers, shrinks quotas and some scenarios wait on a 15 s idle
// compaction, so it runs as its OWN project — Chromium only, serial, long
// timeout — and the ordinary projects ignore the directory. A spec dropped into
// faults/ is picked up by directory; no tag or config edit needed.
// It is part of a plain `run.sh` (no args) and of `--grep @faults` / a path under
// faults/; `--grep @critical` and other subsets only select it if a fault test
// also carries that tag. E2E_SKIP_FAULTS=1 removes the project entirely.
const FAULTS_DIR = /[\\/]faults[\\/]/;
const SKIP_FAULTS = process.env.E2E_SKIP_FAULTS === "1";
// Individual scenarios set their own timeout (up to 180 s); this is the ceiling
// for ones that do not, and covers the hooks around them.
const FAULTS_TIMEOUT_MS = 240_000;

// The specs every project skips: officialSite always (see testIgnore below), and on the cloud stack
// (E2E_CLOUD=1, PGlite) scaleIntegrity too. One constant, because a project-level testIgnore replaces the
// global one: the chromium project used to repeat only officialSite, so the cloud run still poured 5000+
// notes into PGlite and every spec after it timed out.
const IGNORED_SPECS = process.env.E2E_CLOUD === "1" ? /(officialSite|scaleIntegrity)\.spec\.ts/ : /officialSite\.spec\.ts/;

export default defineConfig({
  testDir: "./fullstack",
  testMatch: /.*\.spec\.ts/,
  // officialSite.spec.ts is a host-only dogfood screenshot generator: it imports
  // app data from ../../src, which is NOT mounted into the e2e container, so the
  // import throws at Playwright's COLLECTION phase and aborts the ENTIRE run
  // (Playwright loads every spec file to discover tests — one bad import takes
  // the whole suite down, even a --grep subset). Skip it here; run it directly
  // on the host (where ../../src resolves) to refresh the official-site shots.
  // 雲端堆疊（cloud-stack.mjs 設 E2E_CLOUD=1，後端是 PGlite）另外略過 B 類：scaleIntegrity 灌 5000+ 筆記，
  // PGlite（單連線）跑它要 4 分多鐘且之後的每個 API 都逾時，會連累字母序在它後面的所有 spec；留給真 Postgres 的筆電。
  testIgnore: IGNORED_SPECS,
  fullyParallel: false, // one shared stack; serial keeps perf numbers stable
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  // Outputs to /tmp: in the playwright container /work is a read-mostly bind
  // mount under a non-root --user; keep run artifacts off it.
  outputDir: "/tmp/pw-output/out",
  globalSetup: "./fullstack/global-setup.ts",
  use: {
    baseURL: BASE,
    storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
  },
  projects: [
    // chromium runs the whole suite except the fault group (own project below).
    // A project-level testIgnore replaces the global one, so repeat it.
    { name: "chromium", testIgnore: [IGNORED_SPECS, FAULTS_DIR], use: { ...devices["Desktop Chrome"], ...DESKTOP } },
    // Other engines + mobile viewports only run the cross-engine UI spec.
    { name: "firefox", testMatch: CROSS_ENGINE, use: { ...devices["Desktop Firefox"], ...DESKTOP } },
    { name: "webkit", testMatch: CROSS_ENGINE, use: { ...devices["Desktop Safari"], ...DESKTOP } },
    { name: "mobile-chrome", testMatch: CROSS_ENGINE, use: { ...devices["Pixel 5"] } },
    { name: "mobile-safari", testMatch: CROSS_ENGINE, use: { ...devices["iPhone 13"] } },
    // Last, so a slow or failing fault scenario never delays the rest of the run.
    // The phone variants inside the specs set their own device via test.use.
    ...(SKIP_FAULTS
      ? []
      : [{
          name: "faults",
          testMatch: /[\\/]faults[\\/].*\.spec\.ts/,
          timeout: FAULTS_TIMEOUT_MS,
          fullyParallel: false,
          use: { ...devices["Desktop Chrome"], ...DESKTOP },
        }]),
  ],
});
