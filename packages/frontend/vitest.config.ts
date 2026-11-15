import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { SkipGateReporter } from "../../scripts/lib/skipGateReporter.mjs";

export default defineConfig({
  plugins: [react()],
  // @onden/markdown is read from source (the backend image alone builds its dist).
  resolve: { alias: [
    // The subpath entries first: an alias matches by prefix, and the local-DB
    // worker may import only slug/ink/snippet (test/workerImports.test.ts).
    { find: "@onden/markdown/slug", replacement: fileURLToPath(new URL("../markdown/src/slug.ts", import.meta.url)) },
    { find: "@onden/markdown/ink", replacement: fileURLToPath(new URL("../markdown/src/ink.ts", import.meta.url)) },
    { find: "@onden/markdown/page-text", replacement: fileURLToPath(new URL("../markdown/src/pageText.ts", import.meta.url)) },
    { find: "@onden/markdown/page-images", replacement: fileURLToPath(new URL("../markdown/src/pageImages.ts", import.meta.url)) },
    { find: "@onden/markdown/full", replacement: fileURLToPath(new URL("../markdown/src/full.ts", import.meta.url)) },
    { find: "@onden/markdown/snippet", replacement: fileURLToPath(new URL("../markdown/src/snippet.ts", import.meta.url)) },
    { find: "@onden/markdown/contract", replacement: fileURLToPath(new URL("../markdown/src/sharedContract.ts", import.meta.url)) },
    { find: "@onden/markdown/media-enhance", replacement: fileURLToPath(new URL("../markdown/src/mediaEnhance.ts", import.meta.url)) },
    { find: "@onden/markdown/steps-enhance", replacement: fileURLToPath(new URL("../markdown/src/stepsEnhance.ts", import.meta.url)) },
    { find: "@onden/markdown/block-id", replacement: fileURLToPath(new URL("../markdown/src/blockId.ts", import.meta.url)) },
    { find: "@onden/markdown/task-parse", replacement: fileURLToPath(new URL("../markdown/src/taskParse.ts", import.meta.url)) },
    { find: "@onden/markdown", replacement: fileURLToPath(new URL("../markdown/src/index.ts", import.meta.url)) },
    // @onden/site's root entry is dist/ in its package.json; the frontend reads
    // it from source too. Exact match only: "@onden/site/react" resolves by the
    // package's own exports (also source).
    { find: /^@onden\/site$/, replacement: fileURLToPath(new URL("../site/src/index.ts", import.meta.url)) },
    // Tests that load backend source (utils.ts) reach @onden/contract, whose entry is dist/: read it from source.
    { find: /^@onden\/contract$/, replacement: fileURLToPath(new URL("../contract/src/index.ts", import.meta.url)) },
  ] },
  test: {
    // happy-dom starts several times faster than jsdom per test file, and per-file start-up, not the tests, was most
    // of a run (2026-11-08: the full suite 1052 s → 589 s with 4 workers). The files that need what only jsdom
    // emulates (focus order, selection, layout, pointer events) say so on their first line: // @vitest-environment jsdom.
    environment: "happy-dom",
    // CSS is empty in tests unless listed here: the print window style is read as text (lib/noteExportPrint.ts).
    css: { include: [/print-export\.css/] },
    globals: true,
    // A test file that needs Postgres (syncFaultSimulation.integration.property.test.ts) skips itself without a `_test`
    // DATABASE_URL; this fails the run for that instead of passing it, unless it was started as a no-database run
    // (`npm run test:no-db`). Details and modes: scripts/lib/skipGateReporter.mjs.
    reporters: ["default", new SkipGateReporter({ strict: "gated", isGated: (_file: string, text: string) => text.includes("process.env.DATABASE_URL") })],
    // This machine has 16 cores and 7 GB RAM: vitest's default (one worker per
    // core) starts ~15 workers and two sessions running the suite at once used
    // 4 GB. Four workers peak near 2 GB (2026-11-08) and take about half the
    // time of two; beyond that the per-file start-up competes and gains little
    // (six: −12 % more for +0.5 GB). Narrow it for one run with --maxWorkers=N.
    maxWorkers: 4,
    // Tests must not depend on order: files and the tests in each file run
    // shuffled. vitest prints the seed at the top of every run ("Running
    // tests with seed …"); rerun that order with --sequence.seed=<seed>, or
    // turn shuffling off for one run with --sequence.shuffle=false.
    sequence: { shuffle: { files: true, tests: true } },
    // Only unit tests under src/. The e2e/ Playwright specs (*.spec.ts) import
    // @playwright/test and must NOT be swept into vitest (they fail to load).
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // *.fuzz.test.ts run by `npm run test:fuzz` (vitest.fuzz.config.ts).
    exclude: ["e2e/**", "node_modules/**", "dist/**", "src/**/*.fuzz.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/test/**", "src/pages/**", "src/env.d.ts"],
    },
  },
});
