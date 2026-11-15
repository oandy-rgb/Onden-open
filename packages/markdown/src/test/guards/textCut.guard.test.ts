// Guard: a person's text is cut short in one way — through @onden/markdown's
// graphemes.ts (cutToUnits, cutToGraphemes, cutToBytes, ellipsize) — because
// String#slice cuts UTF-16 units: `title.slice(0, 80)` leaves half a family
// emoji, a lone surrogate (shown as "�") or a letter without its accent.
//
// This counts the raw cuts `.slice(0, N)` / `.substring(0, N)` (N a number or an
// UPPER_CASE constant) in every package's production source and holds each file
// to its count in textCut.baseline.json. Every file listed there cuts something
// that is not a person's text (an id prefix, a date, a hash, a list of rows);
// a new raw cut of text must use graphemes.ts instead. A new cut of a list or an
// id raises the file's count in the baseline, in review. Removing cuts never fails
// this; lower the baseline when it happens (it only ratchets down):
// UPDATE_TEXTCUT_BASELINE=1 npx vitest run src/test/guards/textCut
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES = fileURLToPath(new URL("../../../../", import.meta.url));
const BASELINE = fileURLToPath(new URL("./textCut.baseline.json", import.meta.url));
const RAW_CUT = /\.(?:slice|substring)\(\s*0\s*,\s*(?:\d[\d_]*|[A-Z][A-Z0-9_]*)\s*\)/g;
const OWNER = "markdown/src/graphemes.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist", "test", "fixtures", "__snapshots__", "vendor"].includes(entry.name) ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec|testing)\./.test(entry.name) ? [path] : [];
  });
}

const code = (text: string) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pkg of ["markdown", "site", "backend", "frontend"]) {
    for (const file of sourceFiles(join(PACKAGES, pkg, "src"))) {
      const n = (code(readFileSync(file, "utf8")).match(RAW_CUT) ?? []).length;
      if (n > 0) out[relative(PACKAGES, file).split(sep).join("/")] = n;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

describe("text is cut with graphemes.ts, not String#slice", () => {
  const found = counts();
  if (process.env.UPDATE_TEXTCUT_BASELINE === "1") writeFileSync(BASELINE, `${JSON.stringify(found, null, 2)}\n`);
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>;

  it("no file has more raw cuts than its baseline", () => {
    const over = Object.entries(found).filter(([file, n]) => n > (baseline[file] ?? 0)).map(([file, n]) => `${file}: ${n} (baseline ${baseline[file] ?? 0})`);
    expect(over, "cut a person's text with cutToUnits / cutToGraphemes / cutToBytes / ellipsize (@onden/markdown); if this is an id, a date or a list, raise the baseline").toEqual([]);
  });

  it("the guard still sees the owner and a known cut (a regex that matched nothing would pass for nothing)", () => {
    expect(readFileSync(join(PACKAGES, OWNER), "utf8")).toContain("export function cutToUnits");
    expect(Object.keys(found).length).toBeGreaterThan(10);
    expect("x.slice(0, 80) y.substring(0, MAX_LABEL)".match(RAW_CUT)).toHaveLength(2);
  });
});
