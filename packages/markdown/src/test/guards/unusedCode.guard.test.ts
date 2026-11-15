// Guard: no production file without an importer, and no export used nowhere outside its own file and tests
// (scripts/unusedCodeLib.mjs; `npm run unused:check` and scripts/guard-lane.sh run the same check).
// New dead code: delete it. A deliberate exception goes in scripts/unused-code-baseline.json `intentional` with a reason;
// `leftover` is the not-yet-cleaned state and may only shrink (ratchet:check).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compareUnused, declaredExports, moduleSpecifiers, readBaseline, scanUnused } from "../../../../../scripts/unusedCodeLib.mjs";

describe("unused code", () => {
  it("the repository has no dead file or export beyond scripts/unused-code-baseline.json", () => {
    const result = compareUnused(scanUnused(), readBaseline());
    expect(result.ok, result.errors.join("\n")).toBe(true);
  }, 60_000);
});

describe("the unused-code detector", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const repo = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "unused-"));
    dirs.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };

  it("lists a file nobody imports and an export nobody uses; tests do not count as users", () => {
    const root = repo({
      "packages/backend/src/main.ts": 'import { used } from "./used.js"; import("./lazy.js"); used();',
      "packages/backend/src/used.ts": "export const used = () => 1; export const unusedHere = 2; export const onlyTested = 3;",
      "packages/backend/src/lazy.ts": "export const lazyName = 1;",
      "packages/backend/src/orphan.ts": "export const orphan = 1;",
      "packages/backend/src/test/used.test.ts": 'import { onlyTested } from "../used.js"; import { orphan } from "../orphan.js"; void onlyTested; void orphan;',
      "packages/frontend/src/main.tsx": "export {};",
    });
    const found = scanUnused(root);
    expect(Object.keys(found.files)).toEqual(["packages/backend/src/orphan.ts"]);
    expect(Object.keys(found.exports).sort()).toEqual([
      "packages/backend/src/lazy.ts#lazyName", // exported but nobody reads the name (only the import() makes the file used)
      "packages/backend/src/used.ts#onlyTested",
      "packages/backend/src/used.ts#unusedHere",
    ]);
  });

  it("a workspace package import, a package.json path and a glob count as importers", () => {
    const root = repo({
      "packages/markdown/package.json": JSON.stringify({ name: "@onden/markdown", exports: { ".": { types: "./src/index.ts", default: "./dist/index.js" } } }),
      "packages/markdown/src/index.ts": "export const fromIndex = 1;",
      "packages/backend/src/a.ts": 'import { fromIndex } from "@onden/markdown"; void fromIndex;',
      "packages/backend/package.json": JSON.stringify({ scripts: { cli: "tsx src/tool.ts" } }),
      "packages/backend/src/tool.ts": "export {};",
      "packages/frontend/src/registry.ts": 'const all = import.meta.glob("./modules/*.ts"); void all;',
      "packages/frontend/src/modules/one.ts": "export {};",
      "packages/frontend/src/main.tsx": 'import "./registry";',
    });
    expect(scanUnused(root).files).toEqual({ "packages/backend/src/a.ts": expect.any(String) });
  });

  it("build output does not make dead code look used; a folder that merely starts with dist is source", () => {
    const root = repo({
      "packages/frontend/src/main.tsx": 'import "./lib/dead";',
      "packages/backend/src/main.ts": 'import "./distributedSync/a";',
      "packages/frontend/src/lib/dead.ts": "export const deadName = 1;",
      "packages/frontend/dist-browser/assets/app.js": "console.log(deadName)",
      "packages/backend/src/distributedSync/a.ts": "export const syncName = 1;",
    });
    expect(Object.keys(scanUnused(root).exports).sort()).toEqual([
      "packages/backend/src/distributedSync/a.ts#syncName",
      "packages/frontend/src/lib/dead.ts#deadName",
    ].sort());
  });

  it("reads import forms and export forms", () => {
    expect(moduleSpecifiers('import a from "./a"; export { b } from "./b"; await import("./c"); require("./d"); new URL("./e.bin", import.meta.url);').map((s) => s.spec))
      .toEqual(["./a", "./b", "./c", "./d", "./e.bin"]);
    expect(declaredExports("export const a = 1; export function b() {} export type C = 1; const d = 1; export { d as e }; export default 1; export { f } from './f';", "x.ts"))
      .toEqual(["a", "b", "C", "e"]);
  });

  it("fails on new dead code and on baseline entries that are no longer dead", () => {
    const current = { files: { "packages/a/src/x.ts": "r" }, exports: { "packages/a/src/y.ts#z": "r" } };
    const empty = { intentional: { files: {}, exports: {} }, leftover: { files: {}, exports: {} } };
    expect(compareUnused(current, empty).errors).toHaveLength(2);
    const listed = { intentional: { files: { "packages/a/src/x.ts": "entry run by a script" }, exports: { "packages/a/src/": "kept package" } }, leftover: { files: {}, exports: {} } };
    expect(compareUnused(current, listed).ok).toBe(true);
    const stale = { intentional: { files: {}, exports: {} }, leftover: { files: { "packages/a/src/gone.ts": "r" }, exports: {} } };
    expect(compareUnused({ files: {}, exports: {} }, stale).errors[0]).toMatch(/已不是死碼/);
    expect(compareUnused(current, { ...listed, intentional: { ...listed.intentional, files: { "packages/a/src/x.ts": "" } } }).errors[0]).toMatch(/理由/);
  });
});
