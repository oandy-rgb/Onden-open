// pdf.js browser compatibility guard (see src/lib/pdf/pdfjs.ts).
//
// The modern pdfjs-dist build calls new built-ins such as
// Map#getOrInsertComputed and Math.sumPrecise without a feature check, so the
// viewer breaks on any browser or Android WebView that lacks them. Onden ships
// the legacy build, which bundles core-js polyfills. These tests check that:
//   1. app code imports only the legacy build;
//   2. the vendored worker is the legacy worker of the installed version;
//   3. every risky built-in that a shipped pdf.js file calls is polyfilled in
//      the same JS realm. The worker runs in its own scope, so main-thread
//      polyfills do not reach it.
// If (3) fails after a pdfjs-dist upgrade, pdf.js started calling a built-in
// that is newer than our floor and is not polyfilled. Add a polyfill that is
// loaded in that realm, or wait for a pdfjs-dist release that bundles one.
// Do not just delete the row.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const frontend = join(here, "..", "..");
const pdfjsRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const read = (p: string) => readFileSync(p, "utf8");

const LEGACY_CORE = join(pdfjsRoot, "legacy/build/pdf.mjs");
const LEGACY_WORKER = join(pdfjsRoot, "legacy/build/pdf.worker.min.mjs");
const VENDORED_WORKER = join(frontend, "public/pdf.worker.min.mjs");

type Risky = {
  /** Readable name, for failure messages. */
  name: string;
  /** How a call site looks in the bundle (survives minification). */
  use: RegExp;
  /** core-js installs it as `$({ target: "<target>", ... }, { <key>: ... })`. */
  targets: string[];
  key: string;
};

const proto = (target: string, key: string, targets = [target]): Risky => ({
  name: `${target}.prototype.${key}`,
  use: new RegExp(`\\.${key}\\(`),
  targets,
  key,
});
const stat = (target: string, key: string): Risky => ({
  name: `${target}.${key}`,
  use: new RegExp(`\\b${target}\\.${key}\\(`),
  targets: [target],
  key,
});
const iter = (key: string): Risky => ({
  name: `Iterator.prototype.${key}`,
  use: new RegExp(`\\.(?:values|keys|entries)\\(\\)\\.${key}\\(`),
  targets: ["Iterator"],
  key,
});

// Built-ins newer than pdf.js legacy's stated floor (Chrome 125, Firefox ESR,
// Safari 18). Versions are from MDN browser-compat-data 8.1.6 (Chrome / Safari
// / Firefox). Rows that pdf.js does not call today are a watch list: they fail
// only once a shipped file calls them without a polyfill.
// At or below the floor, so not listed: ArrayBuffer#transferToFixedLength
// (114/17.4/122; pdfjs-dist 6.2 calls it unguarded in the worker, 2026-10-24),
// structuredClone (98/15.4/94),
// Array#findLast (97/15.4/104), AbortSignal.any (116/17.4/124), private class
// methods (84/15/90). Float16Array, OffscreenCanvas, ImageDecoder and
// ReadableStream async iteration are feature-detected by pdf.js.
const RISKY: Risky[] = [
  proto("Map", "getOrInsertComputed", ["Map", "WeakMap"]), // 145 / 26.2 / 144
  proto("Map", "getOrInsert", ["Map", "WeakMap"]), // 145 / 26.2 / 144
  stat("Math", "sumPrecise"), // 147 / 26.2 / 137
  proto("Uint8Array", "toBase64"), // 140 / 18.2 / 133
  proto("Uint8Array", "toHex"), // 140 / 18.2 / 133
  proto("Uint8Array", "setFromBase64"), // 140 / 18.2 / 133
  proto("Uint8Array", "setFromHex"), // 140 / 18.2 / 133
  stat("Uint8Array", "fromBase64"), // 140 / 18.2 / 133
  stat("Uint8Array", "fromHex"), // 140 / 18.2 / 133
  stat("RegExp", "escape"), // 136 / 18.2 / 134
  stat("Promise", "try"), // 128 / 18.2 / 134
  stat("Promise", "withResolvers"), // 119 / 17.4 / 121
  stat("URL", "parse"), // 126 / 18 / 126
  proto("Set", "intersection"), // 122 / 17 / 127
  proto("Set", "union"),
  proto("Set", "difference"),
  proto("Set", "symmetricDifference"),
  proto("Set", "isSubsetOf"),
  proto("Set", "isSupersetOf"),
  proto("Set", "isDisjointFrom"),
  iter("map"), // Iterator helpers: 122 / 18.4 / 131
  iter("filter"),
  iter("some"),
  iter("every"),
  iter("find"),
  iter("reduce"),
  iter("forEach"),
  iter("flatMap"),
  iter("take"),
  iter("drop"),
  iter("toArray"),
  // Watch list: not called by pdfjs-dist 6.0.227.
  stat("Iterator", "concat"),
  stat("Iterator", "zip"),
  stat("Array", "fromAsync"),
  stat("Error", "isError"),
  stat("Math", "f16round"),
  stat("Atomics", "pause"),
  stat("Object", "groupBy"),
  stat("Map", "groupBy"),
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True if `code` contains a core-js export of `key` onto `target`. */
function polyfills(code: string, target: string, key: string): boolean {
  const head = new RegExp(`target\\s*:\\s*["']${escapeRe(target)}["']`, "g");
  // The key may be quoted ('try') or follow a `// eslint-disable` line.
  const keyRe = new RegExp(`[{,]\\s*(?://[^\\n]*\\n\\s*)*["']?${escapeRe(key)}["']?\\s*:`);
  for (const m of code.matchAll(head)) {
    // The options object is short; the methods object follows right after it.
    if (keyRe.test(code.slice(m.index, m.index + 400))) return true;
  }
  return false;
}

/** Risky built-ins called somewhere in `files` but not polyfilled in them. */
function unpolyfilled(files: string[]): string[] {
  const codes = files.map(read);
  const all = codes.join("\n");
  return RISKY.filter((r) => codes.some((c) => r.use.test(c)))
    .filter((r) => !r.targets.every((t) => polyfills(all, t, r.key)))
    .map((r) => r.name);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "test" ? [] : sourceFiles(p);
    return /\.(ts|tsx|astro|mjs|js)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
  });
}

describe("pdf.js compatibility (legacy build)", () => {
  it("app code imports only pdfjs-dist/legacy/*", () => {
    const offenders = sourceFiles(join(frontend, "src")).flatMap((file) => {
      const specs = [...read(file).matchAll(/(?:from|import\()\s*["'](pdfjs-dist[^"']*)["']/g)].map((m) => m[1]);
      return specs.filter((s) => !s.startsWith("pdfjs-dist/legacy/")).map((s) => `${relative(frontend, file)}: ${s}`);
    });
    expect(offenders).toEqual([]);
  });

  it("public/pdf.worker.min.mjs is the installed legacy worker, byte for byte", () => {
    // Worker and API versions must match exactly, and the worker must be the
    // legacy build. Fix: cp node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs public/
    expect(readFileSync(VENDORED_WORKER).equals(readFileSync(LEGACY_WORKER))).toBe(true);
  });

  it("main thread: every risky built-in pdf.js calls is polyfilled (the core: the viewer is not shipped)", () => {
    expect(unpolyfilled([LEGACY_CORE])).toEqual([]);
  });

  it("worker scope: every risky built-in the vendored worker calls is polyfilled in it", () => {
    expect(unpolyfilled([VENDORED_WORKER])).toEqual([]);
  });

  it("the check catches the modern build (detector sanity)", () => {
    const modernWorker = unpolyfilled([join(pdfjsRoot, "build/pdf.worker.min.mjs")]);
    expect(modernWorker).toEqual(expect.arrayContaining(["Map.prototype.getOrInsertComputed", "Math.sumPrecise"]));
    const modernMain = unpolyfilled([join(pdfjsRoot, "build/pdf.mjs"), join(pdfjsRoot, "web/pdf_viewer.mjs")]);
    expect(modernMain).toEqual(expect.arrayContaining(["Map.prototype.getOrInsertComputed", "RegExp.escape", "Promise.try"]));
  });
});
