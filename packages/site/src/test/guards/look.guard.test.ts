// Guard: the slides' code reads the site's look only through @onden/site/look
// (src/look.ts), and that door never opens onto the registry, validation, React or Puck.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES = fileURLToPath(new URL("../../../../", import.meta.url));
const code = (text: string) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return ["node_modules", "dist"].includes(entry.name) ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [path] : [];
  });
}

describe("@onden/site/look", () => {
  it("imports only style.ts, palette.ts and design.ts (types)", () => {
    const text = code(readFileSync(join(PACKAGES, "site/src/look.ts"), "utf8"));
    const from = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(from.sort()).toEqual(["./design.js", "./design.js", "./style.js", "./style.js"]);
  });
  it("is the only part of @onden/site the slides module imports", () => {
    const dir = join(PACKAGES, "frontend/src/modules/slides");
    const bad = sourceFiles(dir).filter((file) => /from\s+"@onden\/site(?!\/look")/.test(code(readFileSync(file, "utf8"))));
    expect(bad.map((f) => relative(PACKAGES, f).split(sep).join("/"))).toEqual([]);
  });
});
