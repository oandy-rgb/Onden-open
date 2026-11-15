import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// A raw React.lazy has no stale-chunk handling: after a deploy, an open tab's
// first visit to that feature shows the error screen (lib/lazyWithReload.ts).
describe("code-split components go through lazyWithReload", () => {
  it("no raw React lazy( outside lib/lazyWithReload.ts", () => {
    const src = resolve(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { if (name !== "test") walk(path); continue; }
        if (!/\.(ts|tsx)$/.test(name) || /\.(test|spec)\.tsx?$/.test(name)) continue;
        const rel = relative(src, path);
        if (rel === join("lib", "lazyWithReload.ts")) continue;
        const text = readFileSync(path, "utf8");
        if (/(^|[^\w.])lazy\s*\(/m.test(text) || /\bReact\.lazy\b/.test(text)) offenders.push(rel);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
