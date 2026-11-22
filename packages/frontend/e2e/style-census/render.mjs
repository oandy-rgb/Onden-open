// Rewrite the Markdown report from an existing report.json (after a change in report.mjs; no browser needed).
//   node e2e/style-census/render.mjs [date]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderReport } from "./report.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const r = JSON.parse(readFileSync(join(here, "report.json"), "utf8"));
writeFileSync(join(resolve(here, "../../../../docs/research"), `style-census-${process.argv[2] ?? r.date}.md`), renderReport(r));
