// Guard: every test file and every check script runs in some CI job (owner, 2026-11-22: 「加個測試一定要進ci的守門」).
// Before it, 10 fuzz files, 3 test-astro files, ~38 browser-app scripts, layout:audit, lint:boundaries and more existed
// and no job ran them, so they could rot unseen. scripts/ciReachLib.mjs follows what the workflows really start; the
// only way out is a named reason in scripts/ci-reach-baseline.json, a list that only shrinks.
// The second half proves the guard can fail: a small repository on disk with a test no job runs must be reported.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { gaps, report, workflowRuns } from "../../../../../scripts/ciReachLib.mjs";

const ROOT = join(__dirname, "../../../../..");

describe("every test and check runs in CI", () => {
  it("the repository has no test file or check script that no CI job runs, beyond scripts/ci-reach-baseline.json", () => {
    const result = gaps(ROOT);
    expect(report(result)).toBe("");
  }, 120_000);
});

describe("the guard reports what no job runs (a repository on disk)", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  /** A git repository with these files; the vitest lists are given, not run (vitest is not installed there). */
  function repo(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "ci-reach-"));
    dirs.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    return root;
  }
  const lists: Record<string, string[]> = {
    "packages/a/vitest.config.ts": ["packages/a/src/unit.test.ts"],
    "packages/a/vitest.fuzz.config.ts": ["packages/a/src/parse.fuzz.test.ts"],
  };
  const listVitest = (_root: string, config: string) => lists[config] ?? [];
  const base = {
    "package.json": JSON.stringify({ scripts: {} }),
    "packages/a/package.json": JSON.stringify({ scripts: { test: "vitest run", "test:fuzz": "vitest run --config vitest.fuzz.config.ts", "test:watch": "vitest" } }),
    "packages/a/vitest.config.ts": "", "packages/a/vitest.fuzz.config.ts": "",
    "packages/a/src/unit.test.ts": "", "packages/a/src/parse.fuzz.test.ts": "",
  };
  const ci = (on: string, run: string) => `name: CI\non:\n  ${on}:\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - name: tests\n        working-directory: packages/a\n        run: ${run}\n`;

  it("a fuzz file only its own config owns, and the script that runs it, are reported while no job runs them", () => {
    const root = repo({ ...base, ".github/workflows/ci.yml": ci("push", "npx vitest run") });
    const result = gaps(root, { baseline: {}, listVitest });
    expect(result.files.map((g: { file: string }) => g.file)).toEqual(["packages/a/src/parse.fuzz.test.ts"]);
    expect(result.scripts).toEqual(["packages/a:test:fuzz"]);
    // `test` is reached without being named: the job runs the same config with npx. `test:watch` is a tool, not a check.
  });

  it("a scheduled job that runs the script closes both gaps; a job that only runs by hand does not", () => {
    const scheduled = repo({ ...base, ".github/workflows/ci.yml": ci("push", "npx vitest run"), ".github/workflows/nightly.yml": ci("schedule", "npm run test:fuzz") });
    expect(report(gaps(scheduled, { baseline: {}, listVitest }))).toBe("");
    const manual = repo({ ...base, ".github/workflows/ci.yml": ci("push", "npx vitest run"), ".github/workflows/nightly.yml": ci("workflow_dispatch", "npm run test:fuzz") });
    expect(gaps(manual, { baseline: {}, listVitest }).scripts).toEqual(["packages/a:test:fuzz"]);
  });

  it("a test no runner owns is reported; a reason in the baseline lets it stay out, and a reason for nothing is stale", () => {
    const root = repo({ ...base, "packages/a/src/stray.test.ts": "", ".github/workflows/ci.yml": ci("push", "npx vitest run && npm run test:fuzz") });
    expect(gaps(root, { baseline: {}, listVitest }).files).toEqual([{ file: "packages/a/src/stray.test.ts", why: "no runner owns it" }]);
    const kept = gaps(root, { baseline: { files: { "packages/a/src/stray.test.ts": "measures, asserts nothing" }, scripts: { "packages/a:gone": "old" } }, listVitest });
    expect(kept.files).toEqual([]);
    expect(kept.stale).toEqual(["packages/a:gone"]);
  });

  it("a matrix row's command counts; `covered` holds only when that test runs and imports what the script runs", () => {
    const matrixJob = "name: CI\non: [push]\njobs:\n  w:\n    strategy:\n      matrix:\n        include:\n          - { name: \"fuzz\", dir: packages/a, cmd: \"npm run test:fuzz\" }\n    steps:\n      - working-directory: ${{ matrix.dir }}\n        run: ${{ matrix.cmd }}\n      - working-directory: packages/a\n        run: npx vitest run\n";
    const files = {
      ...base,
      "package.json": JSON.stringify({ scripts: { "dup:check": "node scripts/dup.mjs --check" } }),
      "scripts/dup.mjs": 'import { scan } from "./dupLib.mjs";\n', "scripts/dupLib.mjs": "",
      "packages/a/src/unit.test.ts": 'import { scan } from "../../../scripts/dupLib.mjs";\n',
      "packages/a/src/other.test.ts": "",
      ".github/workflows/ci.yml": matrixJob,
    };
    lists["packages/a/vitest.config.ts"] = ["packages/a/src/unit.test.ts", "packages/a/src/other.test.ts"];
    const root = repo(files);
    expect(gaps(root, { baseline: {}, listVitest }).scripts).toEqual([".:dup:check"]);
    expect(report(gaps(root, { baseline: { covered: { ".:dup:check": "packages/a/src/unit.test.ts" } }, listVitest }))).toBe("");
    const wrong = gaps(root, { baseline: { covered: { ".:dup:check": "packages/a/src/other.test.ts" } }, listVitest });
    expect(wrong.unproven).toEqual([".:dup:check → packages/a/src/other.test.ts"]);
    expect(wrong.scripts).toEqual([".:dup:check"]);
    lists["packages/a/vitest.config.ts"] = ["packages/a/src/unit.test.ts"];
  });

  it("a vitest path filter reaches only that folder; a Playwright ignore, run-all's list and a node --test glob are read", () => {
    lists["packages/a/vitest.config.ts"] = ["packages/a/src/unit.test.ts", "packages/a/src/guards/g.test.ts"];
    const files = {
      ...base,
      "packages/a/src/guards/g.test.ts": "",
      "packages/frontend/e2e/playwright.config.ts": 'const IGNORED_SPECS = process.env.E2E_CLOUD === "1" ? /(off|big)\\.spec\\.ts/ : /off\\.spec\\.ts/;\nexport default { testDir: "./fullstack", testIgnore: IGNORED_SPECS };\n',
      "packages/frontend/e2e/fullstack/run.sh": "docker run playwright test\n",
      "packages/frontend/e2e/fullstack/on.spec.ts": "", "packages/frontend/e2e/fullstack/off.spec.ts": "",
      "packages/frontend/e2e/browser-app/run-all.mjs": 'const FEATURES = [["listed.mjs"]];\n',
      "packages/frontend/e2e/browser-app/listed.mjs": "", "packages/frontend/e2e/browser-app/unlisted.mjs": "",
      "packages/d/test/one.test.mjs": "", "packages/d/package.json": "{}",
      ".github/workflows/ci.yml": ci("push", "npx vitest run src/guards && npm run test:fuzz && bash ../frontend/e2e/fullstack/run.sh && node ../frontend/e2e/browser-app/run-all.mjs && node --test ../d/test/*.test.mjs"),
    };
    const result = gaps(repo(files), { baseline: {}, listVitest });
    expect(result.files.map((g: { file: string }) => g.file).sort()).toEqual([
      "packages/a/src/unit.test.ts", // only src/guards ran
      "packages/frontend/e2e/browser-app/unlisted.mjs",
      "packages/frontend/e2e/fullstack/off.spec.ts", // in the config's ignore list
    ]);
    lists["packages/a/vitest.config.ts"] = ["packages/a/src/unit.test.ts"];
  });

  it("run.sh --config <other> runs that config, not the default one; a computed testMatch owns nothing", () => {
    const files = {
      ...base,
      "packages/frontend/package.json": JSON.stringify({ scripts: { "e2e:scan": "bash e2e/fullstack/run.sh --config scan.config.ts" } }),
      "packages/frontend/e2e/playwright.config.ts": 'export default { testDir: "./fullstack", testMatch: /.*\\.spec\\.ts/ };\n',
      "packages/frontend/e2e/scan.config.ts": "const testMatch = pick();\nexport default { projects: [{ name: 'webkit', testMatch }] };\n",
      "packages/frontend/e2e/fullstack/run.sh": "docker run playwright test\n",
      "packages/frontend/e2e/fullstack/a.spec.ts": "",
    };
    const onlyDefault = repo({ ...files, ".github/workflows/ci.yml": ci("push", "npx vitest run && npm run test:fuzz && bash ../frontend/e2e/fullstack/run.sh") });
    expect(gaps(onlyDefault, { baseline: {}, listVitest }).scripts).toEqual(["packages/frontend:e2e:scan"]);
    const scanToo = repo({ ...files, ".github/workflows/ci.yml": ci("push", "npx vitest run && npm run test:fuzz && bash ../frontend/e2e/fullstack/run.sh && cd ../frontend && npm run e2e:scan") });
    expect(report(gaps(scanToo, { baseline: {}, listVitest }))).toBe("");
    const scanOnly = repo({ ...files, ".github/workflows/ci.yml": ci("push", "npx vitest run && npm run test:fuzz && cd ../frontend && npm run e2e:scan") });
    expect(gaps(scanOnly, { baseline: {}, listVitest }).files.map((g: { file: string }) => g.file)).toEqual(["packages/frontend/e2e/fullstack/a.spec.ts"]);
  });

  it("follows cd, npm -w, and the shell scripts a step starts", () => {
    const root = repo({
      ...base,
      "scripts/lane.sh": 'step() { :; }\nstep "fuzz" npm run -s test:fuzz -w packages/a\n',
      ".github/workflows/ci.yml": ci("pull_request", "cd .. && cd .. && bash scripts/lane.sh && cd packages/a && npx vitest run"),
    });
    const runs = workflowRuns(root);
    expect(runs).toHaveLength(1);
    expect(report(gaps(root, { baseline: {}, listVitest }))).toBe("");
  });
});
