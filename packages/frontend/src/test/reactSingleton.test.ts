// Regression guard for the monorepo dual-React hazard.
//
// The workspace once hoisted React 18.3.1 to the repo root (pulled transitively
// via @xyflow/react -> zustand -> use-sync-external-store peer resolution) while
// packages/frontend pinned ^19. Under vitest the cjs shim require()d the wrong
// React, producing a null dispatcher ("Cannot read properties of null (reading
// 'useRef')") which forced a vi.mock('@xyflow/react') stub in component tests and
// risked runtime dispatcher collisions in the real app.
//
// The fix is a root package.json `overrides` block pinning react / react-dom /
// use-sync-external-store to a single version. This test fails loudly if a second
// React major ever sneaks back into the installed tree, so the override is never
// silently dropped.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function findWorkspaceRoot(start: string): string {
  let dir = start;
  // Walk up until we find the package.json that declares the npm workspaces.
  for (let i = 0; i < 12; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (Array.isArray(pkg.workspaces)) return dir;
      } catch {
        /* ignore unparsable package.json on the way up */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

// Collect the version of every installed copy of `react` across all node_modules
// folders under the workspace, without walking the whole tree exhaustively.
function collectReactVersions(root: string): Map<string, string[]> {
  const versions = new Map<string, string[]>();

  function inspectNodeModules(nmDir: string): void {
    if (!existsSync(nmDir)) return;
    let entries: string[];
    try {
      entries = readdirSync(nmDir);
    } catch {
      return;
    }
    for (const name of entries) {
      const pkgDir = join(nmDir, name);
      if (name === "react") {
        const pj = join(pkgDir, "package.json");
        if (existsSync(pj)) {
          try {
            const v = JSON.parse(readFileSync(pj, "utf8")).version as string;
            const list = versions.get(v) ?? [];
            list.push(pkgDir);
            versions.set(v, list);
          } catch {
            /* skip */
          }
        }
      }
      // Recurse into nested node_modules (e.g. packages/frontend/node_modules,
      // or a package that nests its own react copy).
      try {
        if (statSync(pkgDir).isDirectory()) {
          inspectNodeModules(join(pkgDir, "node_modules"));
        }
      } catch {
        /* skip broken symlinks */
      }
    }
  }

  inspectNodeModules(join(root, "node_modules"));
  return versions;
}

describe("react singleton across the workspace", () => {
  const root = findWorkspaceRoot(resolve(__dirname, ".."));
  const versions = collectReactVersions(root);

  it("installs exactly one React major version (no dual-React)", () => {
    // Skip cleanly when dependencies are not installed (e.g. a bare worktree
    // checked out without node_modules) — there is nothing to guard yet.
    if (versions.size === 0) {
      expect(versions.size).toBe(0);
      return;
    }
    const majors = new Set(
      [...versions.keys()].map((v) => v.split(".")[0]),
    );
    expect(
      majors.size,
      `Expected a single React major across the workspace but found: ${JSON.stringify(
        Object.fromEntries(versions),
        null,
        2,
      )}`,
    ).toBe(1);
  });
});
