import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { SkipGateReporter } from "../../scripts/lib/skipGateReporter.mjs";
import { PGLITE_SKIPS, POSTGRES_SKIPS } from "./src/test/helpers/pgliteSkipList";

// Limit vitest discovery to src/. Without this, compiled JS under dist/test/
// gets picked up alongside the source TS, causing duplicate (and stale)
// test runs against an out-of-date snapshot of the codebase.
export default defineConfig({
  // @onden/markdown is read from source (the production image alone builds its dist).
  resolve: { alias: {
    // The subpath first: an alias matches by prefix.
    // slug and snippet: the frontend's local-DB worker, which the mirror
    // property test (src/test/properties/mirror.property.test.ts) loads, imports them.
    "@onden/markdown/slug": fileURLToPath(new URL("../markdown/src/slug.ts", import.meta.url)),
    "@onden/markdown/snippet": fileURLToPath(new URL("../markdown/src/snippet.ts", import.meta.url)),
    "@onden/markdown/contract": fileURLToPath(new URL("../markdown/src/sharedContract.ts", import.meta.url)),
    "@onden/markdown/ink": fileURLToPath(new URL("../markdown/src/ink.ts", import.meta.url)),
    "@onden/markdown/page-text": fileURLToPath(new URL("../markdown/src/pageText.ts", import.meta.url)),
    "@onden/markdown/page-images": fileURLToPath(new URL("../markdown/src/pageImages.ts", import.meta.url)),
    "@onden/markdown/full": fileURLToPath(new URL("../markdown/src/full.ts", import.meta.url)),
    "@onden/markdown/block-id": fileURLToPath(new URL("../markdown/src/blockId.ts", import.meta.url)),
    "@onden/markdown": fileURLToPath(new URL("../markdown/src/index.ts", import.meta.url)),
    // @onden/site is read from source too (its entry imports @onden/markdown/block-id).
    "@onden/contract": fileURLToPath(new URL("../contract/src/index.ts", import.meta.url)),
    "@onden/site": fileURLToPath(new URL("../site/src/index.ts", import.meta.url)),
  } },
  test: {
    include: ["src/**/*.test.ts"],
    // *.fuzz.test.ts run by `npm run test:fuzz` (vitest.fuzz.config.ts).
    exclude: ["dist/**", "node_modules/**", "src/**/*.fuzz.test.ts"],
    // The *.integration.test.ts files all run against ONE shared onden_test and
    // each scrubs workspace-scoped tables in beforeAll (content_nodes, etc.).
    // Run files serially so one file's beforeAll can't delete another file's
    // fixtures mid-test — the shared DB makes cross-file isolation impossible
    // otherwise. Unit files are unaffected by the ordering; the cost is a
    // slightly slower suite, bought for determinism.
    fileParallelism: false,
    // Order-independent by contract: files and the tests inside each file run
    // in a random order every run. The seed is printed at the start of the run
    // (src/test/globalSetup.ts); `--sequence.seed=<n>` replays that order.
    sequence: { shuffle: { files: true, tests: true } },
    // Rebuilds the one shared test database from db/schema.sql (keep it with
    // ONDEN_TEST_DB_KEEP=1) and prints the shuffle seed.
    globalSetup: ["src/test/globalSetup.ts"],
    // Ends every run with how many tests ran and how many skipped, and fails it when DB-gated tests (or, on PGlite,
    // anything) skipped without the run being an explicit no-database run: `npm run test:no-db`. The modes, and the
    // skip lists a driver may use, are in scripts/lib/skipGateReporter.mjs and src/test/helpers/pgliteSkipList.ts.
    reporters: ["default", new SkipGateReporter({
      strict: "all",
      // A test file is DB-gated when it names one of the gates (helpers/testDatabase.ts, helpers/pgliteSkips.ts).
      isGated: (_file: string, text: string) => /\bisTestDb\b|\bisTestDatabase\(|process\.env\.DATABASE_URL|\bdbName\b|\bdbDriver\b|\bONDEN_DB_DRIVER\b|\bneeds(SecondConnection|PostgresServer|Pgroonga)\b/.test(text),
      expected: { pglite: PGLITE_SKIPS, postgres: POSTGRES_SKIPS },
    })],
    // Report-only: ONDEN_REPORT_CORE_WRITES=<file> lists core writes outside mutate()/withEventTransaction().
    setupFiles: ["src/test/reportCoreWrites.ts"],
    // Files run one at a time already; this caps the pool too (7 GB RAM, 16
    // cores; see frontend vitest.config.ts). Widen with --maxWorkers=N.
    maxWorkers: 2,
    // A time limit is there to catch a test that hangs, not to measure speed. On a hosted 2-core runner with a real
    // Postgres (fsync on every commit) ordinary integration tests passed 5 s: four or five different ones each run
    // on 2026-11-15, never the same set. CI gets room; a laptop keeps the default so a slow test is still seen.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    hookTimeout: process.env.CI ? 60_000 : 10_000,
    // Integration files register several users against one app; the deployed
    // default (first account only) would refuse the second (see auth.ts).
    env: { ONDEN_SIGNUP: "open", ONDEN_FORBID_POOL_QUERY_IN_TRANSACTION: "1", ONDEN_FORBID_UNSTAMPED_WRITES: "1" },
  },
});
