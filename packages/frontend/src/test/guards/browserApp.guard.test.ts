// The browser app (src/browserApp, built by `npm run build:browser`) is a second entry of the same React app.
// The normal web build must neither load it nor pay for it: nothing but its own files and its own page
// (browser.html) may name it, and the Astro build never sees it. docs/architecture/browser-app.md §8.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = join(FRONTEND, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "node_modules") walk(path, out); }
    else if (/\.(ts|tsx|astro|css|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

const rel = (path: string) => relative(SRC, path).split(sep).join("/");
const files = walk(SRC).map((path) => ({ path: rel(path), text: readFileSync(path, "utf8") }));

describe("the browser app stays out of the normal build", () => {
  it("no file outside src/browserApp (and the tests) imports it or its three lib files", () => {
    const importers = files
      .filter((f) => !f.path.startsWith("browserApp/") && !f.path.startsWith("test/") && !/^lib\/browserApp(Bridge|Worker|Media)\.ts$/.test(f.path))
      .filter((f) => /from\s+["'][^"']*\/browserApp\/|import\(["'][^"']*\/browserApp\/|\/browserAppBridge["']|\/browserAppWorker["']/.test(f.text))
      .map((f) => f.path);
    expect(importers, "the browser app is entered from browser.html only").toEqual([]);
  });

  it("only browser.html starts it, and the Astro pages and the Capacitor entry know nothing of it", () => {
    expect(readFileSync(join(FRONTEND, "browser.html"), "utf8")).toContain("/src/browserApp/main.tsx");
    for (const entry of ["index.html", "astro.config.mjs", "vite.capacitor.config.ts"]) {
      expect(readFileSync(join(FRONTEND, entry), "utf8"), `${entry} must not name the browser app`).not.toMatch(/browserApp|browser\.html|VITE_BROWSER_APP/);
    }
    const pages = files.filter((f) => f.path.startsWith("pages/")).filter((f) => /browserApp|VITE_BROWSER_APP/.test(f.text));
    expect(pages.map((f) => f.path)).toEqual([]);
  });

  it("the flag that tells code it runs in the browser app is set by its own build only", () => {
    const users = files.filter((f) => /VITE_BROWSER_APP/.test(f.text) && !f.path.startsWith("test/")).map((f) => f.path);
    // localDbWorker finds sql.js beside the page's assets there; nothing else may branch on it.
    expect(users).toEqual(["lib/localDbWorker.ts"]);
    expect(readFileSync(join(FRONTEND, "vite.browser.config.ts"), "utf8")).toContain('"import.meta.env.VITE_BROWSER_APP"');
  });

  it("its page is a plain static folder: the worker file it starts is built by the script, not imported", () => {
    const shell = readFileSync(join(SRC, "browserApp/BrowserAppShell.tsx"), "utf8");
    expect(shell).toContain('new URL("worker.js", documentBaseUrl())');
    expect(existsSync(join(FRONTEND, "../../scripts/build-browser.mjs"))).toBe(true);
  });
});
