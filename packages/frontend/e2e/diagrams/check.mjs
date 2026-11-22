// Real-browser check of the diagram laying-out (lib/diagramPrecompile.ts): mermaid
// draws each sample in Chromium, the extractor reads the layout back, and a block
// it cannot read faithfully falls back. Writes a side-by-side screenshot.
//   node packages/frontend/e2e/diagrams/check.mjs [out.png]
// Needs the repo's node_modules (playwright, esbuild, mermaid); no server.
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../../../package.json"));
// Playwright is the e2e package's own dependency (packages/frontend/e2e/package.json), not the root's.
const { chromium } = createRequire(path.join(here, "../package.json"))("playwright");
const esbuild = require("esbuild");
const mermaidDir = path.dirname(require.resolve("mermaid/dist/mermaid.esm.min.mjs"));

const bundle = await esbuild.build({
  entryPoints: [path.join(here, "page.ts")], bundle: true, write: false, format: "iife", logLevel: "error",
  alias: { "@onden/markdown": path.join(here, "../../../markdown/src/index.ts") }, nodePaths: [path.join(here, "../../../../node_modules")],
});

// [name, source, expected readable]
const SAMPLES = [
  ["flowchart: shapes, groups, line styles", "flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|yes| C(Go)\n  B -.->|no| D[Wait]\n  subgraph S [Group]\n    C --> E((x))\n  end\n  D --- E\n  C ==> F{{hex}}", true],
  ["graph LR: arrow kinds and a loop", "graph LR\n  A[One] --> B[Two]\n  B --> C[Three]\n  C -->|back| A\n  B --x D[Four]\n  B --o E[Five]\n  A <--> D", true],
  ["state diagram with a composite state", "stateDiagram-v2\n  [*] --> Still\n  Still --> Moving: push\n  state Moving {\n    Walk --> Run\n  }\n  Moving --> [*]", true],
  ["shapes drawn as paths (stadium, cylinder) fall back", "flowchart TD\n  A[Line one<br/>Line two] --> B([Stadium])\n  B --> C[(DB)]", false],
  ["an init directive that turns HTML labels back on falls back (labels would be unreadable)", "%%{init: {\"htmlLabels\": true, \"flowchart\":{\"htmlLabels\":true}}}%%\nflowchart TD\n  A[Start] --> B[Go]", false],
  ["a sequence diagram is not precompiled", "sequenceDiagram\n  A->>B: hi", false],
];

const srv = http.createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (url === "/") { res.setHeader("content-type", "text/html"); return res.end("<html><body></body></html>"); }
  if (url === "/page.js") { res.setHeader("content-type", "text/javascript"); return res.end(bundle.outputFiles[0].text); }
  try { res.setHeader("content-type", "text/javascript"); res.end(fs.readFileSync(path.join(mermaidDir, url))); } catch { res.statusCode = 404; res.end(); }
}).listen(0);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  page.on("pageerror", (e) => { throw e; });
  await page.goto(`http://localhost:${srv.address().port}/`);
  await page.addScriptTag({ url: "/page.js" });
  const results = await page.evaluate(async (sources) => {
    const mermaid = (await import("/mermaid.esm.min.mjs")).default;
    return await window.run(mermaid, sources);
  }, SAMPLES.map((s) => s[1]));
  SAMPLES.forEach(([name,, readable], i) => assert.equal(results[i].ok, readable, `${name}: ${JSON.stringify(results[i])}`));
  assert.deepEqual([results[0].nodes, results[0].edges, results[0].groups], [6, 6, 1]);
  assert.deepEqual([results[2].nodes, results[2].edges, results[2].groups], [5, 4, 1]);
  await page.screenshot({ path: process.argv[2] ?? path.join(process.env.TMPDIR ?? "/tmp", "diagrams-precompile.png"), fullPage: true });
  console.log("diagram precompile: ok", JSON.stringify(results));
} finally { await browser.close(); srv.close(); }
