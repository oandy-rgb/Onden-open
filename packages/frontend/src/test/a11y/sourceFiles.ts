import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { resolve } from "node:path";

// vitest runs from packages/frontend (npm test, -w …).
export const SRC = resolve(process.cwd(), "src") + "/";

/** Repo-relative-to-src paths (posix) of every file under `dir` with one of `extensions`, tests left out. */
export function sourceFiles(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((e) => entry.name.endsWith(e)) && !/\.(test|spec)\./.test(entry.name)) {
        out.push(relative(SRC, full).split("\\").join("/"));
      }
    }
  };
  walk(join(SRC, dir));
  return out.sort();
}

export const readSource = (path: string): string => readFileSync(join(SRC, path), "utf8");
