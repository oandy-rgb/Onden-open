// Shared helpers for the structure guards in this folder: read the real
// sources and scan them, so a duplicate that was merged into one place cannot
// quietly grow back. A guard names what it protects and every exception says why.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const SRC = join(dirname(fileURLToPath(import.meta.url)), "../..");

// Every helper below reads through this cache, so a file is read and stripped of
// comments once per test worker, however many guards and calls scan it (the
// full suite runs ~28 guard files in parallel; re-reading made the first test
// to scan the tree hit the 5s timeout). An entry is reused only while the
// file's mtime and size are unchanged, so a test that rewrites a file it later
// re-reads (a temp file in a self-test) still sees the new content.
type Cached = { stamp: string; text: string; code?: string[] };
const fileCache = new Map<string, Cached>();

function cached(file: string): Cached {
  const st = statSync(file);
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = fileCache.get(file);
  if (hit && hit.stamp === stamp) return hit;
  const entry: Cached = { stamp, text: readFileSync(file, "utf8") };
  fileCache.set(file, entry);
  return entry;
}

/** The raw text of a file (cached per worker; see above). */
export function readSource(file: string): string {
  return cached(file).text;
}

const walkCache = new Map<string, string[]>();

/** Source files under `dir` (relative to src/), tests excluded unless asked. */
export function sourceFiles(dir: string, { tests = false } = {}): string[] {
  const key = `${tests}:${dir}`;
  const hit = walkCache.get(key);
  if (hit) return [...hit];
  const walk = (path: string): string[] => readdirSync(path).flatMap((name) => {
    const full = join(path, name);
    if (statSync(full).isDirectory()) return name === "test" ? [] : walk(full);
    if (!/\.(ts|tsx)$/.test(name)) return [];
    return !tests && /\.test\.tsx?$/.test(name) ? [] : [full];
  });
  const found = walk(join(SRC, dir));
  walkCache.set(key, found);
  return [...found];
}

/** The code of a file: block comments and whole-line `//` comments blanked,
 *  line numbers kept. Prose that names a thing is not a use of it. */
export function codeLines(file: string): string[] {
  const entry = cached(file);
  entry.code ??= entry.text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line));
  Object.freeze(entry.code); // shared between callers: a mutation would leak into other guards
  return entry.code;
}

/** `rel:line` of every code line in `files` matching `pattern`, except files in `allowed`. */
export function findUses(files: string[], pattern: RegExp, allowed: readonly string[] = []): string[] {
  return files.flatMap((file) => {
    const rel = relative(SRC, file);
    if (allowed.includes(rel)) return [];
    return codeLines(file).flatMap((line, i) => (pattern.test(line) ? [`${rel}:${i + 1}`] : []));
  });
}

/** `rel → specifier` of every import in `files` whose specifier matches `pattern`. */
export function findImports(files: string[], pattern: RegExp): string[] {
  return files.flatMap((file) => {
    const text = codeLines(file).join("\n");
    return [...text.matchAll(/(?:from\s+|import\(\s*)["']([^"']+)["']/g)]
      .map((m) => m[1])
      .filter((spec) => pattern.test(spec))
      .map((spec) => `${relative(SRC, file)} → ${spec}`);
  });
}

/** Stylesheets under `dir` (relative to src/). */
export function cssFiles(dir = "."): string[] {
  const walk = (path: string): string[] => readdirSync(path).flatMap((name) => {
    const full = join(path, name);
    if (statSync(full).isDirectory()) return name === "test" ? [] : walk(full);
    return name.endsWith(".css") ? [full] : [];
  });
  return walk(join(SRC, dir));
}

export type CssRule = { file: string; line: number; media: string[]; selector: string; body: string };

/** Every style rule in `file` with the at-rule preludes it sits inside
 *  (`@media (max-width: 600px)`, ...). Comments are blanked; line numbers kept. */
export function cssRules(file: string): CssRule[] {
  const text = readSource(file).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const rel = relative(SRC, file);
  const rules: CssRule[] = [];
  const stack: { prelude: string; at: boolean; line: number; bodyStart: number }[] = [];
  let buf = "";
  let line = 1;
  let bufLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") line++;
    if (ch === "{") {
      const prelude = buf.trim();
      stack.push({ prelude, at: prelude.startsWith("@"), line: bufLine, bodyStart: i + 1 });
      buf = "";
    } else if (ch === "}") {
      const top = stack.pop();
      if (top && !top.at) {
        const body = text.slice(top.bodyStart, i);
        if (!body.includes("{")) {
          rules.push({ file: rel, line: top.line, media: stack.filter((s) => s.at).map((s) => s.prelude), selector: top.prelude, body });
        }
      }
      buf = "";
    } else if (ch === ";" && (stack.length === 0 || stack[stack.length - 1].at)) {
      buf = "";
    } else {
      if (buf.trim() === "" && ch.trim() !== "") bufLine = line;
      buf += ch;
    }
  }
  return rules;
}
