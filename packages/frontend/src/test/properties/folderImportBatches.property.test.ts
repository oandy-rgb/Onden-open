// A folder import sent in batches (modules/importers/folderImport.ts planImportBatches). The server finds a folder's
// own note (`課程.md` beside `課程/`) and a task list's task notes only among the files of ONE request, so batches
// must not split such a family. Scan 14 #4. Replay: PROPS_SEED=<seed> PROPS_RUNS=<n>.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isHiddenImportPath, planImportBatches, type FolderImportFile } from "../../modules/importers/folderImport";
import { PROPS_SEED } from "../helpers/propsConfig";

const seed = PROPS_SEED;
const numRuns = Number(process.env.PROPS_RUNS ?? 150);

const seg = fc.constantFrom("課程", "演算法", "Notes", "任務", "a", "B", "b");
const path = fc.tuple(fc.array(seg, { minLength: 1, maxLength: 3 }), fc.constantFrom("a", "b", "課程", "演算法", "Notes", "任務", "x")).map(([dirs, name]) => `${dirs.join("/")}/${name}.md`);
const topFile = fc.constantFrom("課程", "演算法", "Notes", "任務", "a").map(name => `${name}.md`);
const vault = fc.uniqueArray(fc.oneof(path, topFile), { minLength: 2, maxLength: 14, selector: p => p.toLowerCase() });

const note = (p: string, size: number): FolderImportFile => ({ path: p, content: "x".repeat(size) });

/** Files that must share a request: `X.md` with anything under `X/`; `X/X.md` with anything under `X/`. */
function mustShare(files: string[]): Array<[string, string]> {
  const lower = new Set(files.map(f => f.toLowerCase()));
  const pairs: Array<[string, string]> = [];
  for (const owner of files) {
    const stem = owner.toLowerCase().slice(0, -3);
    const parts = stem.split("/");
    const folders = [stem, ...(parts.length > 1 && parts[parts.length - 1] === parts[parts.length - 2] ? [parts.slice(0, -1).join("/")] : [])];
    for (const folder of folders) for (const other of files) if (other !== owner && other.toLowerCase().startsWith(`${folder}/`) && lower.has(other.toLowerCase())) pairs.push([owner, other]);
  }
  return pairs;
}

describe("planImportBatches keeps a note with its folder", () => {
  it("any two files that belong together are in one batch while the family fits a request", () => {
    fc.assert(fc.property(vault, fc.array(fc.integer({ min: 1, max: 60 }), { minLength: 14, maxLength: 14 }), (paths, sizes) => {
      const files = paths.map((p, i) => note(p, sizes[i]!));
      // Tiny target, large request cap: every family fits a request, so none may be cut.
      const { batches, tooLarge } = planImportBatches(files, 120, 1_000_000);
      expect(tooLarge).toEqual([]);
      const batchOf = new Map(batches.flatMap((batch, at) => batch.map(file => [file.path, at] as const)));
      expect([...batchOf.keys()].sort()).toEqual(paths.slice().sort()); // nothing lost, nothing twice
      expect(batches.flat().length).toBe(paths.length);
      for (const [a, b] of mustShare(paths)) expect(batchOf.get(a), `${a} with ${b}`).toBe(batchOf.get(b));
    }), { seed, numRuns });
  });

  it("a course note and its sub-notes stay together when the folder is bigger than a batch (fixed case)", () => {
    const files = [note("課程.md", 100), note("課程/a.md", 100), note("課程/b.md", 100), note("其他.md", 100)];
    const { batches } = planImportBatches(files, 150, 1_000_000);
    expect(batches.find(batch => batch.some(f => f.path === "課程.md"))!.map(f => f.path).sort()).toEqual(["課程.md", "課程/a.md", "課程/b.md"]);
  });

  it("a task list and its task notes stay together (fixed case)", () => {
    const files = [note("任務/任務.md", 100), note("任務/買牛奶.md", 100), note("任務/寄信.md", 100)];
    const { batches } = planImportBatches(files, 150, 1_000_000);
    expect(batches).toHaveLength(1);
  });

  it("a family too big for one request is split rather than dropped", () => {
    const files = [note("課程.md", 100), note("課程/a.md", 100), note("課程/b.md", 100)];
    const { batches, tooLarge } = planImportBatches(files, 150, 450);
    expect(tooLarge).toEqual([]);
    expect(batches.flat()).toHaveLength(3);
  });
});

// Scan 14 #15. The chosen folder's own name is not a hidden part of any file's path.

describe("isHiddenImportPath", () => {
  const plain = fc.stringMatching(/^[A-Za-z0-9 _一-鿿-][A-Za-z0-9 _.一-鿿-]{0,8}$/);
  const root = fc.oneof(plain, plain.map(name => `.${name}`));

  it("depends only on the parts under the chosen folder", () => {
    fc.assert(fc.property(root, fc.array(plain, { minLength: 1, maxLength: 4 }), fc.nat(3), fc.boolean(), (folder, inner, at, hide) => {
      const parts = inner.slice();
      if (hide) parts[at % parts.length] = `.${parts[at % parts.length]}`;
      expect(isHiddenImportPath([folder, ...parts].join("/"))).toBe(hide);
    }), { seed, numRuns });
  });

  it("a note in a folder named .notes is not hidden (fixed case)", () => {
    expect(isHiddenImportPath(".notes/課程/a.md")).toBe(false);
    expect(isHiddenImportPath(".notes/.obsidian/app.json")).toBe(true);
    expect(isHiddenImportPath(".hidden.md")).toBe(true);
  });
});
