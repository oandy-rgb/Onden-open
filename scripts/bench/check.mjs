// `npm run bench:check`: bench-results.json against bench-budgets.json.
// Exits 1 when a metric's median is over its budget, or a budgeted metric is
// missing from the results (a skipped one, e.g. search without pgroonga, is
// reported but does not fail).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "../lib/paths.mjs";
import { formatValue, renderTable } from "./table.mjs";

const root = repoRoot;
const read = (file) => JSON.parse(readFileSync(resolve(root, file), "utf8"));

if (!existsSync(resolve(root, "bench-results.json"))) {
  console.error("No bench-results.json; run `npm run bench` first.");
  process.exit(2);
}
const { budgets, pending = {} } = read("bench-budgets.json");
const results = read("bench-results.json");

let failed = 0;
const rows = Object.entries(budgets).map(([name, budget]) => {
  const now = results.metrics?.[name];
  if (!now) {
    const why = results.skipped?.[name];
    if (!why) failed++;
    return [name, formatValue(budget.median, budget.unit), why ? "skipped" : "missing", "", why ? "skipped" : "FAIL"];
  }
  const delta = ((now.median - budget.median) / budget.median) * 100;
  const over = now.median > budget.median;
  if (over) failed++;
  return [name, formatValue(budget.median, budget.unit), formatValue(now.median, now.unit), `${delta >= 0 ? "+" : ""}${delta.toFixed(0)}%`, over ? "FAIL" : "ok"];
});

console.log(renderTable(["metric", "budget", "now", "± budget", "result"], rows, [false, true, true, true, false]));
for (const [name, why] of Object.entries(pending)) console.log(`no budget yet: ${name} (${why})`);
console.log(`\nbench-results.json from ${results.meta?.commit ?? "?"} (${results.meta?.date ?? "?"}), ${results.meta?.runs ?? "?"} runs per metric.`);
if (failed) {
  console.error(`\n${failed} metric(s) over budget or missing. A single failure on a noisy machine: rerun \`npm run bench\` first; a real regression repeats.`);
  process.exit(1);
}
console.log("\nAll budgets met.");
