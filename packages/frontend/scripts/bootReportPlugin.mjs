// Vite plugin: after the client build, writes dist/boot-report.json — the JS the
// app loads for sure after sign-in (the page entry and the workspace chunk,
// with everything they import statically), and how much of it each
// src/modules/<id>/ directory brings. scripts/check-boot-bundle.mjs reads it.
// Rollup knows which source file went into which chunk; the shipped files
// are minified, so this is the only place per-directory sizes can be had.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

// How many source files (whole boot JS) and per boot chunk the report lists, biggest first:
// `npm run build` prints them so growth shows up as a name, not just a total.
const TOP_FILES = 40;
const TOP_PER_CHUNK = 15;
const WORKSPACE_FILE = "/src/components/BuilderWorkspace.tsx";

/** The directory a source file counts for: a module's id, or "core". */
export function ownerOf(moduleId) {
  const hit = /\/src\/modules\/([^/]+)\//.exec(moduleId.replaceAll("\\", "/"));
  return hit ? hit[1] : "core";
}

/** The npm package a bundled file comes from, or null for the app's own code. */
export function packageOf(moduleId) {
  const hit = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(moduleId.replaceAll("\\", "/"));
  return hit ? hit[1] : null;
}

/** Chunks reachable from `roots` through static imports only. */
export function staticClosure(bundle, roots) {
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name) || !bundle[name] || bundle[name].type !== "chunk") continue;
    seen.add(name);
    stack.push(...bundle[name].imports);
  }
  return seen;
}

/** The report for one finished bundle, or null when it holds no page entry. */
export function bootReport(bundle) {
  const chunks = Object.values(bundle).filter((c) => c.type === "chunk");
  const holding = (suffix) => chunks.filter((c) => Object.keys(c.modules).some((id) => id.replaceAll("\\", "/").includes(suffix)));
  // The page script, the island's component (AppRoot is client:only, so the
  // page script reaches it by a dynamic import) and the signed-in workspace.
  const roots = [...holding("/src/pages/index.astro"), ...holding("/src/AppRoot.tsx"), ...holding(WORKSPACE_FILE)];
  if (!holding(WORKSPACE_FILE).length || !holding("/src/AppRoot.tsx").length) return null;
  const boot = staticClosure(bundle, roots.map((c) => c.fileName));
  const modules = {};
  let rawTotal = 0;
  let gzipTotal = 0;
  const packages = new Set();
  /** @type {Record<string, number>} */
  const files = {};
  /** @type {Record<string, {gzip: number, top: Array<{file: string, gzip: number}>}>} */
  const chunkTop = {};
  for (const name of boot) {
    const chunk = bundle[name];
    const raw = Buffer.byteLength(chunk.code);
    const gz = gzipSync(chunk.code).length;
    rawTotal += raw;
    gzipTotal += gz;
    const rendered = Object.entries(chunk.modules);
    const renderedSum = rendered.reduce((n, [, m]) => n + m.renderedLength, 0) || 1;
    // A chunk's final (minified) size is split by each file's share of the
    // rendered text: an estimate, good to a few percent.
    for (const [id, m] of rendered) {
      const pkg = packageOf(id);
      if (pkg) packages.add(pkg);
      const owner = ownerOf(id);
      const share = m.renderedLength / renderedSum;
      const row = (modules[owner] ??= { raw: 0, gzip: 0 });
      row.raw += raw * share;
      row.gzip += gz * share;
      const file = id.replaceAll("\\", "/").replace(/^.*?\/(?=src\/|node_modules\/)/, "").replace(/\?.*$/, "");
      files[file] = (files[file] ?? 0) + gz * share;
      (chunkTop[name] ??= { gzip: gz, top: [] }).top.push({ file, gzip: Math.round(gz * share) });
    }
  }
  for (const entry of Object.values(chunkTop)) entry.top = entry.top.sort((a, b) => b.gzip - a.gzip).slice(0, TOP_PER_CHUNK);
  const topFiles = Object.entries(files).sort((a, b) => b[1] - a[1]).slice(0, TOP_FILES).map(([file, gzip]) => ({ file, gzip: Math.round(gzip) }));
  for (const row of Object.values(modules)) { row.raw = Math.round(row.raw); row.gzip = Math.round(row.gzip); }
  return { chunks: [...boot].sort(), rawTotal, gzipTotal, modules, packages: [...packages].sort(), topFiles, chunkTop };
}

const LATE_DICTIONARY = new URL("../src/lib/i18n.zh-TW.late.ts", import.meta.url);

/** Keys of the late zh-TW dictionary (src/lib/i18n.zh-TW.late.ts) that a boot chunk
 *  holds as a string literal: the boot JS shows them, so they belong in the boot half
 *  (i18n.zh-TW.boot.ts) or the first screen would flash English. */
export function lateKeysInBoot(bundle, bootChunks, lateSource = readFileSync(LATE_DICTIONARY, "utf8")) {
  const code = [...bootChunks].map((name) => bundle[name].code).join("\n");
  const found = [];
  for (const line of lateSource.split("\n")) {
    const hit = /^  ("(?:[^"\\]|\\.)*"):\s/.exec(line);
    if (!hit) continue;
    const key = JSON.parse(hit[1]);
    if (/[\\\n$`]/.test(key)) continue;
    if (code.includes(`"${key.replaceAll('"', '\\"')}"`) || code.includes(`'${key.replaceAll("'", "\\'")}'`) || code.includes("`" + key + "`")) found.push(key);
  }
  return found;
}

const BOOT_DICTIONARY = new URL("../src/lib/i18n.zh-TW.boot.ts", import.meta.url);

/** Keys of the boot zh-TW dictionary that no boot chunk uses: a dictionary entry in the
 *  chunk is the key literal, a colon and a quote followed by its own wording; any other
 *  occurrence of the literal is a use. Such a string is for a screen loaded on use, so it
 *  belongs in the late half (i18n.zh-TW.late.ts, which lazyWithReload waits for) and must
 *  not weigh on every first load. */
export function bootKeysUnused(bundle, bootChunks, bootSource = readFileSync(BOOT_DICTIONARY, "utf8")) {
  const code = [...bootChunks].map((name) => bundle[name].code).join("\n");
  const unused = [];
  for (const line of bootSource.split("\n")) {
    const hit = /^  ("(?:[^"\\]|\\.)*"):\s("(?:[^"\\]|\\.)*"),?$/.exec(line);
    if (!hit) continue;
    const key = JSON.parse(hit[1]);
    const wording = JSON.parse(hit[2]).slice(0, 2);
    const literals = [JSON.stringify(key), `'${key.replaceAll("'", "\\'")}'`, "`" + key + "`"];
    const used = literals.some((lit) => {
      for (let at = code.indexOf(lit); at >= 0; at = code.indexOf(lit, at + 1)) {
        const end = at + lit.length;
        const isEntry = code[end] === ":" && /["'`]/.test(code[end + 1] ?? "") && code.startsWith(wording, end + 2);
        if (!isEntry) return true;
      }
      return false;
    });
    if (!used) unused.push(key);
  }
  return unused;
}

export default function bootReportPlugin() {
  return {
    name: "onden-boot-report",
    apply: "build",
    generateBundle(options, bundle) {
      const report = bootReport(bundle);
      if (!report) return;
      const file = join(process.cwd(), "dist", "boot-report.json");
      const wrongHalf = lateKeysInBoot(bundle, report.chunks);
      if (wrongHalf.length) {
        this.error(`${wrongHalf.length} zh-TW string(s) are in src/lib/i18n.zh-TW.late.ts but the boot JS uses them ` +
          `(move each line to src/lib/i18n.zh-TW.boot.ts): ${wrongHalf.slice(0, 8).map((k) => JSON.stringify(k)).join(", ")}${wrongHalf.length > 8 ? ", …" : ""}`);
      }
      const idle = bootKeysUnused(bundle, report.chunks);
      if (idle.length) {
        this.error(`${idle.length} zh-TW string(s) are in src/lib/i18n.zh-TW.boot.ts but no boot code uses them ` +
          `(move each line to src/lib/i18n.zh-TW.late.ts): ${idle.slice(0, 8).map((k) => JSON.stringify(k)).join(", ")}${idle.length > 8 ? ", …" : ""}`);
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(report, null, 2));
      const kb = (n) => `${(n / 1024).toFixed(1)}`;
      console.log("\n[boot] boot JS by chunk, biggest source files in each (gzip KiB, share-of-chunk estimate):");
      for (const [name, entry] of Object.entries(report.chunkTop).sort((a, b) => b[1].gzip - a[1].gzip)) {
        console.log(`  ${name} ${kb(entry.gzip)}`);
        for (const t of entry.top) console.log(`    ${kb(t.gzip).padStart(6)}  ${t.file}`);
      }
    },
  };
}
