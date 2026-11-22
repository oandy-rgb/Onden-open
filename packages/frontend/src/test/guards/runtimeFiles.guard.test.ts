// @vitest-environment node
// A file the app loads at run time by its address must be in every build that ships the app.
// Why: 2026-11-17, the browser version (vite.browser.config.ts) took a hand-written list of files from public/ and
// the PDF viewer's worker was not on it: a PDF note said 「無法載入這份 PDF」 on the live site while the server build,
// which copies all of public/, worked. Each part was right; the list in one build was not.
//
// What this checks, for each build that ships the React app:
//   1. every file in public/ that the app's source names by address (the PDF worker, the local database's wasm, the
//      fonts the styles ask for, the icons, the manifest, the service worker) is emitted by that build, or is on
//      NOT_NEEDED below with the reason it is not needed there;
//   2. every other file the browser version fetches next to its page (`new URL("x.js", documentBaseUrl())`) is named
//      in EMITTED_BY_BROWSER_BUILD, and the build step that emits it still names it.
//
// The builds (what "emitted" means for each is computed from the build's own config, not copied here):
//   web      astro.config.mjs → dist/client. Astro copies all of public/. The desktop app packs this folder as it is
//            (packages/desktop/scripts/stage.mjs), so it has no list of its own.
//   capacitor vite.capacitor.config.ts → dist-cap. Vite's default public/ copy. The Android shell's webDir is that
//            folder (capacitor.config.ts), and android/ keeps no list of web files.
//   browser  vite.browser.config.ts: publicDir is off; only the plugin's FROM_PUBLIC list is copied. The only build
//            where a file can be missing — it is the one this test mostly exists for.
// Not covered: run-time URLs built from data (a server-chosen address, a user's media), and the files of the browser
// version that scripts/build-browser.mjs makes outside Vite (worker.js, build.json) beyond "the script still names them".
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import browserConfig from "../../../vite.browser.config";
import capacitorConfig from "../../../vite.capacitor.config";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PUBLIC = join(FRONTEND, "public");
const SRC = join(FRONTEND, "src");
const read = (path: string) => readFileSync(join(FRONTEND, path), "utf8");

function walk(dir: string, accept: (name: string) => boolean, skip: (path: string) => boolean = () => false, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (skip(path)) continue;
    if (statSync(path).isDirectory()) { if (name !== "node_modules") walk(path, accept, skip, out); }
    else if (accept(name)) out.push(path);
  }
  return out;
}
const posix = (from: string, path: string) => relative(from, path).split(sep).join("/");

// ── the files the source names by address ───────────────────────────────────────────────────────────────────────────
const publicFiles = walk(PUBLIC, () => true).map((p) => posix(PUBLIC, p));
const sourceFiles = [
  ...walk(SRC, (n) => /\.(ts|tsx|astro|css|mjs)$/.test(n), (p) => p.startsWith(join(SRC, "test"))),
  join(FRONTEND, "browser.html"), join(FRONTEND, "index.html"), join(PUBLIC, "manifest.webmanifest"),
].map((path) => ({ path: posix(FRONTEND, path), text: readFileSync(path, "utf8") }));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The address as the source writes it: in quotes or url(), with "/" or "./" in front; a folder's files by the folder
 *  (the local database builds `sql.js/${file}`). */
function namedBy(file: string): string[] {
  const dir = file.includes("/") ? file.slice(0, file.indexOf("/")) : null;
  const re = dir
    ? new RegExp(`["'\`(](?:\\.?/)?${escape(dir)}/`)
    : new RegExp(`["'\`(](?:\\.?/)?${escape(file)}["'\`)?#]`);
  return sourceFiles.filter((f) => re.test(f.text)).map((f) => f.path);
}
const referenced = publicFiles.map((file) => ({ file, by: namedBy(file) })).filter((r) => r.by.length > 0);

// ── what each build emits ───────────────────────────────────────────────────────────────────────────────────────────
interface Plugin { name?: string; generateBundle?: (this: { emitFile(f: { type: string; fileName: string }): void }) => void }
function emittedByPlugins(config: { plugins?: unknown }): string[] {
  const emitted: string[] = [];
  const plugins = (config.plugins as unknown[]).flat(Infinity) as Plugin[];
  for (const plugin of plugins) plugin?.generateBundle?.call({ emitFile: (f) => emitted.push(f.fileName) });
  return emitted;
}
const browserConfigObject = browserConfig as { publicDir?: unknown; plugins?: unknown };
const capacitorConfigObject = capacitorConfig as { publicDir?: unknown; build?: { outDir?: string } };

const BUILDS: { id: string; why: string; emitted: Set<string> }[] = [
  { id: "web", why: "Astro copies all of public/", emitted: new Set(publicFiles) },
  { id: "capacitor", why: "Vite's default copy of public/", emitted: new Set(publicFiles) },
  { id: "browser", why: "vite.browser.config.ts, publicDir off, its plugin's list", emitted: new Set(emittedByPlugins(browserConfigObject)) },
];

/** Files the source names that a build does not need, with the reason. Only the browser version has any. */
// ratchet:list RUNTIME_FILE_NOT_NEEDED
const NOT_NEEDED: [build: string, file: string, reason: string][] = [
  ["browser", "sw.js", "the web page (pages/index.astro) registers it for offline use; the browser version has nothing to cache offline (its page and backend are the same files) and registers media-sw.js instead"],
];
// Files the browser version fetches next to its page, and where each one comes from.
const EMITTED_BY_BROWSER_BUILD: Record<string, { from: string; names: string }> = {
  "media-sw.js": { from: "vite.browser.config.ts", names: "media-sw.js" },
  "worker.js": { from: "scripts/build-browser.mjs", names: "worker.js" },
  "build.json": { from: "scripts/build-browser.mjs", names: "build.json" },
};

describe("every file the app loads by address is in every build", () => {
  it("the web and Android builds really copy all of public/ (the assumption the two rows above rest on)", () => {
    expect(read("astro.config.mjs"), "astro.config.mjs must not move or turn off publicDir").not.toMatch(/publicDir/);
    expect(capacitorConfigObject.publicDir, "the Capacitor build must keep Vite's default public/ copy").toBeUndefined();
    expect(browserConfigObject.publicDir, "the browser version's public/ copy is off: its plugin's list is the list").toBe(false);
    // The Android shell serves exactly the folder Vite writes, and the desktop app packs exactly Astro's.
    expect(read("capacitor.config.ts")).toContain(`webDir: "${capacitorConfigObject.build?.outDir}"`);
    expect(read("../desktop/scripts/stage.mjs")).toContain('"packages/frontend/dist/client"');
    expect(existsSync(join(FRONTEND, "android", "app", "src", "main", "assets", "public"))).toBe(false); // generated by `cap sync`, never committed
  });

  it("finds the files this guard exists for (so an empty scan cannot pass)", () => {
    const named = new Map(referenced.map((r) => [r.file, r.by]));
    expect(named.get("pdf.worker.min.mjs")).toContain("src/lib/pdf/pdfjs.ts");
    expect(named.get("sql.js/sql-wasm-browser.wasm")).toContain("src/lib/localDbWorker.ts");
    expect(named.get("fonts/plex-sans-400.woff2")).toContain("src/styles/fonts.css");
    expect(named.get("icon-192.png")).toContain("public/manifest.webmanifest");
  });

  for (const build of BUILDS) {
    it(`${build.id} build (${build.why}) emits each of them`, () => {
      const waived = new Set(NOT_NEEDED.filter(([id]) => id === build.id).map(([, file]) => file));
      const missing = referenced.filter(({ file }) => !build.emitted.has(file) && !waived.has(file));
      expect(
        missing.map(({ file, by }) => `${file} (named by ${by.join(", ")})`),
        `these are fetched by address at run time but the ${build.id} build does not emit them: add each to the build's list, or to NOT_NEEDED with the reason`,
      ).toEqual([]);
    });
  }

  it("NOT_NEEDED holds only real files, real builds, and reasons that are still true (it may only get shorter)", () => {
    for (const [id, file, reason] of NOT_NEEDED) {
      const build = BUILDS.find((b) => b.id === id);
      expect(build, `unknown build ${id}`).toBeDefined();
      expect(publicFiles, `${file} is not in public/ any more: delete the line`).toContain(file);
      expect(build!.emitted.has(file), `${id} emits ${file} now: delete the line`).toBe(false);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("the browser version's other run-time files (next to its page) are all accounted for", () => {
    const fetched = new Set<string>();
    for (const f of sourceFiles) for (const m of f.text.matchAll(/new URL\(\s*["']([\w.-]+\.(?:js|mjs|json|wasm))["']\s*,\s*documentBaseUrl\(\)/g)) fetched.add(m[1]);
    expect([...fetched].sort(), "a file fetched next to the page is not in EMITTED_BY_BROWSER_BUILD: say which build step makes it").toEqual(Object.keys(EMITTED_BY_BROWSER_BUILD).sort());
    for (const [file, { from, names }] of Object.entries(EMITTED_BY_BROWSER_BUILD)) {
      expect(read(`${from.startsWith("scripts/") ? "../../" : ""}${from}`), `${from} no longer names ${file}`).toContain(names);
    }
    expect(emittedByPlugins(browserConfigObject)).toContain("media-sw.js");
  });
});
