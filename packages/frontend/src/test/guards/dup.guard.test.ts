// Guard: new code must not add copy-pasted code or a second definition of an
// exported name. GitHub Actions is off, so `npm run check` alone blocks nobody;
// this runs inside the full vitest run everyone does. The logic is
// scripts/dupLib.mjs, the same one `npm run dup:check` / `dup:names` use.
//   dup:check  jscpd verbatim clones, only allowed to shrink (scripts/dup-baseline.json)
//   dup:names  the same exported function/const name defined in two files
//              (scripts/dup-names-baseline.json), which jscpd cannot see.
// Lower a baseline after a cleanup: npm run dup:baseline / dup:names:baseline.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareNearDuplicates, findNearPairs, functionsInSource, scanNearDuplicates } from "../../../../../scripts/dupNearLib.mjs";
import { compareDuplicateNames, compareDuplicates, exportedTypeNames, exportedValueNames, scanDuplicateNames, scanDuplicates } from "../../../../../scripts/dupLib.mjs";

const report = (r: { errors: string[] }) => r.errors.join("\n");

describe("no new duplicated code", () => {
  // jscpd scans all four packages (~1 s warm, a few seconds cold).
  it("verbatim clones do not exceed scripts/dup-baseline.json", () => {
    const result = compareDuplicates(scanDuplicates());
    expect(result.ok, report(result)).toBe(true);
  }, 120_000);

  it("no exported function/const name is newly defined in a second file, and no type on both the frontend and the backend (scripts/dup-names-baseline.json)", () => {
    const result = compareDuplicateNames(scanDuplicateNames());
    expect(result.ok, report(result)).toBe(true);
  }, 60_000);

  it("a type defined on both sides fails; a type both sides import from the contract does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "dup-types-"));
    try {
      const put = (file: string, text: string) => { mkdirSync(join(dir, file, ".."), { recursive: true }); writeFileSync(join(dir, file), text); };
      put("packages/backend/src/services/a.ts", "import type { ZzShared } from '@onden/contract';\nexport type ZzTempShape = { id: string };\nexport type UseIt = ZzShared;\n");
      put("packages/frontend/src/lib/a.ts", "export type ZzTempShape = { id: string };\nimport type { ZzShared } from '@onden/contract';\nexport type { ZzShared };\n");
      put("packages/contract/src/shared.ts", "export type ZzShared = { n: number };\n");
      const found = scanDuplicateNames(dir);
      expect(Object.keys(found.types)).toEqual(["ZzTempShape"]);
      const result = compareDuplicateNames(found);
      expect(result.ok).toBe(false);
      expect(report(result)).toContain("ZzTempShape");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a same-named type pair checked as two different models (typesAllow) passes only as that exact pair, and must be removed once it stops being a pair", () => {
    const dir = mkdtempSync(join(tmpdir(), "dup-types-allow-"));
    try {
      const put = (file: string, text: string) => { mkdirSync(join(dir, file, ".."), { recursive: true }); writeFileSync(join(dir, file), text); };
      const toolSpec = "export type ToolSpec = { x: number };\n";
      put("packages/backend/src/services/agentRuntime/api/protocols/types.ts", toolSpec);
      put("packages/frontend/src/components/ToolbarRow.tsx", toolSpec);
      expect(Object.keys(scanDuplicateNames(dir).types)).toEqual([]);
      // A third definition is a new copy, not the pair that was checked.
      put("packages/frontend/src/lib/third.ts", toolSpec);
      expect(Object.keys(scanDuplicateNames(dir).types)).toEqual(["ToolSpec"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    // Nothing on either side defines the allowlisted names any more: every typesAllow entry is stale.
    const gone = compareDuplicateNames({ names: {}, types: {}, typesAllowedSeen: [] });
    expect(gone.ok).toBe(false);
    expect(report(gone)).toContain("typesAllow");
  });

  it("the type scanner sees own type/interface exports only", () => {
    const names = exportedTypeNames([
      "export type A = 1;", "export interface B {}", "type hidden = 1;", "export { type C } from './c';",
      "import type { D } from './d';", "export type { D };", "export const e = 1;",
    ].join("\n"));
    expect([...names].sort()).toEqual(["A", "B"]);
  });

  it("the name scanner sees value exports only", () => {
    const names = exportedValueNames([
      "export function a() {}", "export const b = 1, c = 2;", "export class D {}", "export enum E { X }",
      "export type T = 1;", "export interface I {}", "export default function z() {}",
      "export { q } from './q';", "function hidden() {}", "const local = 1;",
    ].join("\n"));
    expect([...names].sort()).toEqual(["D", "E", "a", "b", "c"]);
  });

  it("no function is newly rewritten as a near-copy of another (scripts/dup-near-baseline.json)", () => {
    const result = compareNearDuplicates(scanNearDuplicates());
    expect(result.ok, report(result)).toBe(true);
  }, 120_000);
});

// Self-check of the near-duplicate detector: renaming and comments must not hide a copy.
describe("near-duplicate detector", () => {
  const original = `
    export function summarize(rows: Row[], limit: number) {
      // keep the newest first
      const sorted = [...rows].sort((a, b) => b.at - a.at);
      const out: string[] = [];
      for (const row of sorted) {
        if (out.length >= limit) break;
        if (row.title.trim() === "") continue;
        out.push(row.title.trim() + " (" + row.at + ")");
      }
      return out.join("\n");
    }`;
  const renamed = `
    function digest(items: Row[], cap: number) {
      /* newest items go first */
      const ordered = [...items].sort((x, y) => y.at - x.at);
      const lines: string[] = [];
      for (const item of ordered) {
        if (lines.length >= cap) break; // stop at the cap
        if (item.title.trim() === "") continue;
        lines.push(item.title.trim() + " (" + item.at + ")");
      }
      return lines.join("\n");
    }`;
  const different = `
    export async function load(id: string, db: Db) {
      const row = await db.get(id);
      if (!row) throw new Error("missing");
      let total = 0;
      while (total < row.size) {
        total += await db.chunk(id, total, 64);
        await new Promise((r) => setTimeout(r, 10));
      }
      return { id, total, ok: total === row.size };
    }`;
  const pairs = (...sources: string[]) =>
    findNearPairs(sources.flatMap((text, i) => functionsInSource(text, `f${i}.ts`).map((f) => ({ ...f, file: `f${i}.ts` }))));

  it("catches a copy that only differs in identifier names and comments", () => {
    expect(pairs(original, renamed)).toHaveLength(1);
  });

  it("does not pair functions with different structure", () => {
    expect(pairs(original, different)).toHaveLength(0);
    expect(pairs(renamed, different)).toHaveLength(0);
  });
});
