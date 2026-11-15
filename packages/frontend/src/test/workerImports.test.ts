// The local-DB worker must load without a DOM. A worker has no `document`:
// a module in its bundle that touches it on load (micromark's browser build of
// decode-named-character-reference runs `document.createElement` at the top
// level) throws, the worker dies and the app waits on it forever. That reached
// prod when the worker imported slugify from the @onden/markdown root (D20).
// Node tests don't see it — they resolve the node builds — so this bundles the
// worker for the browser, the way the app does, and checks what is inside.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "..", "lib", "localDbWorker.ts");
const markdownSrc = join(here, "..", "..", "..", "markdown", "src");

// Markdown-pipeline packages: none belongs in a worker, and some need a DOM.
const DOM_OR_PIPELINE = /node_modules\/(micromark[^/]*|mdast-[^/]*|decode-named-character-reference|unified|remark-[^/]*|rehype-[^/]*|hast-[^/]*)\//;
// Heavy UI / rendering libraries: the worker only stores and syncs rows, so
// none of these belongs in it (the PDF libraries are next to arrive). The
// built worker is checked too, after `astro build` (scripts/check-worker-bundle.mjs).
const HEAVY = /node_modules\/(pdfjs-dist|pdf-lib|@pdf-lib\/[^/]*|katex|highlight\.js|react|react-dom|scheduler|mermaid|@excalidraw\/[^/]*)\//;

// esbuild runs in a child node process: the test environment (jsdom + the
// app's setup file) breaks esbuild's own TextEncoder check.
const esbuildPath = createRequire(import.meta.url).resolve("esbuild");

function workerInputs(): string[] {
  const script = `
    const { build } = require(${JSON.stringify(esbuildPath)});
    build({
      entryPoints: [${JSON.stringify(worker)}], bundle: true, write: false, metafile: true, logLevel: "silent",
      platform: "browser", format: "esm", conditions: ["browser"],
      // @onden/markdown from source (its dist is a build artefact).
      alias: { "@onden/markdown/contract": ${JSON.stringify(markdownSrc + "/sharedContract.ts")}, "@onden/markdown/page-text": ${JSON.stringify(markdownSrc + "/pageText.ts")}, "@onden/markdown": ${JSON.stringify(markdownSrc)} },
      external: ["*.wasm"],
    }).then((r) => process.stdout.write(JSON.stringify(Object.keys(r.metafile.inputs))));`;
  return JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8", maxBuffer: 16 << 20 }));
}

describe("local-DB worker bundle (no DOM in a worker)", () => {
  it("contains no markdown-pipeline or DOM-touching package", () => {
    const inputs = workerInputs();
    expect(inputs.filter((p) => DOM_OR_PIPELINE.test(p))).toEqual([]);
  });

  it("contains no heavy UI or rendering library (PDF, KaTeX, highlight.js, React, Mermaid)", () => {
    const inputs = workerInputs();
    expect(inputs.filter((p) => HEAVY.test(p))).toEqual([]);
  });

  it("still bundles what the worker needs (the check sees real inputs)", () => {
    const inputs = workerInputs();
    expect(inputs.some((p) => p.includes("node_modules/sql.js/"))).toBe(true);
    expect(inputs.some((p) => p.endsWith("markdown/src/slug.ts"))).toBe(true);
    // D76: search snippets, through the @onden/markdown/snippet subpath.
    expect(inputs.some((p) => p.endsWith("markdown/src/snippet.ts"))).toBe(true);
    expect(inputs.some((p) => p.endsWith("markdown/src/index.ts") || p.endsWith("markdown/src/core.ts"))).toBe(false);
  });
});
