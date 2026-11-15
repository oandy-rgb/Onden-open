// Module tag lookup (depth audit D15): which tag provides a module, and which
// tag is a module's tag, are answered by services/tagModules.ts and
// services/workspaceModules.ts. Modules ask them (moduleTagExists,
// findModuleTag, ensureModuleTag) instead of querying tag_schema themselves.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const modulesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "modules");
const MODULE_TAG_SQL = /tag_schema\s*(->>?\s*'module'|#>>?\s*'\{behaviour,modules)|'behaviour'\s*->\s*'modules'/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []);
}

describe("modules don't look up module tags themselves", () => {
  it("no module file reads tag_schema.module or the per-tag module switch", () => {
    const offenders = files(modulesDir)
      .filter((path) => MODULE_TAG_SQL.test(readFileSync(path, "utf8")))
      .map((path) => relative(modulesDir, path).split(sep).join("/"));
    expect(offenders).toEqual([]);
  });

  it("the pattern catches the old inline checks", () => {
    expect(MODULE_TAG_SQL.test("AND (tag_schema->>'module' = 'review' OR tag_schema#>'{behaviour,modules,review,enabled}' = 'true'::jsonb)")).toBe(true);
  });
});
