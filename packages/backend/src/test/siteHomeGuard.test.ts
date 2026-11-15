// Site home guard (D116): the published site's home is decided in one place,
// modules/website/publishing/siteHome.ts siteHomeFor. Five places once chose it with
// diverging fallbacks (the Studio, the timeline, the agent effect, the publish
// candidate, the served and static copies). Source scan, like
// bodyWriteGuard.test.ts: no other backend file, and no file of the frontend's
// website module or published site, picks a fallback home — the slug `home`
// rule, or a `home_node_id ?? <first page>` guess.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const backendSrc = join(dirname(fileURLToPath(import.meta.url)), "..");
const frontendSrc = join(backendSrc, "..", "..", "frontend", "src");

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "test" ? [] : sourceFiles(path);
    return /\.(ts|tsx|astro)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// `slug === "home"` / `.slug == 'home'`, and a home id defaulted to a page:
// `home_node_id ?? nodes[0]…`, `homeNodeId ?? startPages.find(…)`.
const SLUG_HOME = /slug\s*===?\s*["']home["']/;
const HOME_GUESS = /home(?:_node_id|NodeId|Id)\s*\?\?\s*[\w.]*(?:\[0\]|\.find\(|firstPage|startPages)/;

describe("site home guard (D116)", () => {
  it("only siteHome.ts picks the published site's home", () => {
    const files = [
      ...sourceFiles(backendSrc),
      ...sourceFiles(join(frontendSrc, "modules", "website")),
      ...sourceFiles(join(frontendSrc, "pages", "site")),
      ...sourceFiles(join(frontendSrc, "published")),
    ];
    expect(files.length).toBeGreaterThan(0);
    const offenders = files
      .filter((file) => !file.endsWith(join("publishing", "siteHome.ts")))
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return SLUG_HOME.test(text) || HOME_GUESS.test(text);
      })
      .map((file) => relative(join(backendSrc, "..", ".."), file).split(sep).join("/"));
    expect(offenders).toEqual([]);
  });
});
