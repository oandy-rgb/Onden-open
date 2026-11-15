// Which class names and data-testid values the e2e scripts look for, and which of them exist in src/.
// An e2e check for an element nobody renders any more cannot fail: `expect(locator(".gone")).toHaveCount(0)` is
// green forever, and a `.click()` on it is skipped by whoever wrote `.catch(() => {})`.
// Used by e2eSelectors.guard.test.ts; `node --experimental-strip-types src/test/guards/e2eSelectors.ts` prints the
// current dead selectors as the baseline JSON (so the baseline starts at today's numbers and only shrinks).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const SRC_DIR = join(FRONTEND, "src");
/** The published site's own sheet and templates (`.s-*`) are rendered by packages/site. */
const SITE_SRC_DIR = join(FRONTEND, "../site/src");
export const E2E_DIR = join(FRONTEND, "e2e");

/** Classes drawn by a library, not by src/ (CodeMirror, React Flow, ProseMirror…). */
const LIBRARY_CLASS = /^(cm-|cm6-|react-flow|ProseMirror|katex|hljs|tippy-|mermaid|excalidraw|xterm|leaflet-)/;

const walk = (dir: string, keep: (file: string) => boolean): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".astro" || name === "dist") return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full, keep) : keep(full) ? [full] : [];
  });

/** Everything src/ can render: every identifier-with-hyphens token, plus the prefix of a `name-${x}` class. */
export function sourceVocabulary(): { tokens: Set<string>; prefixes: string[] } {
  const tokens = new Set<string>();
  const prefixes = new Set<string>();
  const product = (f: string) => /\.(tsx?|css|astro|mdx?|html|json)$/.test(f) && !f.includes(`${join("src", "test")}`) && !/\.(test|spec)\.tsx?$/.test(f);
  const files = [...walk(SRC_DIR, product), ...walk(SITE_SRC_DIR, product)];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/[A-Za-z_][\w-]*/g)) tokens.add(m[0]);
    for (const m of text.matchAll(/([A-Za-z_][\w-]*-)(?:\$\{|["'`])/g)) prefixes.add(m[1]);
    for (const m of text.matchAll(/([A-Za-z_][\w-]*)\$\{/g)) prefixes.add(m[1]);
  }
  return { tokens, prefixes: [...prefixes].filter((p) => p.length >= 4) };
}

/** Spec and script files whose selectors must be live. The `zz*` probes only log values (see e2e/probes/README.md). */
export function e2eFiles(): string[] {
  return walk(E2E_DIR, (f) => /\.(ts|mjs)$/.test(f) && !/[\\/]zz[^\\/]*$/.test(f) && !f.includes(`${join("e2e", "probes")}`) && !f.includes(`${join("e2e", "harness")}`) && !/[\\/]run\.mjs$/.test(f))
    .sort();
}

const SELECTOR_CALL = /(?:locator|\$\$?|\$\$?eval|waitForSelector|querySelector(?:All)?|closest|matches|waitForFunction)\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const TESTID_CALL = /getByTestId\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

export interface Use { file: string; kind: "class" | "testid"; name: string; line: number }

/** The selectors a file looks for: classes in selector strings, `[data-testid=…]` values and `getByTestId(…)`. */
export function selectorsUsedBy(file: string, text = readFileSync(file, "utf8")): Use[] {
  const rel = relative(FRONTEND, file).split("\\").join("/");
  const out: Use[] = [];
  const lineOf = (index: number) => text.slice(0, index).split("\n").length;
  for (const m of text.matchAll(SELECTOR_CALL)) {
    const selector = m[2];
    // an attribute value or a quoted text is not a class: take the selector with those cut out
    const bare = selector.replace(/\[[^\]]*\]/g, (attr) => { const id = attr.match(/data-testid\s*[~|^$*]?=\s*["']?([^"'\]]+)/); if (id && !id[1].includes("$")) out.push({ file: rel, kind: "testid", name: id[1], line: lineOf(m.index!) }); return " "; })
      .replace(/:(?:has-text|text|text-is)\([^)]*\)/g, " ").replace(/"[^"]*"|'[^']*'/g, " ");
    // `.item-${i}` names a class built at run time: only the part before `${` is known, so it is not checked
    const plain = bare.replace(/\$\{[^}]*\}/g, "\uE000");
    for (const c of plain.matchAll(/(?:^|[\s>+~,)(\]]|[A-Za-z0-9*])\.(-?[A-Za-z_][\w-]*)(?![\w\uE000-])/g)) {
      out.push({ file: rel, kind: "class", name: c[1], line: lineOf(m.index!) });
    }
  }
  for (const m of text.matchAll(TESTID_CALL)) if (!m[2].includes("$")) out.push({ file: rel, kind: "testid", name: m[2], line: lineOf(m.index!) });
  return out;
}

/** Uses with no counterpart in src/, in source order. */
export function deadSelectors(): Use[] {
  const { tokens, prefixes } = sourceVocabulary();
  const live = (use: Use) => tokens.has(use.name) || prefixes.some((p) => use.name.startsWith(p)) || (use.kind === "class" && LIBRARY_CLASS.test(use.name));
  return e2eFiles().flatMap((file) => selectorsUsedBy(file)).filter((use) => !live(use));
}

/** `{ classes: { "<file> › .name": count }, testIds: { … } }`, the shape of e2e-selectors-baseline.json. */
export function asBaseline(uses: Use[]): { classes: Record<string, number>; testIds: Record<string, number> } {
  const result = { classes: {} as Record<string, number>, testIds: {} as Record<string, number> };
  for (const use of uses) {
    const bucket = use.kind === "class" ? result.classes : result.testIds;
    const key = `${use.file} › ${use.kind === "class" ? "." : ""}${use.name}`;
    bucket[key] = (bucket[key] ?? 0) + 1;
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dead = deadSelectors();
  console.error(`${dead.length} dead uses`);
  console.log(JSON.stringify({ about: "e2e 腳本找的 class／data-testid 在 src/ 已不存在的清單；只准變少（見 e2eSelectors.guard.test.ts）", ...asBaseline(dead) }, null, 2));
}
