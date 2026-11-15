// `npm run bench`: seeds the _bench database if needed, runs the backend,
// frontend and bundle measurements, and writes bench-results.json at the
// repo root. `npm run bench:check` compares that file with bench-budgets.json.
//
//   npm run bench                  everything (seed on first use, production build)
//   npm run bench -- --runs=15     more repetitions per metric (default 9)
//   npm run bench -- --reuse-build skip the production build, measure packages/frontend/dist
//   npm run bench -- --only=backend | frontend | bundle
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { repoRoot } from "../lib/paths.mjs";
import { renderTable, formatValue } from "./table.mjs";
import { measureBundle } from "./bundle.mjs";
import { summarize } from "./stats.mjs";

const root = repoRoot;
const benchDir = resolve(root, ".bench");
const args = process.argv.slice(2);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const runs = Number(option("runs") ?? 9);
const only = option("only");
const reuseBuild = args.includes("--reuse-build");
const wants = (part) => !only || only === part;

function run(label, command, commandArgs, cwd, env = {}) {
  console.log(`\n== ${label}`);
  const result = spawnSync(command, commandArgs, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) {
    console.error(`\n${label} failed (exit ${result.status}).`);
    if (label.startsWith("backend")) console.error("The backend part needs a local Postgres 16; see docs/performance-budgets.md.");
    process.exit(result.status ?? 1);
  }
}

mkdirSync(benchDir, { recursive: true });
const parts = {};

if (wants("backend") || wants("frontend")) {
  // The frontend part decodes the bootstrap the backend part writes, so the backend part always runs first.
  run("backend: service functions on the 20k-note database", "npx", ["tsx", "scripts/bench/run.ts", `--runs=${runs}`], resolve(root, "packages/backend"));
  parts.backend = JSON.parse(readFileSync(resolve(benchDir, "backend.json"), "utf8"));
}
if (wants("frontend")) {
  run("frontend: real app code in Node", "npx", ["vitest", "run", "--config", "vitest.perf.config.ts"], resolve(root, "packages/frontend"), { BENCH_RUNS: String(runs) });
  parts.frontend = JSON.parse(readFileSync(resolve(benchDir, "frontend.json"), "utf8"));
}
if (wants("bundle")) {
  if (!reuseBuild) run("bundle: production build of the frontend", "npm", ["-w", "packages/frontend", "run", "build"], root);
  const dist = resolve(root, "packages/frontend/dist/client");
  if (!existsSync(dist)) { console.error(`No build at ${dist}; run without --reuse-build.`); process.exit(1); }
  const sizes = measureBundle(dist);
  parts.bundle = {
    part: "bundle", detail: sizes.detail,
    metrics: Object.fromEntries(Object.entries(sizes.bytes).map(([name, bytes]) => [name, summarize([bytes], "bytes")])),
  };
}

const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" }).stdout.trim();
const metrics = Object.assign({}, ...Object.values(parts).map((p) => p.metrics));
const skipped = Object.assign({}, parts.backend?.skipped);
const results = {
  meta: {
    date: new Date().toISOString(), commit: git("rev-parse", "--short", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    node: process.version, platform: `${os.platform()} ${os.arch()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model,
    runs, only: only ?? "all",
    dataset: parts.backend?.shape, hasPgroonga: parts.backend?.hasPgroonga,
    schemaSkips: parts.backend?.skippedSchema, payload: parts.backend?.extra,
  },
  metrics, skipped, bundle: parts.bundle?.detail,
};
if (only) {
  // A partial run updates only its own metrics and keeps the rest of the previous file.
  const previous = existsSync(resolve(root, "bench-results.json")) ? JSON.parse(readFileSync(resolve(root, "bench-results.json"), "utf8")) : null;
  if (previous) results.metrics = { ...previous.metrics, ...metrics };
}
writeFileSync(resolve(root, "bench-results.json"), `${JSON.stringify(results, null, 2)}\n`);

console.log("\nResults (median / p95 over the runs; bundle sizes are single measurements):\n");
console.log(renderTable(
  ["metric", "median", "p95", "runs"],
  [...Object.entries(metrics).map(([name, s]) => [name, formatValue(s.median, s.unit), formatValue(s.p95, s.unit), String(s.runs.length)]),
    ...Object.entries(skipped).map(([name, why]) => [name, "skipped", "", why])],
  [false, true, true, false],
));
console.log("\nWritten to bench-results.json. Compare with the budgets: npm run bench:check");
