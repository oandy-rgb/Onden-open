// Every literal t("…") / tr("…") key in app code must have a zh-TW entry. t() falls
// back to the English literal, so a missing key shows English in a Chinese
// UI without failing anywhere else.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZH_TW as BOOT_ZH_TW } from "../lib/i18n.zh-TW";

// A part loaded later (the info panel's 「AI」 tab) keeps its strings in its own
// strings.zh-TW.ts and registers them when it loads; they count here too.
const LATER = import.meta.glob<Record<string, Record<string, string>>>("../**/strings.zh-TW.ts", { eager: true });
const ZH_TW: Record<string, string> = Object.assign({}, BOOT_ZH_TW, ...Object.values(LATER).flatMap((mod) => Object.values(mod)));

// A feature's own screen wording, loaded with the screen (modules/<id>/i18n.zh-TW.ts, registerDictionary).
const MODULE_WORDING: Record<string, string> = Object.assign({}, ...Object.values(
  import.meta.glob<Record<string, Record<string, string>>>("../modules/*/i18n.zh-TW.ts", { eager: true }),
).flatMap((exports) => Object.values(exports)));

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Only files that use the app-UI t() (layer B); the published site's own
// locale helper (components/templates/siteLocale.ts) is a different dictionary.
const USES_APP_T = /from\s+["'](?:\.\.?\/)+(?:lib\/)?i18n["']/;
const LITERAL_KEY = /(?<![\w.$])(?:t|tr)\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')\s*[,)]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function unquote(literal: string): string {
  if (literal.startsWith('"')) return JSON.parse(literal) as string;
  return JSON.parse(`"${literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string;
}

describe("zh-TW dictionary", () => {
  it("has an entry for every literal t() key", () => {
    const missing: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      if (!USES_APP_T.test(text)) continue;
      for (const match of text.matchAll(LITERAL_KEY)) {
        const key = unquote(match[1]!);
        if (!(key in ZH_TW) && !(key in MODULE_WORDING)) missing.push(`${relative(SRC, file)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
