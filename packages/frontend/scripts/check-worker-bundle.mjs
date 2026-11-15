// After a build: the BUILT local-DB worker (localDbWorker-*.js) must stay free
// of heavy libraries and within a size budget. A worker has no DOM, and on
// 2026-10-16 micromark (whose browser build runs `document.createElement` on
// load) reached it through one import: the worker died at boot and the app
// spun on 「正在確認工作區資料」 forever. src/test/workerImports.test.ts checks
// the worker's inputs, but only under vitest; this runs in `npm run build` (and
// so in the Docker image build), on the file that actually ships.
//
//   node scripts/check-worker-bundle.mjs app        dist/client/_astro/localDbWorker-*.js
//   node scripts/check-worker-bundle.mjs <file.js>  one file, app budget (for testing the check)
//
// Fails when a worker contains a marker of a forbidden library (strings that
// survive minification), or is larger than its budget (about 1.25x its size on
// 2026-10-18). If the worker grew on purpose, raise the budget here, in the
// same PR, and say why. The worker holds the device copy and its sync only:
// feature logic (diffs, parsing, layout) runs on the page and hands the worker
// the result. Near the budget, look at what came in before raising it.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const TARGETS = {
  // 2026-10-18: the worker was 74,588 B; budget = 1.25x, rounded.
  // 2026-10-24: raised to 99,000 B. The worker is 94,401 B: the snapshot save
  // is now a compare-and-swap with a stale-tab reload, a backoff and a page
  // notice, and it catches up with other tabs' journal (offline-queue fixes);
  // no import was added.
  // 2026-10-30: raised to 99,200 B. The worker is 99,055 B: the search
  // snippet keeps a combining-mark term whole (the highlight and the window
  // edge); no import was added.
  // 2026-10-30: raised to 114,000 B (owner's OK). The worker is 98,949 B with
  // 51 B left, so nearly any change to shared code failed the build; it grew
  // about 0.7 KB a day over the last week (offline data kinds, no libraries).
  // About 1.15x its size; the library markers below are the guard that matters.
  app: { dir: "dist/client/_astro", budget: 114_000 },
};

// [marker, library]: package-specific strings that minifiers keep (string
// literals, property names, global names).
const MARKERS = [
  ["GlobalWorkerOptions", "pdfjs-dist"],
  ["pdfjs", "pdfjs-dist"],
  ["pdf-lib", "pdf-lib"],
  ["micromark", "micromark"],
  ["codeFencedFence", "micromark"],
  ["createElement", "a DOM-touching module (e.g. decode-named-character-reference, React)"],
  ["katex", "katex"],
  ["hljs", "highlight.js"],
  ["react.element", "react"],
  ["react.transitional.element", "react"],
  ["react.fragment", "react"],
  ["__reactFiber", "react-dom"],
  ["__reactContainer", "react-dom"],
  ["mermaid", "mermaid"],
  ["excalidraw", "@excalidraw/excalidraw"],
];

const kb = (n) => `${(n / 1024).toFixed(1)} KiB (${n.toLocaleString("en-US")} B)`;

function workersIn(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((f) => /^localDbWorker-.*\.js$/.test(f)).map((f) => join(abs, f));
}

const args = process.argv.slice(2);
const jobs = [];
const problems = [];
for (const arg of args.length ? args : ["app"]) {
  if (TARGETS[arg]) {
    const files = workersIn(TARGETS[arg].dir);
    if (!files.length) problems.push(`${arg}: no localDbWorker-*.js in ${TARGETS[arg].dir} (did the build run? was the worker renamed?)`);
    for (const file of files) jobs.push({ file, budget: TARGETS[arg].budget });
  } else if (existsSync(arg)) {
    jobs.push({ file: arg, budget: TARGETS.app.budget });
  } else {
    problems.push(`unknown target or missing file: ${arg}`);
  }
}

for (const { file, budget } of jobs) {
  const code = readFileSync(file, "utf8");
  const size = Buffer.byteLength(code);
  const name = relative(ROOT, file);
  const found = MARKERS.filter(([m]) => code.includes(m));
  console.log(`worker ${name}: ${kb(size)}, budget ${kb(budget)}${found.length ? "" : ", no forbidden library"}`);
  for (const [m, lib] of found) problems.push(`${name} contains "${m}" -> ${lib} got into the local-DB worker`);
  if (size > budget) problems.push(`${name} is ${kb(size)}, over its budget of ${kb(budget)}`);
}

if (problems.length) {
  console.error("\ncheck-worker-bundle: FAILED");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("\nThe worker has no DOM and must stay small; a heavy import kills it at boot and the app hangs.");
  console.error("Find the import chain (src/test/workerImports.test.ts lists the worker's inputs) and cut it,");
  console.error("e.g. import a subpath (@onden/markdown/slug) instead of a package root.");
  process.exit(1);
}
