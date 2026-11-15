// @vitest-environment node
// Guard: the AGENTS.md files stay true. (1) The block between <!-- generated:owners --> markers is what
// scripts/agentsTablesLib.mjs computes from allowlist/owners.ts, so the owners are never copied by hand.
// (2) Every file or guard test named in a hand-written table exists, so a rename cannot leave a stale row.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { END, expectedFiles, root, START, TARGETS, withBlock } from "../../../../../scripts/agentsTablesLib.mjs";

const PACKAGES = ["frontend", "backend", "markdown", "site"].map((name) => join(root, "packages", name));

function agentsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    if (statSync(path).isDirectory()) return agentsFiles(path);
    return name === "AGENTS.md" ? [path] : [];
  });
}
const all = PACKAGES.flatMap(agentsFiles);

describe("the generated owner tables match allowlist/owners.ts", () => {
  for (const { file, current, expected } of expectedFiles()) {
    it(file, () => {
      expect(expected, `${file} needs ${START} … ${END}`).not.toBeNull();
      expect(current, `${file} is out of date: run npm run agents:tables`).toBe(expected);
    });
  }
  it("replaces only what is between the markers", () => {
    const text = `intro\n${START}\nold\n${END}\noutro\n`;
    expect(withBlock(text, "new")).toBe(`intro\n${START}\nnew\n${END}\noutro\n`);
    expect(withBlock("no markers", "new")).toBeNull();
  });
  it("only the packages that have an owners.ts carry a generated block", () => {
    const withMarkers = all.filter((file) => readFileSync(file, "utf8").includes(START)).map((file) => relative(root, file)).sort();
    expect(withMarkers).toEqual(Object.keys(TARGETS).sort());
  });
});

describe("every file a hand-written row names exists", () => {
  // A token that looks like a source path or a guard test; function names and prose are ignored.
  const PATH = /^[\w@./-]+\.(?:ts|tsx|mjs|css|md)$/;
  const searchDirs = (agents: string) => [
    dirname(agents), root,
    ...PACKAGES.flatMap((pkg) => [pkg, join(pkg, "src"), join(pkg, "src/test/guards")]),
  ];
  for (const file of all) {
    it(relative(root, file), () => {
      const handWritten = readFileSync(file, "utf8").split(START)[0]!.concat(readFileSync(file, "utf8").split(END)[1] ?? "");
      const tokens = [...handWritten.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]!).filter((token) => PATH.test(token));
      const missing = tokens.filter((token) => !searchDirs(file).some((dir) => existsSync(join(dir, token))));
      expect(missing, "named in a table but not found: fix the row").toEqual([]);
    });
  }
});
